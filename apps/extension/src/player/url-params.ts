// dop* URL parameter handling — ports the two navigation schemes that must
// stay separate (docs/current-extension-behavior.md section 8):
//   a) playlist mode:   dopPlaylistId + dopIndex   (content.js:208-211)
//   b) work-page op-ed: dopRangeIndex + dopTitle + dopEpisodeTitle
// Legacy removed them via history.replaceState before acting
// (content.js:393,403) so a reload never re-triggers the handoff.
import { PLAYBACK_URL_PATH, SUPPORTED_ORIGINS } from "../../../../packages/shared/src/limits"
import { PLAYER_URL_PARAM_KEYS } from "./constants"

export type PlayerUrlParams = {
  readonly partId: string | null
  readonly playlistId: string | null
  readonly playlistIndex: number | null
  readonly rangeIndex: number | null
  readonly workTitle: string
  readonly episodeTitle: string
}

function parseIndex(raw: string | null): number | null {
  if (raw === null) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

/** Read every dop* param plus partId. Malformed indexes parse as null. */
export function readPlayerUrlParams(href: string): PlayerUrlParams {
  const url = new URL(href)
  const params = url.searchParams
  return {
    partId: params.get("partId"),
    playlistId: params.get("dopPlaylistId"),
    playlistIndex: parseIndex(params.get("dopIndex")),
    rangeIndex: parseIndex(params.get("dopRangeIndex")),
    workTitle: params.get("dopTitle") ?? "",
    episodeTitle: params.get("dopEpisodeTitle") ?? "",
  }
}

/** Strip all dop* params, preserving the rest (legacy removeDopParamsFromUrl). */
export function stripPlayerUrlParams(href: string): string {
  const url = new URL(href)
  for (const key of PLAYER_URL_PARAM_KEYS) url.searchParams.delete(key)
  return url.toString()
}

/**
 * Cross-episode playlist navigation URL — legacy goToPlaylistItem sets
 * dopPlaylistId + dopIndex (real index into playlist.items) on the item URL
 * (content.js:317-328).
 */
export function buildPlaylistItemUrl(
  itemUrl: string,
  playlistId: string,
  itemIndex: number,
): string {
  const url = new URL(itemUrl)
  url.searchParams.set("dopPlaylistId", playlistId)
  url.searchParams.set("dopIndex", String(itemIndex))
  return url.toString()
}

/**
 * Is this URL a d-Anime player page? Ports legacy isDAnimeUrl
 * (background.js:12-14) which required `sc_d_pc?` — a query string must be
 * present for a tab to count as a live player surface.
 */
export function isPlayerPageUrl(rawUrl: string | undefined): boolean {
  if (rawUrl === undefined) return false
  try {
    const url = new URL(rawUrl)
    return (
      SUPPORTED_ORIGINS.includes(url.origin as (typeof SUPPORTED_ORIGINS)[number]) &&
      url.pathname === PLAYBACK_URL_PATH &&
      url.search.length > 0
    )
  } catch {
    return false
  }
}
