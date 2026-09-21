// Shared UI helpers for popup/options/work-page surfaces — ports the common.js
// formatting/parsing utilities (seconds, formatTime, formatSec,
// parseTimeInput, decodeHtmlEntities) and the legacy __dop_ system-playlist
// filter. Pure DOM-free except decodeHtmlEntities (DOMParser).
import { PLAYBACK_URL_PATH } from "../../../../packages/shared/src/limits"

/** Legacy `formatSec` (common.js:68): milliseconds → "m:ss" floored. */
export function formatSec(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

/** Legacy `parseTimeInput` (common.js:120-132): "m:ss" or seconds → ms. */
export function parseTimeInput(input: string): number | null {
  if (!input) return null
  const parts = String(input).trim().split(":")
  if (parts.length === 2) {
    const minutes = Number.parseInt(parts[0] ?? "", 10)
    const seconds = Number.parseInt(parts[1] ?? "", 10)
    if (!Number.isNaN(minutes) && !Number.isNaN(seconds)) return (minutes * 60 + seconds) * 1000
  }
  const secondsFloat = Number.parseFloat(input)
  if (!Number.isNaN(secondsFloat)) return Math.floor(secondsFloat * 1000)
  return null
}

/** Legacy `decodeHtmlEntities` (common.js:92-99): DOMParser textarea trick. */
export function decodeHtmlEntities(input: string): string {
  if (!input) return ""
  const parsed = new DOMParser().parseFromString(input, "text/html")
  return parsed.body.textContent ?? ""
}

/** Legacy `isSystemPlaylist` — `__dop_`-prefixed playlists are internal. */
export function isSystemPlaylist(playlist: { readonly name: string }): boolean {
  return playlist.name.startsWith("__dop_")
}

/** Legacy `formatRangeName`: custom name else the generic label. */
export function formatRangeName(range: { readonly name?: string | undefined } | null): string {
  if (range !== null && range.name !== undefined && range.name !== "") return range.name
  return "範囲"
}

/** Primary supported origin used when an item carries no stored url. */
export const PLAYER_ORIGIN = "https://animestore.docomo.ne.jp"

/**
 * Player URL for a stored item — prefers the saved `url` (must stay a
 * supported sc_d_pc URL per the bridge PlayerUrlSchema), else rebuilds from
 * partId on the primary origin.
 */
export function itemPlaybackUrl(item: {
  readonly partId: string
  readonly url?: string | undefined
}): string | null {
  if (item.url !== undefined && item.url !== "") {
    try {
      return new URL(item.url).toString()
    } catch {
      // fall through to the partId rebuild
    }
  }
  if (item.partId === "") return null
  return `${PLAYER_ORIGIN}${PLAYBACK_URL_PATH}?partId=${encodeURIComponent(item.partId)}`
}
