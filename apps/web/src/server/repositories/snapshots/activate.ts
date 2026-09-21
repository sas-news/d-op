import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { MUTATION_RECEIPT_TTL_MS } from "../../../../../../packages/shared/src/index"
import type { GuardedMutationPlan } from "../guard"
import { pendingOpGate, runGuardedMutation } from "../guard"
import { hashRequest, plusMs, toIso } from "../hashing"
import type { MutationResult, PatchOutcome } from "../types"
import { assertParentAtRevision, assertReceiptCompleted, finalizeFromRow } from "./internal"
import { parsePatchOutcome } from "./outcomes"

export type ActivateInput = {
  readonly shareId: string
  readonly secretHash: string
  readonly operationKey: string
  readonly expectedRevision: number
  readonly now: Date
}

/**
 * Activate a provisional snapshot: pending revision 1 -> active revision 2,
 * setting first_published_at once. The guard additionally requires the pending
 * row to be inside its activation window so expired provisionals can never be
 * activated even before the sweep removes them.
 */
export async function activateSnapshot(
  db: D1Database,
  input: ActivateInput,
): Promise<MutationResult<PatchOutcome>> {
  const nowIso = toIso(input.now)
  const requestHash = await hashRequest({
    operation: "activate",
    shareId: input.shareId,
    expectedRevision: input.expectedRevision,
  })
  const plan: GuardedMutationPlan = {
    operationKey: input.operationKey,
    shareId: input.shareId,
    method: "activate",
    requestHash,
    secretHash: input.secretHash,
    expectedRevision: input.expectedRevision,
    newRevision: input.expectedRevision + 1,
    requiredState: "pending",
    checkActivationExpiry: true,
    now: nowIso,
  }
  const receiptExpiresAt = plusMs(input.now, MUTATION_RECEIPT_TTL_MS)
  return runGuardedMutation(
    db,
    plan,
    (nonce) => buildStatements(db, plan, nonce, nowIso, receiptExpiresAt),
    parsePatchOutcome,
  )
}

function buildStatements(
  db: D1Database,
  plan: GuardedMutationPlan,
  nonce: string,
  nowIso: string,
  receiptExpiresAt: string,
): readonly D1PreparedStatement[] {
  return [
    // 1. Guard: pending receipt only when the row is still inside its
    //    activation window at the expected revision with the same secret hash.
    db
      .prepare(
        `INSERT INTO publication_operations
         (operation_key, share_id, method, request_hash, secret_hash, attempt_nonce,
          status, expected_revision, new_revision, outcome_json, created_at, expires_at)
       SELECT ?1, ?2, 'activate', ?3, ?4, ?5, 'pending', ?6, ?7, NULL, ?8, ?9
       WHERE EXISTS (
         SELECT 1 FROM playlists
         WHERE share_id = ?2 AND secret_hash = ?4 AND revision = ?6 AND state = 'pending'
           AND activation_expires_at IS NOT NULL AND activation_expires_at > ?8)
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
    // 2. Parent transition, gated on this attempt's pending receipt.
    db
      .prepare(
        `UPDATE playlists
       SET state = 'active', revision = ?1, first_published_at = ?2, updated_at = ?2,
           activation_expires_at = NULL
       WHERE share_id = ?3 AND secret_hash = ?4 AND revision = ?5 AND state = 'pending'
         AND ${pendingOpGate(6)}`,
      )
      .bind(
        plan.newRevision,
        nowIso,
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
    // 3. Assert the parent row reached revision 2 while guarded.
    assertParentAtRevision(db, "activate-parent", plan, nonce),
    // 4. Finalize with the acknowledged post-transition row values.
    finalizeFromRow(db, plan, nonce),
    // 5. Assert our receipt actually completed.
    assertReceiptCompleted(db, "activate-receipt", plan, nonce),
  ]
}
