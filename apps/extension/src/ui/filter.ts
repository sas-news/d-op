// Shared filter matching for the popup picker and the options playlist list.
// Queries match the playlist name plus an item's work title / episode title /
// episode number; entities are decoded so the user searches what is displayed.

import type { LocalItem, LocalPlaylist } from "../../../../packages/shared/src/local-model"
import { decodeHtmlEntities } from "./format"

export function normalizeFilterQuery(query: string): string {
  return query.trim().toLowerCase()
}

function includesQuery(value: string | undefined, query: string): boolean {
  if (value === undefined || value === "") return false
  return decodeHtmlEntities(value).toLowerCase().includes(query)
}

export function itemMatchesFilter(item: LocalItem, query: string): boolean {
  if (query === "") return true
  return (
    includesQuery(item.title, query) ||
    includesQuery(item.episodeTitle, query) ||
    includesQuery(item.episodeNumber, query)
  )
}

export function playlistMatchesFilter(playlist: LocalPlaylist, query: string): boolean {
  if (query === "") return true
  return playlist.name.toLowerCase().includes(query)
}
