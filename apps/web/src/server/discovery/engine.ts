import type { D1Database } from "@cloudflare/workers-types"
import type { Ranking } from "../../../../../packages/shared/src/index"
import { decodeCursorPayload, queryFingerprint, signCursor, verifyCursorSignature } from "./cursor"
import type { ListSort, RankingDecision } from "./policy"
import { decideRanking } from "./policy"
import {
  collectRankCoverage,
  type EligibleEntry,
  fetchEligibleChunk,
  materializeCandidates,
  type NormalizedFilter,
  normalizeFilter,
  toListItem,
  VISIBILITY_CHUNK,
} from "./queries"
import {
  type DiscoverySnapshot,
  findReusableSnapshot,
  insertSnapshot,
  loadSnapshot,
  snapshotExpired,
} from "./snapshots"

// Collection read engine (task 19): decides the global ranking window first,
// materializes/reuses a 15-minute frozen snapshot, then serves a page slice
// that re-checks live visibility. Ordering, scoring and the ranking basis are
// frozen inside the snapshot; only visibility/deletion is re-evaluated at
// read time (newly hidden entries are skipped, positions still consumed).
//
// Cursor continuation contract: the opaque token binds snapshot id + scanned
// offset + query fingerprint under the snapshot's HMAC key. A continuation
// repeats the SAME sort/q/tag (limit may change): the request's normalized
// fingerprint is recomputed against the snapshot's frozen basis, so a cursor
// presented under a different query is a fingerprint mismatch -> 400. A
// missing or expired snapshot -> 410 with restart guidance.

export type CollectionParams = {
  readonly sort: ListSort
  readonly q: string | undefined
  readonly tag: string | undefined
  readonly limit: number
  readonly cursor: string | undefined
}

export type ListItem = ReturnType<typeof toListItem>

export type CollectionPageLink = {
  readonly page: number
  /** Signed continuation cursor for that page's start offset; null for 1. */
  readonly cursor: string | null
}

export type CollectionPages = {
  /** 1-based page the caller is on. */
  readonly current: number
  readonly totalPages: number
  /** Frozen positions in the snapshot — eligible items may be fewer. */
  readonly total: number
  /** Positions consumed by this page but skipped as hidden/deleted. */
  readonly skipped: number
  readonly links: readonly CollectionPageLink[]
}

export type CollectionOk = {
  readonly kind: "ok"
  readonly items: readonly ListItem[]
  readonly nextCursor: string | null
  readonly truncated: boolean
  readonly ranking: Ranking
  /** Fixed-position paging metadata — only present when requested. */
  readonly pages?: CollectionPages
}

export type CollectionFailure = {
  readonly kind: "invalid-cursor" | "expired-cursor"
}

export type CollectionOutcome = CollectionOk | CollectionFailure

/** Injectable clock — tests drive the window matrix deterministically. */
export type CollectionDeps = {
  readonly now?: Date
}

export type CollectionOptions = {
  /**
   * /explore only: slice the snapshot at FIXED positions (page N = entries
   * [(N-1)*limit, N*limit)) so page numbers and jump links are exact. Hidden
   * entries then shrink a page's item count instead of shifting boundaries.
   * The API keeps the default scan-until-limit behaviour.
   */
  readonly fixedPaging?: boolean
}

export async function runCollection(
  db: D1Database,
  params: CollectionParams,
  deps: CollectionDeps = {},
  options: CollectionOptions = {},
): Promise<CollectionOutcome> {
  const now = deps.now ?? new Date()
  const filter = normalizeFilter({ q: params.q, tag: params.tag })
  if (params.cursor !== undefined) {
    return continueCollection(db, params, filter, now, options)
  }
  return firstPage(db, params, filter, now, options)
}

// --- First page: policy -> fingerprint -> reuse-or-materialize -> scan --------

async function firstPage(
  db: D1Database,
  params: CollectionParams,
  filter: NormalizedFilter,
  now: Date,
  options: CollectionOptions,
): Promise<CollectionOutcome> {
  const decision =
    params.sort === "new"
      ? decideRanking("new")
      : decideRanking("popular", await collectRankCoverage(db, now))
  const fingerprint = await fingerprintOf(params.sort, filter, decision)
  const snapshot =
    (await findReusableSnapshot(db, fingerprint, now)) ??
    (await createSnapshot(db, fingerprint, decision, filter, now))
  return pageFromSnapshot(db, snapshot, 0, params.limit, options)
}

async function createSnapshot(
  db: D1Database,
  fingerprint: string,
  decision: RankingDecision,
  filter: NormalizedFilter,
  now: Date,
): Promise<DiscoverySnapshot> {
  const { entries, truncated } = await materializeCandidates(db, {
    decision,
    filter,
    now,
  })
  return insertSnapshot(db, { fingerprint, decision, entries, truncated, now })
}

// --- Continuation: signed cursor -> original snapshot -> scanned scan ---------

