import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import {
  collapseWhitespace,
  type SharedPlaylist,
} from "../../../../../../packages/shared/src/index"
import { type GuardedMutationPlan, pendingOpBinds, pendingOpGate } from "../guard"

// Shared pieces of the guarded snapshot batches: derived denormalized columns,
// the relational tag refresh pair, and the write-assertion statements. Outcome
// parsers live in ./outcomes.js. Statement order inside every batch is always:
// guard insert -> parent write -> dependent writes -> invariant assert ->
// receipt finalize -> receipt assert.

export type SnapshotFieldSet = {
  readonly title: string
  readonly description: string
  readonly author: string
  readonly searchText: string
  readonly visibility: "public" | "unlisted"
  readonly tagsJson: string
  readonly itemCount: number
  readonly totalDurationMs: number
  readonly derivedFromShareId: string | null
  readonly derivedFromRevision: number | null
}

export function snapshotFields(playlist: SharedPlaylist): SnapshotFieldSet {
  const searchText = collapseWhitespace(
    `${playlist.title} ${playlist.description} ${playlist.author}`.normalize("NFC"),
  ).toLocaleLowerCase("en")
  return {
    title: playlist.title,
    description: playlist.description,
    author: playlist.author,
    searchText,
    visibility: playlist.visibility,
    tagsJson: JSON.stringify(playlist.tags),
    itemCount: playlist.items.length,
    totalDurationMs: playlist.items.reduce(
      (total, item) => total + (item.range.end - item.range.start),
      0,
    ),
    derivedFromShareId: playlist.derivedFrom?.shareId ?? null,
    derivedFromRevision: playlist.derivedFrom?.revision ?? null,
  }
}

/**
 * Bounded relational tag refresh: one JSON payload over json_each, never one
 * statement per tag. `parentGate` is an extra EXISTS clause (written with
 * relative ?1, ?2, ... placeholders and renumbered per statement) proving the
 * parent row already reached its post-write state, so a zero-row parent write
 * can never let tag writes proceed. Bind layout per statement is inline.
 */
export function tagRefreshStatements(
  db: D1Database,
  plan: GuardedMutationPlan,
  nonce: string,
  tagsJson: string,
  parentGate: string,
  parentGateBinds: readonly unknown[],
): readonly D1PreparedStatement[] {
  const gateBinds = pendingOpBinds(plan, nonce)
  // ?1 tagsJson; gate ?2..?7; parentGate renumbered to ?8...
  const upsertTags = db
    .prepare(
      `INSERT INTO tags (tag)
       SELECT j.value FROM json_each(?1) AS j
       WHERE ${pendingOpGate(2)} AND ${renumberedGate(parentGate, 8)}
       ON CONFLICT (tag) DO NOTHING`,
    )
    .bind(tagsJson, ...gateBinds, ...parentGateBinds)
  // ?1 shareId, ?2 tagsJson; gate ?3..?8; parentGate renumbered to ?9...
  const linkTags = db
    .prepare(
      `INSERT INTO playlist_tags (share_id, tag_id)
       SELECT ?1, t.tag_id FROM tags AS t
       JOIN json_each(?2) AS j ON j.value = t.tag
       WHERE ${pendingOpGate(3)} AND ${renumberedGate(parentGate, 9)}`,
    )
    .bind(plan.shareId, tagsJson, ...gateBinds, ...parentGateBinds)
  return [upsertTags, linkTags]
}

/** Rebase relative `?N` placeholders in a clause to start at `startIndex`. */
function renumberedGate(clause: string, startIndex: number): string {
  return clause.replace(
    /\?(\d+)/g,
    (_match, digits: string) => `?${Number(digits) + startIndex - 1}`,
  )
}

/** Abort the batch when the pending op exists but the parent row is absent. */
export function assertParentGone(
  db: D1Database,
  label: string,
  plan: GuardedMutationPlan,
  nonce: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO write_asserts (name)
       SELECT ?1
       WHERE EXISTS (
         SELECT 1 FROM publication_operations po
         WHERE po.operation_key = ?2 AND po.attempt_nonce = ?3 AND po.status = 'pending'
       )
       AND EXISTS (SELECT 1 FROM playlists p WHERE p.share_id = ?4)`,
    )
    .bind(label, plan.operationKey, nonce, plan.shareId)
}

/** Abort the batch when the pending op exists but the parent missed its target. */
export function assertParentAtRevision(
  db: D1Database,
  label: string,
  plan: GuardedMutationPlan,
  nonce: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO write_asserts (name)
       SELECT ?1
       WHERE EXISTS (
         SELECT 1 FROM publication_operations po
         WHERE po.operation_key = ?2 AND po.attempt_nonce = ?3 AND po.status = 'pending'
       )
       AND NOT EXISTS (
         SELECT 1 FROM playlists p WHERE p.share_id = ?4 AND p.revision = ?5
       )`,
    )
    .bind(label, plan.operationKey, nonce, plan.shareId, plan.newRevision)
}

/** Abort the batch when our pending receipt still exists after finalize ran. */
export function assertReceiptCompleted(
  db: D1Database,
  label: string,
  plan: GuardedMutationPlan,
  nonce: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO write_asserts (name)
       SELECT ?1
       WHERE EXISTS (
         SELECT 1 FROM publication_operations po
         WHERE po.operation_key = ?2 AND po.attempt_nonce = ?3 AND po.status = 'pending'
       )`,
    )
    .bind(label, plan.operationKey, nonce)
}

/**
 * Finalize for mutations that keep a parent row (activate/replace): the receipt
 * outcome is computed from the post-write row so the recorded acknowledgement
 * always matches persisted state.
 */
export function finalizeFromRow(db: D1Database, plan: GuardedMutationPlan, nonce: string) {
  return db
    .prepare(
      `UPDATE publication_operations
       SET status = 'completed',
           outcome_json = (
             SELECT json_object(
               'shareId', p.share_id, 'revision', p.revision,
               'contentHash', p.content_hash, 'publishedAt', p.first_published_at,
               'updatedAt', p.updated_at)
             FROM playlists p WHERE p.share_id = ?3)
       WHERE operation_key = ?1 AND attempt_nonce = ?2 AND status = 'pending'
         AND EXISTS (
           SELECT 1 FROM playlists p2 WHERE p2.share_id = ?3 AND p2.revision = ?4)`,
    )
    .bind(plan.operationKey, nonce, plan.shareId, plan.newRevision)
}

/** Finalize for mutations without a post-write parent row (create/delete). */
export function finalizeStatic(
  db: D1Database,
  plan: GuardedMutationPlan,
  nonce: string,
  outcomeJson: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE publication_operations
       SET status = 'completed', outcome_json = ?3
       WHERE operation_key = ?1 AND attempt_nonce = ?2 AND status = 'pending'`,
    )
    .bind(plan.operationKey, nonce, outcomeJson)
}
