import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { MUTATION_RECEIPT_TTL_MS } from "../../../../../../packages/shared/src/index"
import type { GuardedMutationPlan } from "../guard"
import { pendingOpGate, runGuardedMutation } from "../guard"
import { hashRequest, plusMs, toIso } from "../hashing"
import type { DeleteOutcome, MutationResult } from "../types"
import { assertParentGone, assertReceiptCompleted, finalizeStatic } from "./internal"
import { parseDeleteOutcome } from "./outcomes"

export type DeleteInput = {
  readonly shareId: string
  readonly secretHash: string
  readonly operationKey: string
  readonly expectedRevision: number
  readonly now: Date
}

/**
 * Conditional hard delete: payload, tag links, import counters/receipts and any
 * cached ranking entries referencing the share are purged inside the same
 * guarded batch; the mutation receipt itself is kept for its 24 h TTL so an
 * authenticated replay still returns the recorded outcome.
 */
export async function deleteSnapshot(
  db: D1Database,
  input: DeleteInput,
): Promise<MutationResult<DeleteOutcome>> {
  const nowIso = toIso(input.now)
  const requestHash = await hashRequest({
    operation: "delete",
    shareId: input.shareId,
    expectedRevision: input.expectedRevision,
  })
  const plan: GuardedMutationPlan = {
    operationKey: input.operationKey,
    shareId: input.shareId,
    method: "delete",
    requestHash,
    secretHash: input.secretHash,
    expectedRevision: input.expectedRevision,
    // Delete does not bump the revision; new_revision records the revision that
    // was deleted so dependent gates stay exact.
    newRevision: input.expectedRevision,
    requiredState: "any",
    checkActivationExpiry: false,
    now: nowIso,
  }
  const receiptExpiresAt = plusMs(input.now, MUTATION_RECEIPT_TTL_MS)
  const outcome: DeleteOutcome = {
    shareId: input.shareId,
    deletedRevision: input.expectedRevision,
    deletedAt: nowIso,
  }
  return runGuardedMutation(
    db,
    plan,
    (nonce) => buildStatements(db, plan, nonce, nowIso, receiptExpiresAt, outcome),
    parseDeleteOutcome,
  )
}

function buildStatements(
  db: D1Database,
  plan: GuardedMutationPlan,
  nonce: string,
  nowIso: string,
  receiptExpiresAt: string,
  outcome: DeleteOutcome,
): readonly D1PreparedStatement[] {
  // Dependent deletes run while the parent still sits at the expected revision;
  // the parent delete and the parent-gone assert finish the batch.
  const parentStillThere =
    "EXISTS (SELECT 1 FROM playlists p WHERE p.share_id = ?8 AND p.revision = ?9)"
  const dependentBinds = [
    plan.operationKey,
    nonce,
    plan.shareId,
    plan.requestHash,
    plan.expectedRevision,
    plan.newRevision,
    plan.shareId,
    plan.expectedRevision,
  ] as const
  return [
    // 1. Guard: pending receipt only for a matching share + secret + revision.
    db
      .prepare(
        `INSERT INTO publication_operations
         (operation_key, share_id, method, request_hash, secret_hash, attempt_nonce,
          status, expected_revision, new_revision, outcome_json, created_at, expires_at)
       SELECT ?1, ?2, 'delete', ?3, ?4, ?5, 'pending', ?6, ?7, NULL, ?8, ?9
       WHERE EXISTS (
         SELECT 1 FROM playlists
         WHERE share_id = ?2 AND secret_hash = ?4 AND revision = ?6)
         AND NOT EXISTS (SELECT 1 FROM publication_operations WHERE operation_key = ?1)`,
      )
      .bind(
        plan.operationKey,
        plan.shareId,
        plan.requestHash,
        plan.secretHash,
        nonce,
        plan.expectedRevision,
        plan.newRevision,
        nowIso,
        receiptExpiresAt,
      ),
    // 2-5. Dependent purges, each gated on the pending receipt AND the parent
    //      row still holding its expected revision.
    db
      .prepare(
        `DELETE FROM playlist_tags
       WHERE share_id = ?1 AND ${pendingOpGate(2)} AND ${parentStillThere}`,
      )
      .bind(plan.shareId, ...dependentBinds),
    db
      .prepare(
        `DELETE FROM import_daily
       WHERE share_id = ?1 AND ${pendingOpGate(2)} AND ${parentStillThere}`,
      )
      .bind(plan.shareId, ...dependentBinds),
    db
      .prepare(
        `DELETE FROM import_receipts
       WHERE share_id = ?1 AND ${pendingOpGate(2)} AND ${parentStillThere}`,
      )
      .bind(plan.shareId, ...dependentBinds),
    db
      .prepare(
        `DELETE FROM discovery_snapshots
       WHERE EXISTS (
         SELECT 1 FROM json_each(discovery_snapshots.entries_json) e
         WHERE json_extract(e.value, '$[0]') = ?1)
         AND ${pendingOpGate(2)} AND ${parentStillThere}`,
      )
      .bind(plan.shareId, ...dependentBinds),
    // 6. Parent hard delete.
    db
      .prepare(
        `DELETE FROM playlists
       WHERE share_id = ?1 AND secret_hash = ?2 AND revision = ?3
         AND ${pendingOpGate(4)}`,
      )
      .bind(
        plan.shareId,
        plan.secretHash,
        plan.expectedRevision,
        plan.operationKey,
        nonce,
        plan.shareId,
        plan.requestHash,
        plan.expectedRevision,
        plan.newRevision,
      ),
    // 7. Assert the parent row is really gone.
    assertParentGone(db, "delete-parent", plan, nonce),
    // 8. Finalize the receipt with the recorded delete acknowledgement.
    finalizeStatic(db, plan, nonce, JSON.stringify(outcome)),
    // 9. Assert our receipt actually completed.
    assertReceiptCompleted(db, "delete-receipt", plan, nonce),
  ]
}
