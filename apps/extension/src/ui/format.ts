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

/** Edit-surface formatter: milliseconds → "m:ss.s" (100 ms precision, floored).
 *  Whole-second displays keep using `formatSec`; only edit UIs/steppers show
 *  the tenths so no existing list/count rendering changes. */
export function formatSecTenths(ms: number): string {
  const totalTenths = Math.max(0, Math.floor(ms / 100))
  const minutes = Math.floor(totalTenths / 600)
  const seconds = Math.floor(totalTenths / 10) % 60
  const tenths = totalTenths % 10
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}`
}

/** Round a seconds value to the 100 ms editing grid before converting to ms. */
function secondsToEditingMs(seconds: number): number {
  return Math.round(seconds * 10) * 100
}

/** Legacy `parseTimeInput` (common.js:120-132) plus sub-second support:
 *  "m:ss", "m:ss.s" and raw seconds → ms rounded to 100 ms steps. */
export function parseTimeInput(input: string): number | null {
  if (!input) return null
  const text = String(input).trim()
  if (text === "") return null
  const parts = text.split(":")
  if (parts.length === 2) {
    const minutes = Number.parseInt(parts[0] ?? "", 10)
    const seconds = Number.parseFloat(parts[1] ?? "")
    if (!Number.isNaN(minutes) && !Number.isNaN(seconds)) {
      return secondsToEditingMs(minutes * 60 + seconds)
    }
  }
  const secondsFloat = Number.parseFloat(text)
  if (!Number.isNaN(secondsFloat)) return secondsToEditingMs(secondsFloat)
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
