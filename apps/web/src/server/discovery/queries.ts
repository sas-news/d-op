import type { D1Database } from "@cloudflare/workers-types"
import {
  type DerivedFrom,
  DISCOVERY_SNAPSHOT_MAX_IDS,
  projectPublicPlaylist,
  type SharedPlaylist,
} from "../../../../../packages/shared/src/index"
import { SnapshotRepositoryError } from "../repositories/errors"
import { toPlaylistRow, toStoredSnapshot } from "../repositories/rows"
import type { StoredSnapshot } from "../repositories/types"
import {
  canonicalizeTagQuery,
  escapeLikePattern,
  normalizeSearchQuery,
  RANK_POLICY,
  type RankCoverage,
  type RankingDecision,
  utcDayOf,
  windowStartDay,
} from "./policy"

// Discovery SQL (task 19). All statements are parameterized; the only dynamic
// text is the fixed filter clause selection, never user input. The eligible
// predicate — state='active' AND visibility='public' AND blocked=0 — is the
// single visibility gate shared by coverage counting, candidate
// materialization, continuation re-checks and the public tag dictionary.
// Unlisted/pending/blocked rows can never reach any of these surfaces.

const ELIGIBLE = `p.state = 'active' AND p.visibility = 'public' AND p.blocked = 0`

const POSITIVE_IN_WINDOW = `SELECT COUNT(*) FROM (
    SELECT d.share_id AS sid FROM import_daily d
    JOIN playlists p ON p.share_id = d.share_id
    WHERE d.day BETWEEN ? AND ? AND ${ELIGIBLE}
    GROUP BY d.share_id HAVING SUM(d.count) > 0)`

export type NormalizedFilter = {
  readonly q: string | null
  readonly tag: string | null
}

/** Normalizes raw q/tag params once — both SQL and the fingerprint reuse it. */
export function normalizeFilter(input: {
  readonly q?: string | undefined
  readonly tag?: string | undefined
}): NormalizedFilter {
  return {
    q: input.q === undefined ? null : normalizeSearchQuery(input.q),
    tag: input.tag === undefined ? null : canonicalizeTagQuery(input.tag),
  }
}

/**
 * Global eligible positive-playlist coverage per window at `now` — one round
 * trip, independent of any search/tag/page narrowing. Window bounds are UTC
 * calendar days including today.
 */
export async function collectRankCoverage(db: D1Database, now: Date): Promise<RankCoverage> {
  const today = utcDayOf(now)
  const row = await db
    .prepare(
      `SELECT
         (${POSITIVE_IN_WINDOW}) AS c30,
         (${POSITIVE_IN_WINDOW}) AS c90,
         (SELECT COUNT(*) FROM playlists p
          WHERE ${ELIGIBLE} AND p.import_count > 0) AS clife`,
    )
    .bind(
      windowStartDay(now, RANK_POLICY.shortWindowDays),
      today,
      windowStartDay(now, RANK_POLICY.longWindowDays),
      today,
    )
    .first<{ c30: number; c90: number; clife: number }>()
  if (row === null) {
    throw new SnapshotRepositoryError("CORRUPT_ROW", "coverage query returned no row")
  }
  return {
    positives30d: row.c30,
    positives90d: row.c90,
    positivesLifetime: row.clife,
  }
}

export type SnapshotEntry = readonly [shareId: string, score: number]

/** Shared WHERE/ORDER/score for candidate materialization AND live paging —
 *  identical eligibility and ordering, never two implementations. */
function candidateQuery(input: {
  readonly decision: RankingDecision
  readonly filter: NormalizedFilter
  readonly now: Date
}): {
  readonly whereSql: string
  readonly scoreSelect: string
  readonly orderBy: string
  /** Binds for scoreSelect only — they precede the WHERE binds in SQL order. */
  readonly scoreBinds: (string | number)[]
  readonly whereBinds: (string | number)[]
} {
  const whereBinds: (string | number)[] = []
  const scoreBinds: (string | number)[] = []
  const clauses: string[] = [ELIGIBLE]
  if (input.filter.tag !== null) {
    // Stored tags are canonical and never "", so a degenerate filter like
    // ?tag=+ simply matches nothing — consistent with the q handling below.
    whereBinds.push(input.filter.tag)
    clauses.push(
      `EXISTS (SELECT 1 FROM playlist_tags pt JOIN tags t ON t.tag_id = pt.tag_id
       WHERE pt.share_id = p.share_id AND t.tag = ?)`,
    )
  }
  if (input.filter.q !== null) {
    if (input.filter.q === "") {
      // A whitespace-only q is a real (if degenerate) filter: it must match
      // nothing rather than silently become "match everything" ('%%').
      clauses.push("1 = 0")
    } else {
      whereBinds.push(`%${escapeLikePattern(input.filter.q)}%`)
      clauses.push(`p.search_text LIKE ? ESCAPE '\\'`)
    }
  }
  let scoreSelect: string
  let orderBy: string
  if (input.decision.mode === "new") {
    scoreSelect = "0"
    orderBy = "p.first_published_at DESC, p.share_id ASC"
  } else {
    orderBy = "score DESC, p.first_published_at DESC, p.share_id ASC"
    if (input.decision.effectiveWindow === "lifetime") {
      scoreSelect = "p.import_count"
    } else {
      const days =
        input.decision.effectiveWindow === "30d"
          ? RANK_POLICY.shortWindowDays
          : RANK_POLICY.longWindowDays
      scoreBinds.push(windowStartDay(input.now, days), utcDayOf(input.now))
      scoreSelect = `(SELECT COALESCE(SUM(d.count), 0) FROM import_daily d
        WHERE d.share_id = p.share_id AND d.day BETWEEN ? AND ?)`
    }
  }
  return {
    whereSql: clauses.join(" AND "),
    scoreSelect,
    orderBy,
    scoreBinds,
    whereBinds,
  }
}

