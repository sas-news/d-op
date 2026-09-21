import type { LocalItem } from "../../../../packages/shared/src/local-model"

export const NOW = "2026-09-19T12:00:00.000Z"

export function operationId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
}

export function localItem(id: string): LocalItem {
  return {
    id,
    partId: `part-${id}`,
    workId: `work-${id}`,
    title: `Work ${id}`,
    episodeTitle: `Episode ${id}`,
    episodeNumber: id,
    url: `https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=part-${id}`,
    range: { start: 90_123, end: 180_987, name: "Custom OP" },
  }
}
