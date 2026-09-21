import type { D1Database } from "@cloudflare/workers-types"
import { ShareIdSchema } from "../../../../../packages/shared/src/index"
import { SnapshotRepositoryError } from "./errors"
import { toIso } from "./hashing"

// Operator takedown (task 14): deployment-credential-only resource removal
// driven by the audited CLI in apps/web/scripts — NEVER a public endpoint,
// never an account surface, never a fake publisher identity.
//
// The semantics deliberately mirror the owner hard-delete in
// snapshots/delete.ts (same dependent purges, same parent delete), minus the
// capability predicates: the operator holds no manage secret, so authority
// comes from the deployment credential the CLI was invoked with, and a row in
// operator_takedowns is the durable audit record.
//
// Statement order is the fail-safe contract: `blocked = 1` first (the row is
// immediately invisible to every read/list path even if a later statement
// fails), then dependent purges, then the parent row, then the audit insert.
// Under db.batch the purge block is atomic; the CLI executes the same list
// sequentially over the D1 REST API, where the ordering is what guarantees a
// partial run can never leave the resource visible.

export type TakedownInput = {
  readonly shareId: string
  /** Operator-generated correlation id (UUID) for the audit row. */
  readonly operationKey: string
  /** Operator identifier — a ticket/alias, never a credential or secret. */
  readonly actor: string
  /** Bounded free-text justification recorded in the audit row. */
  readonly reason: string
  readonly now: Date
}

/** Portable statement descriptor: sql + positional binds for ?1..?n. */
export type TakedownStatement = {
  readonly sql: string
  readonly params: readonly (string | number)[]
}

export const TAKEDOWN_ACTOR_MAX = 120 as const
export const TAKEDOWN_REASON_MAX = 500 as const

function validateInput(input: TakedownInput): void {
  if (!ShareIdSchema.safeParse(input.shareId).success) {
    throw new SnapshotRepositoryError("ASSERTION_FAILED", "takedown shareId fails the id schema")
  }
  if (input.actor.trim().length === 0 || input.actor.length > TAKEDOWN_ACTOR_MAX) {
    throw new SnapshotRepositoryError("ASSERTION_FAILED", "takedown actor is missing or too long")
  }
  if (input.reason.trim().length === 0 || input.reason.length > TAKEDOWN_REASON_MAX) {
    throw new SnapshotRepositoryError("ASSERTION_FAILED", "takedown reason is missing or too long")
  }
  if (input.operationKey.trim().length === 0) {
    throw new SnapshotRepositoryError("ASSERTION_FAILED", "takedown operationKey is missing")
  }
}

/**
 * The ordered purge block (statements 1..6 of the takedown). Executed as one
 * D1 batch in-worker or sequentially by the CLI; safe to re-run — every
 * statement is idempotent.
 */
export function operatorTakedownStatements(input: TakedownInput): readonly TakedownStatement[] {
  validateInput(input)
  const nowIso = toIso(input.now)
  const shareId = input.shareId
  return [
    {
      // Immediate hide: blocked rows are excluded from every public surface.
      sql: "UPDATE playlists SET blocked = 1, updated_at = ?1 WHERE share_id = ?2",
      params: [nowIso, shareId],
    },
    { sql: "DELETE FROM playlist_tags WHERE share_id = ?1", params: [shareId] },
    { sql: "DELETE FROM import_daily WHERE share_id = ?1", params: [shareId] },
    { sql: "DELETE FROM import_receipts WHERE share_id = ?1", params: [shareId] },
    {
      // Ranking snapshots embed ordered share ids inside entries_json.
      sql: `DELETE FROM discovery_snapshots
            WHERE EXISTS (
              SELECT 1 FROM json_each(discovery_snapshots.entries_json) e
              WHERE json_extract(e.value, '$[0]') = ?1)`,
      params: [shareId],
    },
    // Owner-side mutation receipts belong to the removed resource; the audit
    // trail for this action lives in operator_takedowns, not here.
    { sql: "DELETE FROM publication_operations WHERE share_id = ?1", params: [shareId] },
    { sql: "DELETE FROM playlists WHERE share_id = ?1", params: [shareId] },
  ]
}

/** Audit insert — runs AFTER the purge block so `removed` is truthful. */
export function operatorTakedownAuditStatement(
  input: TakedownInput,
  removed: boolean,
): TakedownStatement {
  validateInput(input)
  return {
    sql: `INSERT INTO operator_takedowns
          (operation_key, share_id, actor, reason, removed, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT (operation_key) DO NOTHING`,
    params: [
      input.operationKey,
      input.shareId,
      input.actor,
      input.reason,
      removed ? 1 : 0,
      toIso(input.now),
    ],
  }
}

export type TakedownOutcome = {
  readonly shareId: string
  readonly operationKey: string
  /** true when a playlists row actually existed and was deleted. */
  readonly removed: boolean
  /** true when the durable audit row was recorded. */
  readonly auditRecorded: boolean
  readonly at: string
}

/**
 * In-worker path: purge block as one atomic batch, then the audit insert.
 * `removed` derives from the parent DELETE's rows_written (Miniflare may
 * report a higher number than production D1, so only the zero/nonzero split
 * is meaningful). An audit-insert failure is reported via auditRecorded
 * rather than thrown — the takedown itself already committed.
 */
export async function operatorTakedown(
  db: D1Database,
  input: TakedownInput,
): Promise<TakedownOutcome> {
  const statements = operatorTakedownStatements(input)
  const results = await db.batch(
    statements.map((statement) => db.prepare(statement.sql).bind(...statement.params)),
  )
  const parentDelete = results[statements.length - 1]
  const removed = (parentDelete?.meta.rows_written ?? 0) > 0
  let auditRecorded = false
  try {
    const audit = operatorTakedownAuditStatement(input, removed)
    await db
      .prepare(audit.sql)
      .bind(...audit.params)
      .run()
    // Presence check, not rows_written: an idempotent re-run with the same
    // operation key is still "audit durable" even though the INSERT ignored.
    const row = await db
      .prepare("SELECT operation_key FROM operator_takedowns WHERE operation_key = ?1")
      .bind(input.operationKey)
      .first()
    auditRecorded = row !== null
  } catch {
    auditRecorded = false
  }
  return {
    shareId: input.shareId,
    operationKey: input.operationKey,
    removed,
    auditRecorded,
    at: toIso(input.now),
  }
}