async function continueCollection(
  db: D1Database,
  params: CollectionParams,
  filter: NormalizedFilter,
  now: Date,
  options: CollectionOptions,
): Promise<CollectionOutcome> {
  const cursor = params.cursor ?? ""
  const decoded = decodeCursorPayload(cursor)
  if (decoded === null) return { kind: "invalid-cursor" }
  const snapshot = await loadSnapshot(db, decoded.s)
  // An absent row is an already-swept (or never-issued) snapshot: the honest
  // response is the same restart guidance either way — ids are unforgeable.
  if (snapshot === null || snapshotExpired(snapshot, now)) {
    return { kind: "expired-cursor" }
  }
  const verified = await verifyCursorSignature(cursor, snapshot.cursorKey)
  if (verified === null) return { kind: "invalid-cursor" }
  if (verified.f !== snapshot.fingerprint) {
    return { kind: "invalid-cursor" }
  }
  // Query-mismatch rejection: the request's own filters are normalized and
  // fingerprinted against THIS snapshot's frozen basis — a cursor pasted
  // under a different sort/q/tag can never silently continue. (fallbackReason
  // is determined by the basis and needs no separate fingerprint term.)
  const requestFingerprint = await fingerprintOf(params.sort, filter, {
    mode: snapshot.mode,
    effectiveWindow: snapshot.effectiveWindow,
  })
  if (requestFingerprint !== snapshot.fingerprint) {
    return { kind: "invalid-cursor" }
  }
  return pageFromSnapshot(db, snapshot, verified.o, params.limit, options)
}

// --- Page slicing over frozen entries ------------------------------------------

async function pageFromSnapshot(
  db: D1Database,
  snapshot: DiscoverySnapshot,
  offset: number,
  limit: number,
  options: CollectionOptions,
): Promise<CollectionOutcome> {
  const items: ListItem[] = []
  const entries = snapshot.entries
  let scanned = offset
  if (options.fixedPaging === true) {
    // Fixed positions: page boundaries never drift when an entry gets hidden
    // mid-snapshot — the slice is exactly [offset, offset+limit).
    const chunk = entries.slice(offset, offset + limit)
    const eligible = await fetchEligibleChunk(
      db,
      chunk.map(([shareId]) => shareId),
    )
    for (const [shareId] of chunk) {
      scanned += 1
      const hit: EligibleEntry | undefined = eligible.get(shareId)
      if (hit === undefined) continue
      items.push(toListItem(hit))
    }
  } else {
    while (items.length < limit && scanned < entries.length) {
      const chunk = entries.slice(scanned, scanned + VISIBILITY_CHUNK)
      const eligible = await fetchEligibleChunk(
        db,
        chunk.map(([shareId]) => shareId),
      )
      for (const [shareId] of chunk) {
        scanned += 1
        const hit: EligibleEntry | undefined = eligible.get(shareId)
        // Newly hidden/deleted entries are skipped but still consume their
        // frozen position — pagination never reorders mid-stream.
        if (hit === undefined) continue
        items.push(toListItem(hit))
        if (items.length === limit) break
      }
    }
  }
  const hasMore = scanned < entries.length
  const nextCursor = hasMore
    ? await signCursor(
        { v: 1, s: snapshot.snapshotId, o: scanned, f: snapshot.fingerprint },
        snapshot.cursorKey,
      )
    : null
  return {
    kind: "ok",
    items,
    nextCursor,
    truncated: snapshot.truncated,
    ranking: {
      mode: snapshot.mode,
      effectiveWindow: snapshot.effectiveWindow,
      asOf: snapshot.asOf,
      ...(snapshot.fallbackReason === null ? {} : { fallbackReason: snapshot.fallbackReason }),
    },
    ...(options.fixedPaging === true
      ? { pages: await pageLinks(snapshot, offset, limit, scanned - offset - items.length) }
      : {}),
  }
}

/**
 * Numbered page links over the frozen snapshot — current ±2 plus first/last.
 * Jump cursors are minted here because only the engine holds the snapshot's
 * short-lived signing key; it never leaves this module.
 */
async function pageLinks(
  snapshot: DiscoverySnapshot,
  offset: number,
  limit: number,
  skipped: number,
): Promise<CollectionPages> {
  const total = snapshot.entries.length
  const totalPages = Math.max(1, Math.ceil(total / limit))
  const current = Math.min(totalPages, Math.floor(offset / limit) + 1)
  const wanted = new Set<number>([
    1,
    totalPages,
    current - 2,
    current - 1,
    current,
    current + 1,
    current + 2,
  ])
  const links: CollectionPageLink[] = []
  for (const page of [...wanted].sort((a, b) => a - b)) {
    if (page < 1 || page > totalPages) continue
    links.push({
      page,
      // Page 1 needs no cursor — the bare URL is the canonical restart.
      cursor:
        page === 1
          ? null
          : await signCursor(
              {
                v: 1,
                s: snapshot.snapshotId,
                o: (page - 1) * limit,
                f: snapshot.fingerprint,
              },
              snapshot.cursorKey,
            ),
    })
  }
  return { current, totalPages, total, skipped, links }
}

async function fingerprintOf(
  sort: ListSort,
  filter: NormalizedFilter,
  decision: Pick<RankingDecision, "mode" | "effectiveWindow">,
): Promise<string> {
  return queryFingerprint({
    sort,
    mode: decision.mode,
    window: decision.effectiveWindow,
    q: filter.q,
    tag: filter.tag,
  })
}
