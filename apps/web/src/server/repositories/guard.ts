import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { SnapshotRepositoryError } from "./errors"
import { newAttemptNonce } from "./hashing"
import { type GuardRow, type OperationRow, toGuardRow, toOperationRow } from "./rows"
import type { ConflictCode, MutationMethod, MutationResult } from "./types"

// Guarded-operation transaction machinery (task 12).
//
// Every snapshot mutation is a single D1 batch (one atomic transaction):
//   1. INSERT a 'pending' publication_operations row that only yields a row when
//      the resource predicates hold (share_id + secret_hash + expected revision +
//      lifecycle state) AND no receipt already exists for the operation key.
//   2. Dependent snapshot/tag/counter writes, each gated by pendingOpGate() on
//      that pending row (operation_key + this attempt's nonce + exact request
//      hash + expected/new revision). A pre-existing receipt therefore cannot
//      authorize a replay's writes, and a failed guard leaves zero rows.
//   3. A write_asserts INSERT that aborts (RAISE trigger) the whole batch if the
//      guard row exists but the parent row did not reach its target state, so a
//      zero-row parent write can never let dependent writes commit.
//   4. Finalize: mark the same receipt 'completed' with the outcome payload.
//
// After the batch, the receipt row is read back: completed + our nonce means the
// mutation applied; any other receipt replays/conflicts without writing. D1
// batches are atomic transactions, so a durable 'pending' receipt indicates
// corruption and is reported, never silently trusted.

export const GUARD_MAX_ATTEMPTS = 3

/** State the parent row must be in for the guard insert to yield a row. */
export type RequiredState = "pending" | "active" | "any" | "absent"

export type GuardedMutationPlan = {
  readonly operationKey: string
  readonly shareId: string
  readonly method: MutationMethod
  readonly requestHash: string
  readonly secretHash: string
  readonly expectedRevision: number | null
  readonly newRevision: number | null
  readonly requiredState: RequiredState
  /** When true, an expired pending row classifies as ACTIVATION_EXPIRED. */
  readonly checkActivationExpiry: boolean
  readonly now: string
}

/**
 * EXISTS clause matching this attempt's own pending receipt. Bind order:
 * operationKey, attemptNonce, shareId, requestHash, expectedRevision, newRevision
 * (six binds starting at ?startIndex). `IS ?` accepts NULL for create's
 * expected_revision.
 */
export function pendingOpGate(startIndex: number): string {
  const p = (offset: number) => `?${startIndex + offset}`
  return `EXISTS (
    SELECT 1 FROM publication_operations po
    WHERE po.operation_key = ${p(0)}
      AND po.attempt_nonce = ${p(1)}
      AND po.status = 'pending'
      AND po.share_id = ${p(2)}
      AND po.request_hash = ${p(3)}
      AND po.expected_revision IS ${p(4)}
      AND po.new_revision IS ${p(5)}
  )`
}

export function pendingOpBinds(
  plan: GuardedMutationPlan,
  nonce: string,
): readonly [string, string, string, string, number | null, number | null] {
  return [
    plan.operationKey,
    nonce,
    plan.shareId,
    plan.requestHash,
    plan.expectedRevision,
    plan.newRevision,
  ]
}

export async function runGuardedMutation<Outcome>(
  db: D1Database,
  plan: GuardedMutationPlan,
  buildStatements: (nonce: string) => readonly D1PreparedStatement[],
  parseOutcome: (json: string | null) => Outcome,
): Promise<MutationResult<Outcome>> {
  let lastBusy: unknown
  for (let attempt = 0; attempt < GUARD_MAX_ATTEMPTS; attempt += 1) {
    const nonce = newAttemptNonce()
    try {
      await db.batch([...buildStatements(nonce)])
    } catch (error) {
      if (isBusyError(error)) {
        lastBusy = error
        continue
      }
      throw toRepositoryError(error)
    }
    return classifyAfterBatch(db, plan, nonce, parseOutcome)
  }
  throw new SnapshotRepositoryError(
    "TRANSIENT_FAILURE",
    "guarded mutation could not obtain the D1 write lock",
    { cause: lastBusy },
  )
}

export async function readOperationRow(
  db: D1Database,
  operationKey: string,
): Promise<OperationRow | null> {
  const row = await db
    .prepare(
      `SELECT operation_key, share_id, method, request_hash, secret_hash, attempt_nonce,
              status, expected_revision, new_revision, outcome_json, created_at, expires_at
       FROM publication_operations WHERE operation_key = ?1`,
    )
    .bind(operationKey)
    .first()
  if (row === null) return null
  return toOperationRow(row)
}

