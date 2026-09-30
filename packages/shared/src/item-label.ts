// Item lead-line label shared by the extension popup/options rows and the
// Share web clip list: the episode leads, the work title drops to the sub.

export type ItemLabelFields = {
  readonly title: string
  readonly episodeTitle: string
  readonly episodeNumber?: string | undefined
}

/**
 * Lead line for an item row: `episodeNumber episodeTitle`, the number dropped
 * when the title already opens with it (`第1話`, `1話`, `1 …`), falling back
 * to the work title and finally a placeholder.
 */
export function episodeLeadLabel(item: ItemLabelFields): string {
  const num = item.episodeNumber ?? ""
  const prefix = num !== "" && !episodeNumberLeads(item.episodeTitle, num) ? num : ""
  return [prefix, item.episodeTitle].filter(Boolean).join(" ") || item.title || "(タイトル不明)"
}

/** The title already opens with the episode number: `第{n}話`, `{n}…`, `{n}話…`. */
function episodeNumberLeads(episodeTitle: string, episodeNumber: string): boolean {
  if (episodeTitle === episodeNumber) return true
  // The number counts as a repeated prefix when a separator follows it
  // ("第3話「始まり」", "3: 出発") but not when the title merely continues
  // the token ("第3話後編", "10話").
  if (
    episodeTitle.startsWith(episodeNumber) &&
    /^[\p{P}\p{S}\p{Z}]/u.test(episodeTitle.slice(episodeNumber.length))
  ) {
    return true
  }
  if (episodeTitle.startsWith(`第${episodeNumber}話`)) return true
  // A leading digit run counts only when it IS the number: `1` claims
  // `1話`/`1.5話` but not `10話`.
  return /^\d+$/.test(episodeNumber) && /^\d+/.exec(episodeTitle)?.[0] === episodeNumber
}
