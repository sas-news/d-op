import type { Ranking } from "../../../../../packages/shared/src/index"
import type { CollectionDeps, ListItem } from "../discovery/engine"
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

export type ExplorePageView = {
  readonly canonicalUrl: string
  readonly filters: ExploreFilters
  readonly items: readonly ExploreItemView[]
  readonly nextPageUrl: string | null
  readonly restartUrl: string | null
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
  let result: Awaited<ReturnType<typeof runCollectionRequest>>
  try {
    result = await runCollectionRequest(request, requestId, deps)
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

  const url = new URL(request.url)
  const filters: ExploreFilters = {
    sort: url.searchParams.get("sort") === "popular" ? "popular" : "new",
    q: url.searchParams.get("q"),
    tag: url.searchParams.get("tag"),
  }
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
  return {
    kind: "ready",
    view: {
      canonicalUrl: `${SHARE_SITE_ORIGIN}${EXPLORE_PATH}`,
      filters,
      items: outcome.items.map(toItemView),
      nextPageUrl:
        outcome.nextCursor === null ? null : filterUrl({ ...filters, cursor: outcome.nextCursor }),
      restartUrl: filtersRestartUrl(url),
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

function filterUrl(input: {
  readonly sort: "new" | "popular"
  readonly q: string | null
  readonly tag: string | null
  readonly cursor?: string
}): string {
  const params = new URLSearchParams()
  params.set("sort", input.sort)
  if (input.q !== null && input.q !== "") params.set("q", input.q)
  if (input.tag !== null && input.tag !== "") params.set("tag", input.tag)
  if (input.cursor !== undefined) params.set("cursor", input.cursor)
  const query = params.toString()
  return query === "" ? EXPLORE_PATH : `${EXPLORE_PATH}?${query}`
}

/** First-page URL with the same filters but no cursor — the honest restart. */
function filtersRestartUrl(url: URL): string | null {
  if (!url.searchParams.has("cursor")) return null
  const sort = url.searchParams.get("sort") === "popular" ? "popular" : "new"
  return filterUrl({ sort, q: url.searchParams.get("q"), tag: url.searchParams.get("tag") })
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
