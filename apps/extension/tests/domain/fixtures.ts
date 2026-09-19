import type {
  LocalItem,
  LocalPlaylist,
  LocalRange,
} from "../../../../packages/shared/src/local-model"

export const OP_RANGE = { start: 90_123, end: 180_987, name: "My OP" } satisfies LocalRange

export function item(id: string, range: LocalRange | null = OP_RANGE): LocalItem {
  return {
    id,
    partId: `part-${id}`,
    workId: `work-${id}`,
    title: `Work ${id}`,
    episodeTitle: `Episode ${id}`,
    episodeNumber: id,
    url: `https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=part-${id}`,
    range,
  }
}

export function itemDraft(id: string, range: LocalRange | null = OP_RANGE): Omit<LocalItem, "id"> {
  const { id: _id, ...draft } = item(id, range)
  return draft
}

export function playlist(
  id = "playlist-1",
  itemIds: readonly string[] = ["a", "b", "c"],
): LocalPlaylist {
  return { id, name: `Playlist ${id}`, items: itemIds.map((itemId) => item(itemId)) }
}
