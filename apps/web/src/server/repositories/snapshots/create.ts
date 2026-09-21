import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import {
  ACTIVATION_EXPIRES_AFTER_MS,
  canonicalString,
  MUTATION_RECEIPT_TTL_MS,
  SharedPlaylistSchema,
} from "../../../../../../packages/shared/src/index"
import type { GuardedMutationPlan } from "../guard"
import { pendingOpGate, runGuardedMutation } from "../guard"
import { hashRequest, plusMs, toIso } from "../hashing"
import type { CreateOutcome, MutationResult } from "../types"
import {
  assertParentAtRevision,
  assertReceiptCompleted,
  finalizeStatic,
  snapshotFields,
  tagRefreshStatements,
} from "./internal"
import { parseCreateOutcome } from "./outcomes"

export type CreateInput = {
  readonly shareId: string
  readonly secretHash: string
  readonly operationKey: string
  readonly playlist: unknown
  readonly contentHash: string
  readonly now: Date
}

/**
 * Provisional create: a non-readable 'pending' snapshot at revision 1 plus its
 * receipt, atomically. The request descriptor deliberately excludes the
 * server-generated shareId so any same-key+same-body retry replays the receipt
 * (the API maps create replays to 409 CREATE_RECEIPT_UNAVAILABLE).
 */
export async function createPendingSnapshot(
  db: D1Database,
  input: CreateInput,
): Promise<MutationResult<CreateOutcome>> {
  const playlist = SharedPlaylistSchema.parse(input.playlist)
  const fields = snapshotFields(playlist)
  const nowIso = toIso(input.now)
  const activationExpiresAt = plusMs(input.now, ACTIVATION_EXPIRES_AFTER_MS)
  const requestHash = await hashRequest({ operation: "create", playlist })
  const plan: GuardedMutationPlan = {
    operationKey: input.operationKey,
    shareId: input.shareId,
    method: "create",
    requestHash,
    secretHash: input.secretHash,
    expectedRevision: null,
    newRevision: 1,
    requiredState: "absent",
    checkActivationExpiry: false,
    now: nowIso,
  }
  const outcome: CreateOutcome = {
    shareId: input.shareId,
    revision: 1,
    state: "pending",
    contentHash: input.contentHash,
    createdAt: nowIso,
    activationExpiresAt,
  }
  const receiptExpiresAt = plusMs(input.now, MUTATION_RECEIPT_TTL_MS)
  const snapshotJson = canonicalString(playlist)

  return runGuardedMutation(
    db,
    plan,
    (nonce) =>
      buildStatements(
        db,
        plan,
        nonce,
        input,
        fields,
        snapshotJson,
        nowIso,
        activationExpiresAt,
        receiptExpiresAt,
        outcome,
      ),
    parseCreateOutcome,
  )
}

function buildStatements(
  db: D1Database,
  plan: GuardedMutationPlan,
  nonce: string,
  input: CreateInput,
  fields: ReturnType<typeof snapshotFields>,
  snapshotJson: string,
  nowIso: string,
  activationExpiresAt: string,
  receiptExpiresAt: string,
  outcome: CreateOutcome,
): readonly D1PreparedStatement[] {
  const parentAtRev1 = `EXISTS (
    SELECT 1 FROM playlists p WHERE p.share_id = ?1 AND p.revision = ?2)`
  const parentBinds = [plan.shareId, 1] as const
  return [
    // 1. Guard: insert the pending receipt only when neither the operation key
    //    nor the generated share_id already exists.
    db
      .prepare(
        `INSERT INTO publication_operations
         (operation_key, share_id, method, request_hash, secret_hash, attempt_nonce,
          status, expected_revision, new_revision, outcome_json, created_at, expires_at)
       SELECT ?1, ?2, 'create', ?3, ?4, ?5, 'pending', NULL, 1, NULL, ?6, ?7
       WHERE NOT EXISTS (SELECT 1 FROM publication_operations WHERE operation_key = ?1)
         AND NOT EXISTS (SELECT 1 FROM playlists WHERE share_id = ?2)`,
      )
      .bind(
        plan.operationKey,
        plan.shareId,
        plan.requestHash,
        plan.secretHash,
        nonce,
        nowIso,
        receiptExpiresAt,
      ),
    // 2. Parent row, gated on this attempt's pending receipt.
    db
      .prepare(
        `INSERT INTO playlists (
         share_id, revision, state, secret_hash, snapshot_json, content_hash, title,
         description, author, search_text, visibility, tags_json, item_count,
         total_duration_ms, import_count, derived_from_share_id, derived_from_revision,
         blocked, created_at, first_published_at, updated_at, activation_expires_at)
       SELECT ?1, 1, 'pending', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0,
              ?13, ?14, 0, ?15, NULL, ?16, ?17
       WHERE ${pendingOpGate(18)}`,
      )
      .bind(
        plan.shareId,
        plan.secretHash,
        snapshotJson,
        input.contentHash,
        fields.title,
        fields.description,
        fields.author,
        fields.searchText,
        fields.visibility,
        fields.tagsJson,
        fields.itemCount,
        fields.totalDurationMs,
        fields.derivedFromShareId,
        fields.derivedFromRevision,
        nowIso,
        nowIso,
        activationExpiresAt,
        plan.operationKey,
        nonce,
        plan.shareId,
        plan.requestHash,
        null,
        1,
      ),
    // 3+4. Tag upsert + links, gated on the pending receipt and the new parent.
    ...tagRefreshStatements(db, plan, nonce, fields.tagsJson, parentAtRev1, parentBinds),
    // 5. Assert: guard passed but parent missing -> abort whole batch.
    assertParentAtRevision(db, "create-parent", plan, nonce),
    // 6. Finalize the receipt with the create acknowledgement (no secret).
    finalizeStatic(db, plan, nonce, JSON.stringify(outcome)),
    // 7. Assert the finalize statement actually completed our receipt.
    assertReceiptCompleted(db, "create-receipt", plan, nonce),
  ]
}