/**
 * Materializes the ordered eligible candidate list for `decision` + `filter`:
 * up to DISCOVERY_SNAPSHOT_MAX_IDS [shareId, score] pairs in the frozen rank
 * order. Score-zero playlists are included (a zero tail is listed, never
 * hidden). Reads one extra row so `truncated` is an explicit fact, not a
 * silent cap.
 */
export async function materializeCandidates(
  db: D1Database,
  input: {
    readonly decision: RankingDecision
    readonly filter: NormalizedFilter
    readonly now: Date
  },
): Promise<{ readonly entries: SnapshotEntry[]; readonly truncated: boolean }> {
  const query = candidateQuery(input)
  const sql = `SELECT p.share_id AS share_id, ${query.scoreSelect} AS score
    FROM playlists p
    WHERE ${query.whereSql}
    ORDER BY ${query.orderBy}
    LIMIT ?`
  const rows = await db
    .prepare(sql)
    .bind(...query.scoreBinds, ...query.whereBinds, DISCOVERY_SNAPSHOT_MAX_IDS + 1)
    .all<{ share_id: string; score: number }>()
  const truncated = rows.results.length > DISCOVERY_SNAPSHOT_MAX_IDS
  const entries: SnapshotEntry[] = []
  for (const row of rows.results.slice(0, DISCOVERY_SNAPSHOT_MAX_IDS)) {
    if (typeof row.share_id !== "string" || typeof row.score !== "number") {
      throw new SnapshotRepositoryError("CORRUPT_ROW", "candidate row has unexpected shape")
    }
    entries.push([row.share_id, row.score])
  }
  return { entries, truncated }
}

/**
 * Live numbered page for /explore — no snapshot, no expiry: COUNT the
 * eligible filtered set (capped at DISCOVERY_SNAPSHOT_MAX_IDS like the
 * snapshot path), clamp the 1-based page into range, then read that exact
 * LIMIT/OFFSET slice with live visibility and the parent's public flag.
 * Ordering may drift between requests if rows publish/hide mid-browse —
 * accepted for the human page in exchange for never expiring.
 */
