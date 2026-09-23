import type { Ranking } from "../../../../../packages/shared/src/index"
import type { CollectionDeps, CollectionPages, ListItem } from "../discovery/engine"
import type { FallbackReason, RankWindow } from "../discovery/policy"
import { listPublicTagCounts } from "../discovery/queries"
import { runCollectionRequest } from "./discover"
import { formatDateJa, formatDurationJa, SHARE_SITE_ORIGIN } from "./share-page"

// /explore view-model assembly (task 19). Same read path and eligibility as
// the collection API — the page is SSR over the identical engine, never a
// separate query. Every state (ready / invalid query / expired cursor /
// unavailable) is decided here so the page renders an honest status instead
// of content served without admission or a fake empty directory.

export const EXPLORE_PATH = "/explore" as const
export const EXPLORE_TAG_CHIPS_MAX = 20 as const

export type ExploreFilters = {
  readonly sort: "new" | "popular"
  readonly q: string | null
  readonly tag: string | null
}

export type ExploreItemView = {
  readonly shareId: string
  readonly url: string
  readonly title: string
  readonly author: string
  readonly tags: readonly string[]
  readonly clipCount: number
  readonly totalDurationLabel: string
  /** Approximate import-notification count label — never "users"/"people". */
  readonly importCount: number
  readonly publishedAtLabel: string
  readonly sourceUrl: string | null
}

export type ExploreTagChip = {
  readonly tag: string
  readonly count: number
  readonly active: boolean
  readonly url: string
}

export type ExplorePagerLink = {
  readonly page: number
  readonly url: string
  readonly current: boolean
}

/** Numbered pager for /explore — exact pages over the frozen snapshot. */
export type ExplorePager = {
  readonly current: number
  readonly totalPages: number
  /** Frozen positions in the snapshot (eligible items may be fewer). */
  readonly total: number
  /** This page's positions skipped as hidden/deleted since the snapshot. */
  readonly skipped: number
  readonly prevUrl: string | null
  readonly nextUrl: string | null
  readonly firstUrl: string
  readonly lastUrl: string | null
  readonly links: readonly ExplorePagerLink[]
}

export type ExplorePageView = {
  readonly canonicalUrl: string
  readonly filters: ExploreFilters
  /** Non-default page size from `?limit=` — kept in pager/form links so page
   *  numbers stay stable. Null at the default. */
  readonly pageSize: number | null
  readonly items: readonly ExploreItemView[]
  readonly nextPageUrl: string | null
  readonly restartUrl: string | null
  readonly pager: ExplorePager | null
  readonly truncated: boolean
  readonly ranking: Ranking
  /** Human-facing basis label, e.g. "人気順 · 直近30日間の保存通知（概数）". */
  readonly basisLabel: string
  /** Fallback explanation line, only when the basis widened or degraded. */
  readonly fallbackLabel: string | null
  readonly asOfLabel: string
  readonly tagChips: readonly ExploreTagChip[]
}

export type ExplorePageResult =
  | { readonly kind: "ready"; readonly view: ExplorePageView }
  | { readonly kind: "invalid" }
  | { readonly kind: "expired" }
  | { readonly kind: "unavailable"; readonly status: 429 | 503; readonly retryAfter: string | null }

