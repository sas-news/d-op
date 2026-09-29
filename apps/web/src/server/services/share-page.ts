import { env } from "cloudflare:workers"
import {
  collapseWhitespace,
  type DerivedFrom,
  projectPublicPlaylist,
  type SharedPlaylist,
} from "../../../../../packages/shared/src/index"
import { requireDb } from "../env"
import {
  getActiveSnapshot,
  listPublicRemixChildren,
  REMIX_PAGE_SIZE,
  type RemixChildrenPage,
} from "../repositories/snapshots/read"
import type { StoredSnapshot } from "../repositories/types"
import { parseShareIdParam } from "../security/http"
import { checkAdmission } from "./admission"
import { expirePendingProvisionals } from "./maintenance"
import { parentIsPublic } from "./publication"

// SSR view-model assembly for /p/:shareId (task 16). The page is a public
// read of the SAME active snapshot the API GET serves — SQL stays in the
// repository layer, the secret hash/secret never reach the view, and the
// source link honours the same parent-visibility projection as the API.
//
// Nonrevealing contract: absent, malformed, pending, expired-provisional,
// deleted and blocked shareIds all collapse to a single `notfound` result
// carrying no distinguishing detail. Storage failure maps to `unavailable`
// (fail-closed 503), never to a guessed page.

export const SHARE_SITE_ORIGIN = "https://d-op.sasnews.dev" as const
// Per-playlist OGP card endpoint: crawlers get a PNG, not the SVG fallback.
// The ?v= token is the content hash — republishing in place yields a new URL,
// so caches never pin a stale card to a fresh playlist.
export const shareOgImageUrl = (canonicalUrl: string, contentHash: string): string =>
  `${canonicalUrl}/og.png?v=${encodeURIComponent(contentHash.slice(0, 12))}`

export type SharePageItemView = {
  readonly index: number
  /** Popup-style lead line: `episodeNumber episodeTitle`, work title last resort. */
  readonly primaryLabel: string
  readonly title: string
  readonly episodeTitle: string
  readonly episodeNumber: string | null
  readonly rangeName: string | null
  readonly rangeLabel: string
  readonly durationLabel: string
  readonly durationMs: number
}

/** One direct Remix child (task 20): title + link + counts, nothing more. */
export type ShareRemixItemView = {
  readonly title: string
  readonly url: string
  readonly clipCount: number
  readonly publishedAtLabel: string
}

/**
 * Bounded direct-children page — no recursion, no graph. `total` counts only
 * children that are currently active+public+unblocked (checked at read time).
 */
export type ShareRemixView = {
  readonly items: readonly ShareRemixItemView[]
  readonly total: number
  readonly page: number
  readonly nextUrl: string | null
}

export type SharePageView = {
  readonly shareId: string
  readonly canonicalUrl: string
  readonly visibility: "public" | "unlisted"
  readonly title: string
  readonly description: string
  readonly author: string
  readonly tags: readonly string[]
  readonly items: readonly SharePageItemView[]
  readonly clipCount: number
  /** Per-playlist PNG card URL served from /p/:shareId/og.png. */
  readonly ogImageUrl: string
  /** Exact milliseconds — sum(end - start) over items, no tolerance padding. */
  readonly totalDurationMs: number
  readonly totalDurationLabel: string
  readonly importCount: number
  readonly publishedAtLabel: string
  readonly updatedAtLabel: string
  readonly sourceUrl: string | null
  readonly ogTitle: string
  readonly ogDescription: string
  readonly xIntentUrl: string
  readonly remix: ShareRemixView
}

export type SharePageResult =
  | { readonly kind: "ready"; readonly view: SharePageView }
  | { readonly kind: "notfound" }
  | {
      readonly kind: "unavailable"
      readonly status: 429 | 503
      readonly retryAfter: string | null
    }

/**
 * Loads the public snapshot page model. Read admission (rate limiting) is the
 * same read class the API uses; a refused/unavailable limiter becomes a
 * `unavailable` result so the page renders an honest status, never content
 * served without protection.
 */
export async function loadSharePage(
  shareIdParam: string | undefined,
  request: Request,
  requestId: string,
): Promise<SharePageResult> {
  try {
    const denied = await checkAdmission({
      env,
      request,
      requestId,
      cls: "read",
      mutation: false,
    })
    if (denied !== null) {
      return {
        kind: "unavailable",
        status: denied.status === 429 ? 429 : 503,
        retryAfter: denied.headers.get("retry-after"),
      }
    }
    const shareId = parseShareIdParam(shareIdParam)
    if (shareId === null) return { kind: "notfound" }
    const db = requireDb(env)
    await expirePendingProvisionals(db, new Date())
    const snapshot = await getActiveSnapshot(db, shareId)
    if (snapshot === null || snapshot.blocked) return { kind: "notfound" }
    if (snapshot.firstPublishedAt === null) {
      // Active rows always carry first_published_at; anything else is a
      // corrupt persisted row and must fail closed (mirrors the API GET).
      return { kind: "unavailable", status: 503, retryAfter: null }
    }
    const publishedAt = snapshot.firstPublishedAt
    const projection = projectPublicPlaylist({
      playlist: snapshot.snapshot,
      parentPublic: await parentIsPublic(db, snapshot.snapshot.derivedFrom),
    })
    const remix = await listPublicRemixChildren(db, shareId, remixPage(request))
    return {
      kind: "ready",
      view: buildView(snapshot, projection.playlist, projection.source, publishedAt, remix),
    }
  } catch {
    return { kind: "unavailable", status: 503, retryAfter: null }
  }
}