type ClassifyContext = {
  readonly receipt: OperationRow | null
  readonly guardRow: GuardRow | null
}

async function classifyAfterBatch<Outcome>(
  db: D1Database,
  plan: GuardedMutationPlan,
  nonce: string,
  parseOutcome: (json: string | null) => Outcome,
): Promise<MutationResult<Outcome>> {
  const receipt = await readOperationRow(db, plan.operationKey)
  if (receipt?.attempt_nonce === nonce && receipt.status === "completed") {
    return { kind: "applied", outcome: parseOutcome(receipt.outcome_json) }
  }
  const guardRow = await readGuardRow(db, plan.shareId)
  return classify({ receipt, guardRow }, plan, parseOutcome)
}

function classify<Outcome>(
  ctx: ClassifyContext,
  plan: GuardedMutationPlan,
  parseOutcome: (json: string | null) => Outcome,
): MutationResult<Outcome> {
  const conflict = (code: ConflictCode): MutationResult<Outcome> => ({ kind: "conflict", code })
  const receipt = ctx.receipt
  if (receipt !== null) {
    const sameRequest = receipt.method === plan.method && receipt.request_hash === plan.requestHash
    // For 'create' the shareId and secret are server-generated fresh on every
    // attempt, so receipt binding covers method + request hash only; the API
    // maps a create replay to 409 CREATE_RECEIPT_UNAVAILABLE.
    if (plan.method === "create") {
      if (!sameRequest) return conflict("IDEMPOTENCY_CONFLICT")
      if (receipt.status === "completed") {
        return { kind: "replayed", outcome: parseOutcome(receipt.outcome_json) }
      }
      return conflict("RECEIPT_PENDING")
    }
    if (receipt.secret_hash !== plan.secretHash) return conflict("UNAUTHORIZED")
    if (!sameRequest || receipt.share_id !== plan.shareId) {
      return conflict("IDEMPOTENCY_CONFLICT")
    }
    if (receipt.status === "completed") {
      return { kind: "replayed", outcome: parseOutcome(receipt.outcome_json) }
    }
    // A durable pending receipt means a batch committed without its finalize
    // statement; D1 batches are atomic so this indicates corruption.
    return conflict("RECEIPT_PENDING")
  }
  const row = ctx.guardRow
  if (plan.requiredState === "absent") {
    if (row !== null) return conflict("ALREADY_EXISTS")
    throw new SnapshotRepositoryError(
      "TRANSIENT_FAILURE",
      "create guard inserted no row although share_id and operation key were free",
    )
  }
  if (row === null) return conflict("NOT_FOUND")
  if (row.secret_hash !== plan.secretHash) return conflict("UNAUTHORIZED")
  if (plan.requiredState !== "any" && row.state !== plan.requiredState) {
    return conflict("INVALID_STATE")
  }
  if (plan.expectedRevision !== null && row.revision !== plan.expectedRevision) {
    return conflict("REVISION_CONFLICT")
  }
  if (
    plan.checkActivationExpiry &&
    row.activation_expires_at !== null &&
    row.activation_expires_at <= plan.now
  ) {
    return conflict("ACTIVATION_EXPIRED")
  }
  // Every predicate passed yet the guard inserted no row: inconsistent.
  throw new SnapshotRepositoryError(
    "TRANSIENT_FAILURE",
    "guarded mutation predicates held but the pending operation was not inserted",
  )
}

async function readGuardRow(db: D1Database, shareId: string): Promise<ClassifyContext["guardRow"]> {
  const row = await db
    .prepare(
      `SELECT revision, state, secret_hash, activation_expires_at
       FROM playlists WHERE share_id = ?1`,
    )
    .bind(shareId)
    .first()
  if (row === null) return null
  return toGuardRow(row)
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /busy|locked|deadlock|timed?\s*out/i.test(message)
}

function toRepositoryError(error: unknown): SnapshotRepositoryError {
  const message = error instanceof Error ? error.message : String(error)
  const code = /assertion fired/i.test(message) ? "ASSERTION_FAILED" : "TRANSIENT_FAILURE"
  return new SnapshotRepositoryError(code, `guarded D1 batch failed: ${message}`, {
    cause: error,
  })
}
