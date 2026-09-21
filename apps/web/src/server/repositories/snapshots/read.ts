import type { D1Database } from "@cloudflare/workers-types"
import { SnapshotRepositoryError } from "../errors"
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

// --- Direct Remix children (task 20) ------------------------------------------
//
// The public page's "Remix" section is a bounded, paginated DIRECT-children
// view over the same eligibility rule as discovery — active + public +
// unblocked — rechecked at read time. No graph traversal: children only,
// never grandchildren, and hidden/deleted parents or children simply drop
// out of the result.

export const REMIX_PAGE_SIZE = 10 as const
/** Hard cap on reachable pages so OFFSET stays bounded no matter the input. */
export const REMIX_PAGE_MAX = 50 as const

export type RemixChildRow = {
  readonly shareId: string
  readonly title: string
  readonly itemCount: number
  readonly firstPublishedAt: string | null
  readonly createdAt: string
}

export type RemixChildrenPage = {
  readonly items: readonly RemixChildRow[]
  readonly total: number
  readonly page: number
}

export async function listPublicRemixChildren(
  db: D1Database,
  parentShareId: string,
  page: number,
): Promise<RemixChildrenPage> {
  const bounded = Math.min(Math.max(Math.trunc(page), 1), REMIX_PAGE_MAX)
  const where = `derived_from_share_id = ?1
     AND state = 'active' AND visibility = 'public' AND blocked = 0`
  const counted = await db
    .prepare(`SELECT COUNT(*) AS c FROM playlists WHERE ${where}`)
    .bind(parentShareId)
    .first<{ c: number }>()
  const total = typeof counted?.c === "number" ? counted.c : 0
  const rows = await db
    .prepare(
      `SELECT share_id, title, item_count, first_published_at, created_at
       FROM playlists
       WHERE ${where}
       ORDER BY first_published_at DESC, share_id ASC
       LIMIT ?2 OFFSET ?3`,
    )
    .bind(parentShareId, REMIX_PAGE_SIZE, (bounded - 1) * REMIX_PAGE_SIZE)
    .all<Record<string, unknown>>()
  const items: RemixChildRow[] = []
  for (const row of rows.results) {
    if (typeof row["share_id"] !== "string" || typeof row["title"] !== "string") {
      throw new SnapshotRepositoryError("CORRUPT_ROW", "remix child row has unexpected shape")
    }
    items.push({
      shareId: row["share_id"],
      title: row["title"],
      itemCount: typeof row["item_count"] === "number" ? row["item_count"] : 0,
      firstPublishedAt:
        typeof row["first_published_at"] === "string" ? row["first_published_at"] : null,
      createdAt: typeof row["created_at"] === "string" ? row["created_at"] : "",
    })
  }
  return { items, total, page: bounded }
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
