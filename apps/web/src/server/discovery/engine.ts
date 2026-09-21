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

export type CollectionOk = {
  readonly kind: "ok"
  readonly items: readonly ListItem[]
  readonly nextCursor: string | null
  readonly truncated: boolean
  readonly ranking: Ranking
}

export type CollectionFailure = {
  readonly kind: "invalid-cursor" | "expired-cursor"
}

export type CollectionOutcome = CollectionOk | CollectionFailure

/** Injectable clock — tests drive the window matrix deterministically. */
export type CollectionDeps = {
  readonly now?: Date
}

export async function runCollection(
  db: D1Database,
  params: CollectionParams,
  deps: CollectionDeps = {},
): Promise<CollectionOutcome> {
  const now = deps.now ?? new Date()
  const filter = normalizeFilter({ q: params.q, tag: params.tag })
  if (params.cursor !== undefined) {
    return continueCollection(db, params, filter, now)
  }
  return firstPage(db, params, filter, now)
}

// --- First page: policy -> fingerprint -> reuse-or-materialize -> scan --------

async function firstPage(
  db: D1Database,
  params: CollectionParams,
  filter: NormalizedFilter,
  now: Date,
): Promise<CollectionOutcome> {
  const decision =
    params.sort === "new"
      ? decideRanking("new")
      : decideRanking("popular", await collectRankCoverage(db, now))
  const fingerprint = await fingerprintOf(params.sort, filter, decision)
  const snapshot =
    (await findReusableSnapshot(db, fingerprint, now)) ??
    (await createSnapshot(db, fingerprint, decision, filter, now))
  return pageFromSnapshot(db, snapshot, 0, params.limit)
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
  return pageFromSnapshot(db, snapshot, verified.o, params.limit)
}

// --- Page slicing over frozen entries ------------------------------------------

async function pageFromSnapshot(
  db: D1Database,
  snapshot: DiscoverySnapshot,
  offset: number,
  limit: number,
): Promise<CollectionOutcome> {
  const items: ListItem[] = []
  let scanned = offset
  const entries = snapshot.entries
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
  }
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
