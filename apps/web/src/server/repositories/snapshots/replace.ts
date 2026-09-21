import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import {
  canonicalString,
  MUTATION_RECEIPT_TTL_MS,
  SharedPlaylistSchema,
} from "../../../../../../packages/shared/src/index"
import type { GuardedMutationPlan } from "../guard"
import { pendingOpGate, runGuardedMutation } from "../guard"
import { hashRequest, plusMs, toIso } from "../hashing"
import type { MutationResult, PatchOutcome } from "../types"
import {
  assertParentAtRevision,
  assertReceiptCompleted,
  finalizeFromRow,
  snapshotFields,
  tagRefreshStatements,
} from "./internal"
import { parsePatchOutcome } from "./outcomes"

export type ReplaceInput = {
  readonly shareId: string
  readonly secretHash: string
  readonly operationKey: string
  readonly expectedRevision: number
  readonly playlist: unknown
  readonly contentHash: string
  readonly now: Date
}

/**
 * Full snapshot replacement (not JSON merge): one guarded batch that bumps the
 * revision once, rewrites the canonical payload and denormalized columns, and
 * refreshes the relational tag rows — or writes nothing at all when the
 * revision/capability predicates do not hold.
 */
export async function replaceSnapshot(
  db: D1Database,
  input: ReplaceInput,
): Promise<MutationResult<PatchOutcome>> {
  const playlist = SharedPlaylistSchema.parse(input.playlist)
  const fields = snapshotFields(playlist)
  const nowIso = toIso(input.now)
  const requestHash = await hashRequest({
    operation: "replace",
    shareId: input.shareId,
    expectedRevision: input.expectedRevision,
    playlist,
  })
  const plan: GuardedMutationPlan = {
    operationKey: input.operationKey,
    shareId: input.shareId,
    method: "replace",
    requestHash,
    secretHash: input.secretHash,
    expectedRevision: input.expectedRevision,
    newRevision: input.expectedRevision + 1,
    requiredState: "active",
    checkActivationExpiry: false,
    now: nowIso,
  }
  const receiptExpiresAt = plusMs(input.now, MUTATION_RECEIPT_TTL_MS)
  const snapshotJson = canonicalString(playlist)

  return runGuardedMutation(
    db,
    plan,
    (nonce) =>
      buildStatements(db, plan, nonce, input, fields, snapshotJson, nowIso, receiptExpiresAt),
    parsePatchOutcome,
  )
}

function buildStatements(
  db: D1Database,
  plan: GuardedMutationPlan,
  nonce: string,
  input: ReplaceInput,
  fields: ReturnType<typeof snapshotFields>,
  snapshotJson: string,
  nowIso: string,
  receiptExpiresAt: string,
): readonly D1PreparedStatement[] {
  const parentAtNewRevision = `EXISTS (
    SELECT 1 FROM playlists p WHERE p.share_id = ?1 AND p.revision = ?2)`
  const parentBinds = [plan.shareId, plan.newRevision] as const
  return [
    // 1. Guard: pending receipt only when share_id + secret hash + expected
    //    revision + active state all hold, and no receipt exists for this key.
    db
      .prepare(
        `INSERT INTO publication_operations
         (operation_key, share_id, method, request_hash, secret_hash, attempt_nonce,
          status, expected_revision, new_revision, outcome_json, created_at, expires_at)
       SELECT ?1, ?2, 'replace', ?3, ?4, ?5, 'pending', ?6, ?7, NULL, ?8, ?9
       WHERE EXISTS (
         SELECT 1 FROM playlists
         WHERE share_id = ?2 AND secret_hash = ?4 AND revision = ?6 AND state = 'active')
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
    // 2. Parent row update; revision bump and denormalized refresh are one
    //    statement so a matched guard always yields exactly one changed row.
    db
      .prepare(
        `UPDATE playlists
       SET snapshot_json = ?1, content_hash = ?2, title = ?3, description = ?4,
           author = ?5, search_text = ?6, visibility = ?7, tags_json = ?8,
           item_count = ?9, total_duration_ms = ?10,
           derived_from_share_id = ?11, derived_from_revision = ?12,
           revision = ?13, updated_at = ?14
       WHERE share_id = ?15 AND secret_hash = ?16 AND revision = ?17 AND state = 'active'
         AND ${pendingOpGate(18)}`,
      )
      .bind(
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
    // 3. Relational tag refresh, gated on the pending receipt AND on the parent
    //    row already sitting at the new revision (a zero-row parent update can
    //    never let tag writes proceed).
    db
      .prepare(
        `DELETE FROM playlist_tags
       WHERE share_id = ?1
         AND ${pendingOpGate(2)}
         AND EXISTS (SELECT 1 FROM playlists p WHERE p.share_id = ?1 AND p.revision = ?8)`,
      )
      .bind(
        plan.shareId,
        plan.operationKey,
        nonce,
        plan.shareId,
        plan.requestHash,
        plan.expectedRevision,
        plan.newRevision,
        plan.newRevision,
      ),
    ...tagRefreshStatements(db, plan, nonce, fields.tagsJson, parentAtNewRevision, parentBinds),
    // 5. Assert: guard passed but parent did not reach the new revision.
    assertParentAtRevision(db, "replace-parent", plan, nonce),
    // 6. Finalize the receipt with post-write row values.
    finalizeFromRow(db, plan, nonce),
    // 7. Assert our receipt actually completed.
    assertReceiptCompleted(db, "replace-receipt", plan, nonce),
  ]
}