export async function listLivePage(
  db: D1Database,
  input: {
    readonly decision: RankingDecision
    readonly filter: NormalizedFilter
    readonly now: Date
    readonly page: number
    readonly limit: number
  },
): Promise<{
  readonly entries: readonly EligibleEntry[]
  /** Eligible filtered rows, capped at the snapshot-equivalent maximum. */
  readonly total: number
  /** Live eligible count before the cap — drives `truncated`. */
  readonly liveCount: number
  /** The page actually served after clamping into range. */
  readonly current: number
  readonly totalPages: number
}> {
  const query = candidateQuery(input)
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS c FROM playlists p WHERE ${query.whereSql}`)
    .bind(...query.whereBinds)
    .first<{ c: number }>()
  const liveCount = countRow?.c ?? 0
  const total = Math.min(liveCount, DISCOVERY_SNAPSHOT_MAX_IDS)
  const totalPages = Math.max(1, Math.ceil(total / input.limit))
  const current = Math.min(Math.max(1, input.page), totalPages)
  const offset = (current - 1) * input.limit
  const rows = await db
    .prepare(
      `SELECT ${LIST_COLUMNS}, ${query.scoreSelect} AS score,
         CASE WHEN parent.share_id IS NULL THEN 0 ELSE 1 END AS parent_public
       FROM playlists p
       LEFT JOIN playlists parent
         ON parent.share_id = p.derived_from_share_id
         AND parent.state = 'active' AND parent.visibility = 'public' AND parent.blocked = 0
       WHERE ${query.whereSql}
       ORDER BY ${query.orderBy}
       LIMIT ? OFFSET ?`,
    )
    .bind(...query.scoreBinds, ...query.whereBinds, input.limit, offset)
    .all<Record<string, unknown>>()
  const entries: EligibleEntry[] = []
  for (const raw of rows.results) {
    const parentFlag = raw["parent_public"]
    if (typeof parentFlag !== "number") {
      throw new SnapshotRepositoryError("CORRUPT_ROW", "listing row lost the parent_public flag")
    }
    const playlistRow = toPlaylistRow(raw)
    entries.push({
      stored: toStoredSnapshot(playlistRow),
      parentPublic: parentFlag !== 0,
    })
  }
  return { entries, total, liveCount, current, totalPages }
}

export type EligibleEntry = {
  readonly stored: StoredSnapshot
  readonly parentPublic: boolean
}

// Explicit aliases keep result keys stable (column names, never "p."-prefixed).
const LIST_COLUMNS = `p.share_id AS share_id, p.revision AS revision, p.state AS state,
  p.secret_hash AS secret_hash, p.snapshot_json AS snapshot_json, p.content_hash AS content_hash,
  p.title AS title, p.description AS description, p.author AS author,
  p.search_text AS search_text, p.visibility AS visibility, p.tags_json AS tags_json,
  p.item_count AS item_count, p.total_duration_ms AS total_duration_ms,
  p.import_count AS import_count, p.derived_from_share_id AS derived_from_share_id,
  p.derived_from_revision AS derived_from_revision, p.blocked AS blocked,
  p.created_at AS created_at, p.first_published_at AS first_published_at,
  p.updated_at AS updated_at, p.activation_expires_at AS activation_expires_at`

/** Max ids per visibility re-check — stays far under the D1 variable cap. */
export const VISIBILITY_CHUNK = 64

/**
 * Read-time eligibility re-check for frozen snapshot entries: returns ONLY the
 * ids that are still active+public+unblocked, mapped to their current stored
 * snapshot and whether the derivedFrom parent is currently public. Frozen
 * order/scores are the caller's; this supplies live visibility and metadata.
 */
export async function fetchEligibleChunk(
  db: D1Database,
  shareIds: readonly string[],
): Promise<ReadonlyMap<string, EligibleEntry>> {
  const result = new Map<string, EligibleEntry>()
  if (shareIds.length === 0) return result
  const placeholders = shareIds.map(() => "?").join(", ")
  const rows = await db
    .prepare(
      `SELECT ${LIST_COLUMNS},
         CASE WHEN parent.share_id IS NULL THEN 0 ELSE 1 END AS parent_public
       FROM playlists p
       LEFT JOIN playlists parent
         ON parent.share_id = p.derived_from_share_id
         AND parent.state = 'active' AND parent.visibility = 'public' AND parent.blocked = 0
       WHERE p.share_id IN (${placeholders}) AND ${ELIGIBLE}`,
    )
    .bind(...shareIds)
    .all<Record<string, unknown>>()
  for (const raw of rows.results) {
    const parentFlag = raw["parent_public"]
    if (typeof parentFlag !== "number") {
      throw new SnapshotRepositoryError("CORRUPT_ROW", "listing row lost the parent_public flag")
    }
    const playlistRow = toPlaylistRow(raw)
    result.set(playlistRow.share_id, {
      stored: toStoredSnapshot(playlistRow),
      parentPublic: parentFlag !== 0,
    })
  }
  return result
}

/**
 * The public tag dictionary: canonical tags with counts over eligible
 * playlists only (unlisted/blocked tags never surface). Ordered by usage then
 * name so the hottest filters lead.
 */
export async function listPublicTagCounts(
  db: D1Database,
): Promise<readonly { readonly tag: string; readonly count: number }[]> {
  const rows = await db
    .prepare(
      `SELECT t.tag AS tag, COUNT(*) AS playlist_count
       FROM tags t
       JOIN playlist_tags pt ON pt.tag_id = t.tag_id
       JOIN playlists p ON p.share_id = pt.share_id
       WHERE ${ELIGIBLE}
       GROUP BY t.tag
       ORDER BY playlist_count DESC, t.tag ASC`,
    )
    .all<{ tag: string; playlist_count: number }>()
  return rows.results.map((row) => {
    if (typeof row.tag !== "string" || typeof row.playlist_count !== "number") {
      throw new SnapshotRepositoryError("CORRUPT_ROW", "tag-count row has unexpected shape")
    }
    return { tag: row.tag, count: row.playlist_count }
  })
}

/** Collapses an eligible row into the public list item (SharedPlaylist payload + source). */
export function toListItem(entry: EligibleEntry): {
  readonly shareId: string
  readonly revision: number
  readonly publishedAt: string
  readonly updatedAt: string
  readonly contentHash: string
  readonly playlist: SharedPlaylist
  readonly itemCount: number
  readonly totalDurationMs: number
  readonly importCount: number
  readonly source: DerivedFrom | null
} {
  const stored = entry.stored
  if (stored.firstPublishedAt === null) {
    // Active rows always carry first_published_at; a null here is corruption
    // and fails closed (mirrors the single-share GET path).
    throw new SnapshotRepositoryError(
      "CORRUPT_ROW",
      "active listing row is missing first_published_at",
    )
  }
  const projection = projectPublicPlaylist({
    playlist: stored.snapshot,
    parentPublic: entry.parentPublic,
  })
  return {
    shareId: stored.shareId,
    revision: stored.revision,
    publishedAt: stored.firstPublishedAt,
    updatedAt: stored.updatedAt,
    contentHash: stored.contentHash,
    playlist: projection.playlist,
    itemCount: stored.itemCount,
    totalDurationMs: stored.totalDurationMs,
    importCount: stored.importCount,
    source: projection.source,
  }
}
