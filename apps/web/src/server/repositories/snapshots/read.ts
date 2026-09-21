import type { D1Database } from "@cloudflare/workers-types"
import { type PlaylistRow, toPlaylistRow, toStoredSnapshot } from "../rows"
import type { StoredSnapshot } from "../types"

// Snapshot reads. Raw SQL stays in the repository layer; page rendering and
// route handlers never see SQL. Pending rows ARE returned here (services decide
// visibility); callers that need the public contract filter state themselves.

const SNAPSHOT_COLUMNS = `share_id, revision, state, secret_hash, snapshot_json, content_hash,
  title, description, author, search_text, visibility, tags_json, item_count,
  total_duration_ms, import_count, derived_from_share_id, derived_from_revision,
  blocked, created_at, first_published_at, updated_at, activation_expires_at`

async function readRow(db: D1Database, shareId: string): Promise<PlaylistRow | null> {
  const row = await db
    .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM playlists WHERE share_id = ?1`)
    .bind(shareId)
    .first()
  if (row === null) return null
  return toPlaylistRow(row)
}

/** Internal read of any state (pending included) for management flows/tests. */
export async function getSnapshot(db: D1Database, shareId: string): Promise<StoredSnapshot | null> {
  const row = await readRow(db, shareId)
  return row === null ? null : toStoredSnapshot(row)
}

/**
 * Active-only read for the public GET path. Pending rows are invisible here,
 * including un-expired provisional snapshots; the expiry sweep owns removal.
 */
export async function getActiveSnapshot(
  db: D1Database,
  shareId: string,
): Promise<StoredSnapshot | null> {
  const row = await readRow(db, shareId)
  if (row === null || row.state !== "active") return null
  return toStoredSnapshot(row)
}

/** Ordered canonical tag list via the relational join table (for verification). */
export async function listTagLinks(db: D1Database, shareId: string): Promise<readonly string[]> {
  const rows = await db
    .prepare(
      `SELECT t.tag AS tag FROM playlist_tags pt
       JOIN tags t ON t.tag_id = pt.tag_id
       WHERE pt.share_id = ?1 ORDER BY t.tag`,
    )
    .bind(shareId)
    .all<{ tag: string }>()
  return rows.results.map((row) => row.tag)
}

/** Tag -> share_ids join used by filtered listing; exercises the tag index. */
export async function listShareIdsByTag(db: D1Database, tag: string): Promise<readonly string[]> {
  const rows = await db
    .prepare(
      `SELECT pt.share_id AS share_id FROM playlist_tags pt
       JOIN tags t ON t.tag_id = pt.tag_id
       WHERE t.tag = ?1 ORDER BY pt.share_id`,
    )
    .bind(tag)
    .all<{ share_id: string }>()
  return rows.results.map((row) => row.share_id)
}