export async function loadExplorePage(
  request: Request,
  requestId: string,
  deps: CollectionDeps = {},
): Promise<ExplorePageResult> {
  const url = new URL(request.url)
  // The page is friendlier than the strict API schema: empty fields from a
  // GET form (`?q=&tag=`), stray params (utm_*, tracker junk) and the page's
  // own s/p controls are lifted out before the whitelist is re-validated —
  // a plain filter submit can never land on the 400 page.
  const parsed = parseExploreParams(url)
  if (parsed === null) return { kind: "invalid" }
  const cleanParams = new URLSearchParams()
  for (const key of ["sort", "q", "tag", "limit", "cursor"] as const) {
    const value = url.searchParams.get(key)
    if (value !== null && value !== "") cleanParams.set(key, value)
  }
  const query = cleanParams.toString()
  const normalizedRequest = new Request(
    `${url.origin}${EXPLORE_PATH}${query === "" ? "" : `?${query}`}`,
    request,
  )
  let result: Awaited<ReturnType<typeof runCollectionRequest>>
  try {
    // Fixed-position paging: exact page numbers and jump links for humans.
    result = await runCollectionRequest(normalizedRequest, requestId, deps, {
      fixedPaging: true,
      ...(parsed.pageRequest === undefined ? {} : { pageRequest: parsed.pageRequest }),
    })
  } catch {
    return { kind: "unavailable", status: 503, retryAfter: null }
  }
  if (result.stage === "denied") {
    const status = result.response.status === 429 ? 429 : 503
    return {
      kind: "unavailable",
      status,
      retryAfter: result.response.headers.get("retry-after"),
    }
  }
  if (result.stage === "invalid-query") return { kind: "invalid" }
  const outcome = result.outcome
  if (outcome.kind !== "ok") {
    return outcome.kind === "expired-cursor" ? { kind: "expired" } : { kind: "invalid" }
  }

  const filters: ExploreFilters = {
    sort: url.searchParams.get("sort") === "popular" ? "popular" : "new",
    q: url.searchParams.get("q") || null,
    tag: url.searchParams.get("tag") || null,
  }
  // Preserve a non-default page size across pager links — otherwise a jump
  // link minted for limit=N would be re-read at the default and page
  // numbers would drift.
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10)
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 50 ? rawLimit : undefined
  let tagChips: readonly ExploreTagChip[] = []
  try {
    tagChips = (await listPublicTagCounts(result.db))
      .slice(0, EXPLORE_TAG_CHIPS_MAX)
      .map((row) => ({
        tag: row.tag,
        count: row.count,
        active: filters.tag === row.tag,
        url: filterUrl({ sort: filters.sort, q: filters.q, tag: row.tag }),
      }))
  } catch {
    // The tag strip is a convenience, not the listing: a lookup failure leaves
    // an empty strip rather than failing the whole page.
    tagChips = []
  }
  const pager = toPager(outcome.pages, filters, limit)
  return {
    kind: "ready",
    view: {
      canonicalUrl: `${SHARE_SITE_ORIGIN}${EXPLORE_PATH}`,
      filters,
      pageSize: limit ?? null,
      items: outcome.items.map(toItemView),
      nextPageUrl: pager?.nextUrl ?? null,
      restartUrl: filtersRestartUrl(url, limit),
      pager,
      truncated: outcome.truncated,
      ranking: outcome.ranking,
      basisLabel: basisLabel(outcome.ranking),
      fallbackLabel: fallbackLabel(outcome.ranking.fallbackReason),
      asOfLabel: formatDateJa(outcome.ranking.asOf),
      tagChips,
    },
  }
}

function toItemView(item: ListItem): ExploreItemView {
  return {
    shareId: item.shareId,
    url: `/p/${item.shareId}`,
    title: item.playlist.title,
    author: item.playlist.author,
    tags: item.playlist.tags,
    clipCount: item.itemCount,
    totalDurationLabel: formatDurationJa(item.totalDurationMs),
    importCount: item.importCount,
    publishedAtLabel: formatDateJa(item.publishedAt),
    sourceUrl: item.source === null ? null : `/p/${item.source.shareId}`,
  }
}

/** `s` — snapshot ids are uuids; anything else is a malformed page link. */
const SNAPSHOT_ID_RE = /^[0-9a-fA-F-]{8,64}$/
/** `p` — 1-based page number, bounded so absurd inputs fail fast. */
const PAGE_RE = /^\d{1,7}$/

/**
 * Lifts the page-only `s`/`p` controls out of the raw query. Returns null on
 * malformed values ( -> the 400 page); a well-formed but unknown/expired
 * snapshot id surfaces later as the 410 restart page.
 */
