import { env } from "cloudflare:workers"
import {
  collapseWhitespace,
  type DerivedFrom,
  projectPublicPlaylist,
  type SharedPlaylist,
} from "../../../../../packages/shared/src/index"
import { requireDb } from "../env"
import { getActiveSnapshot } from "../repositories/snapshots/read"
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
export const SHARE_OG_IMAGE_URL = `${SHARE_SITE_ORIGIN}/og-share.svg` as const

export type SharePageItemView = {
  readonly index: number
  readonly title: string
  readonly episodeTitle: string
  readonly episodeNumber: string | null
  readonly rangeName: string | null
  readonly rangeLabel: string
  readonly durationLabel: string
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
    return {
      kind: "ready",
      view: buildView(snapshot, projection.playlist, projection.source, publishedAt),
    }
  } catch {
    return { kind: "unavailable", status: 503, retryAfter: null }
  }
}

function buildView(
  snapshot: StoredSnapshot,
  playlist: SharedPlaylist,
  source: DerivedFrom | null,
  publishedAt: string,
): SharePageView {
  const canonicalUrl = `${SHARE_SITE_ORIGIN}/p/${snapshot.shareId}`
  const items = playlist.items.map((item, index) => {
    const durationMs = item.range.end - item.range.start
    return {
      index: index + 1,
      title: item.title,
      episodeTitle: item.episodeTitle,
      episodeNumber: item.episodeNumber ?? null,
      rangeName: item.range.name ?? null,
      rangeLabel: `${formatClockMs(item.range.start)} – ${formatClockMs(item.range.end)}`,
      durationLabel: formatDurationJa(durationMs),
    }
  })
  const totalDurationMs = playlist.items.reduce(
    (total, item) => total + (item.range.end - item.range.start),
    0,
  )
  const totalDurationLabel = formatDurationJa(totalDurationMs)
  const ogTitle = playlist.title
  const ogDescription = `${items.length}クリップ・合計${totalDurationLabel}の共有プレイリスト${excerptSuffix(
    playlist.description,
  )}`
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
    xIntentUrl: intent.toString(),
  }
}

const pad = (value: number, width: number): string => String(value).padStart(width, "0")

/**
 * Exact clock label `m:ss` / `h:mm:ss` with a `.mmm` suffix when the value
 * carries sub-second precision — never rounded, never padded by the player
 * tail tolerance.
 */
export function formatClockMs(ms: number): string {
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  const millis = ms % 1000
  const base =
    hours > 0 ? `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}` : `${minutes}:${pad(seconds, 2)}`
  return millis > 0 ? `${base}.${pad(millis, 3)}` : base
}

/** Exact Japanese duration: `1時間2分3秒`, with `.mmm` for sub-second tails. */
export function formatDurationJa(ms: number): string {
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  const millis = ms % 1000
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}時間`)
  if (minutes > 0) parts.push(`${minutes}分`)
  if (seconds > 0 || millis > 0 || parts.length === 0) {
    parts.push(millis > 0 ? `${seconds}.${pad(millis, 3)}秒` : `${seconds}秒`)
  }
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
