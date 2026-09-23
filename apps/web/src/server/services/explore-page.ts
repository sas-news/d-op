import type { Ranking } from "../../../../../packages/shared/src/index"
import type { CollectionDeps, CollectionPages, ListItem } from "../discovery/engine"
import type { FallbackReason, RankWindow } from "../discovery/policy"
import { listPublicTagCounts } from "../discovery/queries"
import { runCollectionRequest } from "./discover"
import { formatDateJa, formatDurationJa, SHARE_SITE_ORIGIN } from "./share-page"

// /explore view-model assembly (task 19). Same read path and eligibility as
// the collection API — the page is SSR over the identical engine, never a
// separate query. Numbered paging runs LIVE (?p=N over COUNT+LIMIT/OFFSET)
// so no snapshot state exists for the page and nothing can expire; stale
// `s`/`cursor` params from snapshot-era URLs are lifted out and ignored.
// Every state (ready / invalid query / unavailable) is decided here so the
// page renders an honest status instead of a fake empty directory.

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

/** Numbered pager for /explore — live `?p=` links, nothing to expire. */
export type ExplorePager = {
  readonly current: number
  readonly totalPages: number
  /** Eligible items in the filtered listing (live count, capped). */
  readonly total: number
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
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable"; readonly status: 429 | 503; readonly retryAfter: string | null }

export async function loadExplorePage(
  request: Request,
  requestId: string,
  deps: CollectionDeps = {},
): Promise<ExplorePageResult> {
  const url = new URL(request.url)
  // Canonicalize FIRST: a GET form always serializes empty fields and old
  // links carry dead paging state, so any request whose query would lose
  // params under the whitelist is redirected (301) to the clean URL — the
  // address bar never shows `?q=&tag=` or a stale `s`/`cursor`.
  const canonical = canonicalExploreQuery(url)
  if (canonical !== null) {
    return {
      kind: "redirect",
      location: canonical === "" ? EXPLORE_PATH : `${EXPLORE_PATH}?${canonical}`,
    }
  }
  // The page is friendlier than the strict API schema: empty fields from a
  // GET form (`?q=&tag=`), stray params (utm_*, tracker junk) and stale
  // paging state (`s`, `cursor` — leftovers of the pre-live-paging URLs)
  // are lifted out before the whitelist is re-validated. A plain filter
  // submit or an old link can never land on an error page.
  const cleanParams = new URLSearchParams()
  for (const key of ["sort", "q", "tag", "limit"] as const) {
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
    // Live numbered paging — no snapshot state, nothing that can expire.
    result = await runCollectionRequest(normalizedRequest, requestId, deps, {
      pageRequest: { page: parsePage(url) },
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
    // Defensive: live paging has no expired/invalid states of its own.
    return { kind: "invalid" }
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

/** `p` — 1-based page number; a malformed value degrades to page 1. */
const PAGE_RE = /^\d{1,7}$/

/** Params the page understands — everything else is canonicalized away. */
const PAGE_PARAMS = new Set(["sort", "q", "tag", "limit", "p"])

/**
 * Builds the canonical query for /explore: whitelisted, non-empty, first
 * occurrence wins; `p` must be a valid page ≥ 2 (`p=1` is the bare page).
 * Returns null when the request is already canonical — otherwise the query
 * to 301 to ("" means the bare path). Direct service calls and hand-typed
 * URLs converge on the same clean form, so nothing errors or looks broken.
 */
function canonicalExploreQuery(url: URL): string | null {
  const kept = new URLSearchParams()
  const seen = new Set<string>()
  let dirty = false
  for (const [key, value] of url.searchParams) {
    let keep = PAGE_PARAMS.has(key) && value !== "" && !seen.has(key)
    if (keep && key === "p") {
      keep = PAGE_RE.test(value) && Number.parseInt(value, 10) >= 2
    }
    if (keep) {
      seen.add(key)
      kept.append(key, value)
    } else {
      dirty = true
    }
  }
  return dirty ? kept.toString() : null
}

/**
 * Reads `?p=` as a 1-based page. Post-canonicalization it is always valid
 * and ≥ 2, but a direct in-process call still degrades instead of failing.
 */
function parsePage(url: URL): number {
  const raw = url.searchParams.get("p")
  if (raw === null || !PAGE_RE.test(raw)) return 1
  return Math.max(1, Number.parseInt(raw, 10))
}

function filterUrl(input: {
  readonly sort: "new" | "popular"
  readonly q: string | null
  readonly tag: string | null
  readonly limit?: number
  readonly p?: number
}): string {
  const params = new URLSearchParams()
  params.set("sort", input.sort)
  if (input.q !== null && input.q !== "") params.set("q", input.q)
  if (input.tag !== null && input.tag !== "") params.set("tag", input.tag)
  if (input.limit !== undefined) params.set("limit", String(input.limit))
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
  // are just `?p=N` over live data, so links never go stale.
  const urlFor = (page: number): string =>
    page === 1
      ? filterUrl({ ...filters, ...(limit === undefined ? {} : { limit }) })
      : filterUrl({ ...filters, ...(limit === undefined ? {} : { limit }), p: page })
  const links = pages.links.map((link) => ({
    page: link.page,
    url: urlFor(link.page),
    current: link.page === pages.current,
  }))
  return {
    current: pages.current,
    totalPages: pages.totalPages,
    total: pages.total,
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