function parseExploreParams(
  url: URL,
): { readonly pageRequest: { snapshotId?: string; page: number } | undefined } | null {
  // Empty controls drop like empty filter fields — `?s=`/`?p=` are no-ops.
  const rawSnapshot = url.searchParams.get("s") || null
  const rawPage = url.searchParams.get("p") || null
  // A signed cursor wins outright — old-style links keep working.
  if (url.searchParams.get("cursor") !== null) return { pageRequest: undefined }
  if (rawSnapshot !== null && !SNAPSHOT_ID_RE.test(rawSnapshot)) return null
  if (rawPage !== null && !PAGE_RE.test(rawPage)) return null
  if (rawSnapshot === null && rawPage === null) return { pageRequest: undefined }
  const page = rawPage === null ? 1 : Math.max(1, Number.parseInt(rawPage, 10))
  return {
    pageRequest: {
      ...(rawSnapshot === null ? {} : { snapshotId: rawSnapshot }),
      page,
    },
  }
}

function filterUrl(input: {
  readonly sort: "new" | "popular"
  readonly q: string | null
  readonly tag: string | null
  readonly limit?: number
  readonly s?: string
  readonly p?: number
}): string {
  const params = new URLSearchParams()
  params.set("sort", input.sort)
  if (input.q !== null && input.q !== "") params.set("q", input.q)
  if (input.tag !== null && input.tag !== "") params.set("tag", input.tag)
  if (input.limit !== undefined) params.set("limit", String(input.limit))
  if (input.s !== undefined) params.set("s", input.s)
  if (input.p !== undefined) params.set("p", String(input.p))
  const query = params.toString()
  return query === "" ? EXPLORE_PATH : `${EXPLORE_PATH}?${query}`
}

/** First-page URL with the same filters but no paging state — the restart. */
function filtersRestartUrl(url: URL, limit: number | undefined): string | null {
  if (!url.searchParams.has("cursor") && !url.searchParams.has("s") && !url.searchParams.has("p")) {
    return null
  }
  const sort = url.searchParams.get("sort") === "popular" ? "popular" : "new"
  return filterUrl({
    sort,
    q: url.searchParams.get("q"),
    tag: url.searchParams.get("tag"),
    ...(limit === undefined ? {} : { limit }),
  })
}

function toPager(
  pages: CollectionPages | undefined,
  filters: ExploreFilters,
  limit: number | undefined,
): ExplorePager | null {
  if (pages === undefined) return null
  // Page 1 stays the bare filtered URL — the canonical restart; deeper pages
  // pin the snapshot via `s` and the fixed position via `p`.
  const urlFor = (page: number): string =>
    page === 1
      ? filterUrl({ ...filters, ...(limit === undefined ? {} : { limit }) })
      : filterUrl({
          ...filters,
          ...(limit === undefined ? {} : { limit }),
          s: pages.snapshotId,
          p: page,
        })
  const links = pages.links.map((link) => ({
    page: link.page,
    url: urlFor(link.page),
    current: link.page === pages.current,
  }))
  return {
    current: pages.current,
    totalPages: pages.totalPages,
    total: pages.total,
    skipped: pages.skipped,
    prevUrl: pages.current > 1 ? urlFor(pages.current - 1) : null,
    nextUrl: pages.current < pages.totalPages ? urlFor(pages.current + 1) : null,
    firstUrl: urlFor(1),
    lastUrl: pages.current < pages.totalPages ? urlFor(pages.totalPages) : null,
    links,
  }
}

function windowLabel(window: RankWindow): string {
  switch (window) {
    case "30d":
      return "直近30日間の保存通知（概数）で集計"
    case "90d":
      return "直近90日間の保存通知（概数）で集計"
    case "lifetime":
      return "累計の保存通知（概数）で集計"
    case "none":
      return "公開日時が新しい順"
  }
}

function basisLabel(ranking: Ranking): string {
  const modeLabel = ranking.mode === "popular" ? "人気順" : "新着順"
  return `${modeLabel} · ${windowLabel(ranking.effectiveWindow)}`
}

function fallbackLabel(reason: FallbackReason | undefined): string | null {
  switch (reason) {
    case "insufficient-recent-data":
      return "直近30日間の実績が5件未満のため、集計期間を広げて表示しています。"
    case "no-imports":
      return "保存の実績がまだないため、人気順ではなく新着順で表示しています。"
    case undefined:
      return null
  }
}