/**
 * `?remix=<n>` page selector for the direct-children list. Out-of-range or
 * malformed values fold back to page 1 — a page param never becomes an error
 * surface on a public read.
 */
function remixPage(request: Request): number {
  const raw = new URL(request.url).searchParams.get("remix")
  if (raw === null) return 1
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return 1
  return parsed
}

function buildView(
  snapshot: StoredSnapshot,
  playlist: SharedPlaylist,
  source: DerivedFrom | null,
  publishedAt: string,
  remix: RemixChildrenPage,
): SharePageView {
  const canonicalUrl = `${SHARE_SITE_ORIGIN}/p/${snapshot.shareId}`
  const items = playlist.items.map((item, index) => {
    const durationMs = item.range.end - item.range.start
    return {
      index: index + 1,
      primaryLabel:
        [item.episodeNumber ?? "", item.episodeTitle].filter(Boolean).join(" ") || item.title,
      title: item.title,
      episodeTitle: item.episodeTitle,
      episodeNumber: item.episodeNumber ?? null,
      rangeName: item.range.name ?? null,
      rangeLabel: `${formatClockMs(item.range.start)} – ${formatClockMs(item.range.end)}`,
      durationLabel: formatDurationJa(durationMs),
      durationMs,
    }
  })
  const totalDurationMs = playlist.items.reduce(
    (total, item) => total + (item.range.end - item.range.start),
    0,
  )
  const totalDurationLabel = formatDurationJa(totalDurationMs)
  const ogTitle = playlist.title
  // The Remix marker is projected with the source link: a hidden/deleted
  // parent removes the marker from OGP too, never leaving stale lineage.
  const ogDescription = `${items.length}クリップ・合計${totalDurationLabel}の共有プレイリスト${
    source === null ? "" : "（Remix）"
  }${excerptSuffix(playlist.description)}`
  const remixItems: ShareRemixItemView[] = remix.items.map((child) => ({
    title: child.title,
    url: `/p/${child.shareId}`,
    clipCount: child.itemCount,
    publishedAtLabel: formatDateJa(child.firstPublishedAt ?? child.createdAt),
  }))
  const intent = new URL("https://x.com/intent/post")
  intent.searchParams.set("url", canonicalUrl)
  intent.searchParams.set("text", `${playlist.title} | d-OP Share`)
  return {
    shareId: snapshot.shareId,
    canonicalUrl,
    visibility: snapshot.visibility,
    title: playlist.title,
    description: playlist.description,
    author: playlist.author,
    tags: playlist.tags,
    items,
    clipCount: items.length,
    totalDurationMs,
    totalDurationLabel,
    importCount: snapshot.importCount,
    publishedAtLabel: formatDateJa(publishedAt),
    updatedAtLabel: formatDateJa(snapshot.updatedAt),
    sourceUrl: source === null ? null : `/p/${source.shareId}`,
    ogTitle,
    ogDescription,
    ogImageUrl: shareOgImageUrl(canonicalUrl, snapshot.contentHash),
    xIntentUrl: intent.toString(),
    remix: {
      items: remixItems,
      total: remix.total,
      page: remix.page,
      nextUrl:
        remix.page * REMIX_PAGE_SIZE < remix.total
          ? `/p/${snapshot.shareId}?remix=${remix.page + 1}`
          : null,
    },
  }
}

const pad = (value: number, width: number): string => String(value).padStart(width, "0")

/**
 * Clock label `m:ss` / `h:mm:ss` truncated to whole seconds — share pages
 * never show sub-second precision.
 */
export function formatClockMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}`
    : `${minutes}:${pad(seconds, 2)}`
}

/** Whole-second Japanese duration: `1時間2分3秒` (sub-second tails rounded). */
export function formatDurationJa(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}時間`)
  if (minutes > 0) parts.push(`${minutes}分`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`)
  return parts.join("")
}

/** Deterministic UTC date label (`2026年9月21日`) — no locale/ICU dependence. */
export function formatDateJa(iso: string): string {
  const date = new Date(iso)
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`
}

const OG_DESCRIPTION_EXCERPT_MAX = 80 as const

/** ` — <collapsed excerpt…>` for og:description, or "" when no description. */
function excerptSuffix(description: string): string {
  if (description === "") return ""
  const collapsed = collapseWhitespace(description).trim()
  if (collapsed === "") return ""
  const excerpt =
    collapsed.length > OG_DESCRIPTION_EXCERPT_MAX
      ? `${collapsed.slice(0, OG_DESCRIPTION_EXCERPT_MAX)}…`
      : collapsed
  return ` — ${excerpt}`
}
