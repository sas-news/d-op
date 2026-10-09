// Local-only tag suggestions for the share dialog's タグ候補 button.
// Everything here is deterministic and offline: the OP/ED kind tag is
// inferred from the playlist title, and artist tags are extracted from the
// trailing "（歌手名）"/"(artist)" suffix of each ranged item's range.name.
// Remote taxonomy suggestions arrive separately through the background's
// POST /api/v1/tag-suggestions call — never from this module — and both are
// canonical-merged with the user's typed tags before prefilling the input.
import {
  collapseWhitespace,
  SHARE_TAG_MAX,
  SHARE_TAGS_MAX,
  sortCanonicalTags,
} from "../../../../packages/shared/src/limits"
import type { PublishableLocalPlaylist } from "../../../../packages/shared/src/share-projection"

export type SuggestablePlaylist = Pick<PublishableLocalPlaylist, "name" | "items">

/** Same folding sortCanonicalTags applies, for priority-order dedup. */
function foldTag(tag: string): string {
  return collapseWhitespace(tag.normalize("NFC").trim()).toLocaleLowerCase("en")
}

/**
 * Kind tag from the playlist title: OP/オープニング markers → "op",
 * ED/エンディング markers → "ed", both (or the fused "OPED") → "oped".
 * ASCII markers match on word boundaries so "FRIENDS" or "Co-Op"-style
 * false positives are impossible; Japanese markers are substring checks.
 */
function inferKindTag(name: string): "op" | "ed" | "oped" | undefined {
  const title = name.normalize("NFC")
  const fused = /\bOPED\b/i.test(title)
  const op = fused || /\bOP\b/i.test(title) || title.includes("オープニング")
  const ed = fused || /\bED\b/i.test(title) || title.includes("エンディング")
  if (op && ed) return "oped"
  if (op) return "op"
  if (ed) return "ed"
  return undefined
}

/**
 * Artist from a range name's TRAILING parenthesized group — "My OP
 * (YOASOBI)" or "ED（Official髭男dism）" — full- and half-width parens both
 * accepted. Mid-string parens, empty groups and over-tag-max names are not
 * artist candidates.
 */
function extractArtist(rangeName: string): string | undefined {
  const match = /[（(]([^（）()]+)[）)]\s*$/.exec(rangeName.normalize("NFC"))
  const artist = match?.[1]?.trim()
  if (artist === undefined || artist.length === 0 || artist.length > SHARE_TAG_MAX) {
    return undefined
  }
  return artist
}

/** Kind tag first, then deduped artist tags in playlist order. */
export function suggestLocalTags(playlist: SuggestablePlaylist): string[] {
  const tags: string[] = []
  const seen = new Set<string>()
  const push = (tag: string): void => {
    const key = foldTag(tag)
    if (seen.has(key)) return
    seen.add(key)
    tags.push(tag)
  }
  const kind = inferKindTag(playlist.name)
  if (kind !== undefined) push(kind)
  for (const item of playlist.items) {
    const name = item.range?.name
    if (name === undefined) continue
    const artist = extractArtist(name)
    if (artist !== undefined) push(artist)
  }
  return tags
}

/**
 * Canonical union merge for the tags input: user-typed tags first, then the
 * API's suggestions, then the local heuristics. sortCanonicalTags folds,
 * dedups (first occurrence wins) and sorts; the result is capped at
 * SHARE_TAGS_MAX so the field never exceeds the publish limit.
 */
export function mergeTagSuggestions(
  current: readonly string[],
  suggested: readonly string[],
  local: readonly string[],
): string[] {
  return sortCanonicalTags([...current, ...suggested, ...local]).slice(0, SHARE_TAGS_MAX)
}
