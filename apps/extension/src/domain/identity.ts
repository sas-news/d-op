import type { LocalPlaylist } from "../../../../packages/shared/src/local-model"

export type DuplicateIdentity = {
  readonly kind: "duplicate-id"
  readonly entity: "playlist" | "item"
  readonly id: string
}

export function findDuplicateIdentity(
  playlists: readonly LocalPlaylist[],
): DuplicateIdentity | null {
  const playlistIds = new Set<string>()
  const itemIds = new Set<string>()
  for (const playlist of playlists) {
    if (playlistIds.has(playlist.id)) {
      return { kind: "duplicate-id", entity: "playlist", id: playlist.id }
    }
    playlistIds.add(playlist.id)
    for (const item of playlist.items) {
      if (itemIds.has(item.id)) return { kind: "duplicate-id", entity: "item", id: item.id }
      itemIds.add(item.id)
    }
  }
  return null
}

export function findDuplicateId(ids: readonly string[]): string | null {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) return id
    seen.add(id)
  }
  return null
}
