// Canonical tag taxonomy and the deterministic suggestion rule engine behind
// POST /api/v1/tag-suggestions (docs/tag-rules). Pure data + pure functions:
// normalization dictionaries, per-work tag derivation and the intersection
// rules for multi-work playlists. No I/O, no side effects — upstream metadata
// resolution lives in the Worker service (apps/web/src/server/services).
import { SHARE_TAG_MAX, SHARE_TAG_MIN, SHARE_TAGS_MAX, sortCanonicalTags } from "./limits"

/**
 * Raw broadcaster string -> canonical series/統一名. Local affiliates fold
 * into their network: TXN stations -> テレビ東京, ANN -> テレビ朝日,
 * NNN -> 日本テレビ, JNN -> TBS, FNN -> フジテレビ. Channels absent from the
 * map are dropped (spec: unmapped broadcasters never produce a tag).
 */
export const BROADCASTER_CANONICAL: Readonly<Record<string, string>> = {
  // TXN — テレビ東京系
  テレビ東京: "テレビ東京",
  テレビ東京系列: "テレビ東京",
  TXN: "テレビ東京",
  テレビ愛知: "テレビ東京",
  TVA: "テレビ東京",
  テレビ大阪: "テレビ東京",
  TVO: "テレビ東京",
  TVQ九州放送: "テレビ東京",
  tvq: "テレビ東京",
  テレビ北海道: "テレビ東京",
  TVh: "テレビ東京",
  テレビせとうち: "テレビ東京",
  TSC: "テレビ東京",
  BSテレ東: "テレビ東京",
  BSジャパン: "テレビ東京",
  // ANN — テレビ朝日系
  テレビ朝日: "テレビ朝日",
  テレ朝: "テレビ朝日",
  ABCテレビ: "テレビ朝日",
  ABC朝日放送テレビ: "テレビ朝日",
  朝日放送: "テレビ朝日",
  朝日放送テレビ: "テレビ朝日",
  名古屋テレビ: "テレビ朝日",
  "メ～テレ": "テレビ朝日",
  メーテレ: "テレビ朝日",
  静岡朝日テレビ: "テレビ朝日",
  広島ホームテレビ: "テレビ朝日",
  HTB: "テレビ朝日",
  北海道テレビ: "テレビ朝日",
  KBC: "テレビ朝日",
  九州朝日放送: "テレビ朝日",
  BS朝日: "テレビ朝日",
  // JNN — TBS系
  TBS: "TBS",
  TBSテレビ: "TBS",
  毎日放送: "TBS",
  MBS: "TBS",
  MBSテレビ: "TBS",
  CBCテレビ: "TBS",
  CBC: "TBS",
  中部日本放送: "TBS",
  HBC: "TBS",
  北海道放送: "TBS",
  RKB毎日放送: "TBS",
  RKB: "TBS",
  "BS-TBS": "TBS",
  // FNN — フジテレビ系
  フジテレビ: "フジテレビ",
  フジテレビジョン: "フジテレビ",
  CX: "フジテレビ",
  関西テレビ: "フジテレビ",
  カンテレ: "フジテレビ",
  KTV: "フジテレビ",
  東海テレビ: "フジテレビ",
  テレビ西日本: "フジテレビ",
  TNC: "フジテレビ",
  BSフジ: "フジテレビ",
  // NNN — 日本テレビ系
  日本テレビ: "日本テレビ",
  日テレ: "日本テレビ",
  NTV: "日本テレビ",
  読売テレビ: "日本テレビ",
  読売テレビ放送: "日本テレビ",
  ytv: "日本テレビ",
  中京テレビ: "日本テレビ",
  CTV: "日本テレビ",
  福岡放送: "日本テレビ",
  FBS: "日本テレビ",
  札幌テレビ: "日本テレビ",
  STV: "日本テレビ",
  BS日テレ: "日本テレビ",
  // NHK family folds into a single NHK tag
  NHK: "NHK",
  NHK総合: "NHK",
  NHK総合テレビ: "NHK",
  NHK教育: "NHK",
  Eテレ: "NHK",
  "NHK Eテレ": "NHK",
  "NHK BS": "NHK",
  "NHK BSプレミアム": "NHK",
  BSプレミアム: "NHK",
  "NHK BS4K": "NHK",
  "NHK BS8K": "NHK",
  // 独立局・衛星
  "TOKYO MX": "TOKYO MX",
  東京MX: "TOKYO MX",
  東京メトロポリタンテレビ: "TOKYO MX",
  MXテレビ: "TOKYO MX",
  "AT-X": "AT-X",
  ATX: "AT-X",
  BS11: "BS11",
  BSイレブン: "BS11",
  日本BS放送: "BS11",
  WOWOW: "WOWOW",
  WOWOWプライム: "WOWOW",
  WOWOWライブ: "WOWOW",
  キッズステーション: "キッズステーション",
  アニマックス: "アニマックス",
  ANIMAX: "アニマックス",
  テレビ神奈川: "テレビ神奈川",
  tvk: "テレビ神奈川",
  千葉テレビ: "千葉テレビ",
  チバテレビ: "千葉テレビ",
  テレ玉: "テレ玉",
  テレビ埼玉: "テレ玉",
  サンテレビ: "サンテレビ",
  サンテレビジョン: "サンテレビ",
  KBS京都: "KBS京都",
  京都放送: "KBS京都",
  群馬テレビ: "群馬テレビ",
  とちぎテレビ: "とちぎテレビ",
  とちテレ: "とちぎテレビ",
  岐阜放送: "岐阜放送",
  三重テレビ: "三重テレビ",
  びわ湖放送: "びわ湖放送",
  奈良テレビ: "奈良テレビ",
  テレビ和歌山: "テレビ和歌山",
  BSフジテレビ: "フジテレビ",
  ディズニーXD: "ディズニーXD",
  カートゥーン: "カートゥーン",
}

/** AniList/Jikan demographic name -> canonical 対象層 tag. Direct map only —
 *  unmapped demographics are dropped; nothing is ever synthesized (spec: no
 *  女児向け-style synthesis rules). */
export const DEMOGRAPHIC_MAP: Readonly<Record<string, string>> = {
  Shounen: "少年",
  Shoujo: "少女",
  Seinen: "青年",
  Josei: "女性",
  Kids: "キッズ",
}

/** AniList genre (EN) -> canonical 和名. Unmapped genres are dropped, and
 *  adult-adjacent labels such as "Ecchi" are deliberately absent so they can
 *  never become a tag. */
export const GENRE_JP_MAP: Readonly<Record<string, string>> = {
  Action: "アクション",
  Adventure: "アドベンチャー",
  Comedy: "コメディ",
  Drama: "ドラマ",
  Fantasy: "ファンタジー",
  "Sci-Fi": "SF",
  "Mahou Shoujo": "魔法少女",
  Mecha: "ロボット",
  "Slice of Life": "日常",
  Sports: "スポーツ",
  Supernatural: "超常現象",
  Mystery: "ミステリー",
  Horror: "ホラー",
  Romance: "恋愛",
  Music: "音楽",
  Psychological: "心理",
  Thriller: "スリラー",
}

/** AniList MediaSource -> canonical 原作媒体 tag; everything else drops. */
export const SOURCE_MAP: Readonly<Record<string, string>> = {
  MANGA: "漫画原作",
  LIGHT_NOVEL: "ラノベ原作",
  NOVEL: "ラノベ原作",
  VIDEO_GAME: "ゲーム原作",
  VISUAL_NOVEL: "ゲーム原作",
  ORIGINAL: "オリジナル",
}

/** Common studio names -> readable canonical short form. Partial coverage by
 *  design: a dictionary miss keeps the API-supplied name as the tag (spec:
 *  短形が取れないなら長いままOK — never dropped). */
export const STUDIO_SHORT_MAP: Readonly<Record<string, string>> = {
  "Toei Animation": "東映アニメ",
  "Kyoto Animation": "京都アニメ",
  "A-1 Pictures": "A-1 Pictures",
  Sunrise: "サンライズ",
  "Bandai Namco Filmworks": "サンライズ",
  "Bandai Namco Pictures": "バンダイナムコピクチャーズ",
  Bones: "ボンズ",
  Madhouse: "マッドハウス",
  "Wit Studio": "WIT STUDIO",
  MAPPA: "MAPPA",
  Trigger: "TRIGGER",
  Shaft: "シャフト",
  "J.C.Staff": "J.C.STAFF",
  Pierrot: "ぴえろ",
  OLM: "OLM",
  "TMS Entertainment": "トムス・エンタテインメント",
  "Nippon Animation": "日本アニメーション",
  "Tatsunoko Production": "タツノコプロ",
  "Studio Ghibli": "スタジオジブリ",
  CloverWorks: "CloverWorks",
  "Doga Kobo": "動画工房",
  "David Production": "david production",
  Artland: "アートランド",
  ufotable: "ufotable",
  "Production I.G": "Production I.G",
  "P.A.Works": "P.A.WORKS",
  "White Fox": "WHITE FOX",
  "Studio Deen": "スタジオディーン",
  Gainax: "ガイナックス",
  Gonzo: "GONZO",
  "Brain's Base": "ブレインズ・ベース",
  Satelight: "サテライト",
  "LIDEN FILMS": "ライデンフィルム",
  "Eight Bit": "エイトビット",
  "Studio Bind": "スタジオバインド",
}

/** Server-resolved metadata for one work — the engine's only input. Rows with
 *  `matched: false` are excluded from the multi-work intersection denominator
 *  and contribute no per-work tags. */
export type WorkTagMeta = {
  readonly title: string
  readonly workId?: string | undefined
  readonly matched: boolean
  readonly year?: number | undefined
  readonly broadcasters: readonly string[]
  readonly demographics: readonly string[]
  readonly studios: readonly string[]
  readonly source?: string | undefined
  readonly magazine?: string | undefined
  readonly genres: readonly string[]
}

/** Dictionary lookup key: NFKC + case-folded + whitespace-collapsed. */
function dictKey(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()
}

function lookupMap(map: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  const lookup = new Map<string, string>()
  for (const [raw, canonical] of Object.entries(map)) {
    lookup.set(dictKey(raw), canonical)
  }
  return lookup
}

const BROADCASTER_LOOKUP = lookupMap(BROADCASTER_CANONICAL)
const DEMOGRAPHIC_LOOKUP = lookupMap(DEMOGRAPHIC_MAP)
const GENRE_LOOKUP = lookupMap(GENRE_JP_MAP)
const SOURCE_LOOKUP = lookupMap(SOURCE_MAP)
const STUDIO_LOOKUP = lookupMap(STUDIO_SHORT_MAP)

/**
 * Title key used both for upstream match equality and the D1 cache key:
 * NFKC, case-folded, with whitespace and ornament/punctuation stripped, so
 * "フレッシュプリキュア！" and "フレッシュプリキュア" collide into one row.
 */
const TITLE_KEY_DROP =
  /[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~・ｰ･‥…〜～☆★♪♥「」『』【】〈〉《》（）［］、。！？：；．]/gu

export function normalizeWorkTitleKey(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(TITLE_KEY_DROP, "")
}

/** Strips whitespace and decoration characters for series-name extraction. */
const SERIES_DECORATION_DROP = /[\s☆★♪♥！!?・･]/gu

export function stripTitleDecorations(title: string): string {
  return title.normalize("NFKC").replace(SERIES_DECORATION_DROP, "")
}

// --- per-work axis derivation ------------------------------------------------

type WorkAxes = {
  readonly demographics: string[]
  readonly broadcasters: string[]
  readonly year: string[]
  readonly studios: string[]
  readonly source: string[]
  readonly magazine: string[]
  readonly genres: string[]
}

function mappedValues(raw: readonly string[], lookup: ReadonlyMap<string, string>): string[] {
  const out = new Set<string>()
  for (const value of raw) {
    const canonical = lookup.get(dictKey(value))
    if (canonical !== undefined) out.add(canonical)
  }
  return [...out]
}

/** Studio names: short-map when known, keep the API name otherwise. */
function studioValues(raw: readonly string[]): string[] {
  const out = new Set<string>()
  for (const value of raw) {
    const trimmed = value.trim()
    if (trimmed === "") continue
    out.add(STUDIO_LOOKUP.get(dictKey(trimmed)) ?? trimmed)
  }
  return [...out]
}

function workAxes(work: WorkTagMeta): WorkAxes {
  return {
    demographics: mappedValues(work.demographics, DEMOGRAPHIC_LOOKUP),
    broadcasters: mappedValues(work.broadcasters, BROADCASTER_LOOKUP),
    year: work.year !== undefined ? [`${work.year}年`] : [],
    studios: studioValues(work.studios),
    source: work.source !== undefined ? mappedValues([work.source], SOURCE_LOOKUP) : [],
    magazine: work.magazine !== undefined && work.magazine.trim() !== "" ? [work.magazine] : [],
    genres: mappedValues(work.genres, GENRE_LOOKUP),
  }
}

/**
 * The flat canonical tag list a single work contributes (all axes, sorted).
 * Exported so the API can describe per-work matches without re-deriving them.
 */
export function workTagSet(work: WorkTagMeta): string[] {
  const axes = workAxes(work)
  const all = [
    ...axes.demographics,
    ...axes.broadcasters,
    ...axes.year,
    ...axes.studios,
    ...axes.source,
    ...axes.magazine,
    ...axes.genres,
  ]
  return filterTagLength(sortCanonicalTags(all))
}

function intersectAll(axisValues: readonly (readonly string[])[]): string[] {
  const first = axisValues[0]
  if (first === undefined || first.length === 0) return []
  return first.filter((tag) => axisValues.every((tags) => tags.includes(tag)))
}

/**
 * Longest substring shared by every stripped title — the series tag
 * ("プリキュア" across フレッシュプリキュア！/ハートキャッチプリキュア！).
 * Requires at least two DISTINCT normalized titles: a playlist of one work
 * repeated is the same work, not a series.
 */
function commonSeriesName(titles: readonly string[]): string | null {
  const stripped = [
    ...new Set(
      titles.map((title) => stripTitleDecorations(title).toLowerCase()).filter((t) => t !== ""),
    ),
  ]
  if (stripped.length < 2) return null
  let shortest = stripped[0] as string
  for (const title of stripped) {
    if (title.length < shortest.length) shortest = title
  }
  for (let length = shortest.length; length >= 2; length -= 1) {
    for (let start = 0; start + length <= shortest.length; start += 1) {
      const candidate = shortest.slice(start, start + length)
      if (stripped.every((title) => title.includes(candidate))) return candidate
    }
  }
  return null
}

/** Canonical tags must satisfy the share-tag length budget after folding. */
function filterTagLength(tags: readonly string[]): string[] {
  return tags.filter((tag) => tag.length >= SHARE_TAG_MIN && tag.length <= SHARE_TAG_MAX)
}

/**
 * The suggestion rule: a single work contributes every axis it has; multiple
 * works intersect each axis so only tags common to EVERY matched work survive
 * (the year axis drops naturally when years differ). The series axis is
 * derived from the longest common title substring. Axis priority for the
 * 10-tag cap: 層 → 放送局 → 年 → シリーズ → スタジオ → 原作 → 掲載誌 → ジャンル
 * (op/ed区分 is the extension's own axis and is not emitted here).
 */
export function suggestPlaylistTags(works: readonly WorkTagMeta[]): string[] {
  const matched = works.filter((work) => work.matched)
  if (matched.length === 0) return []
  const axes = matched.map(workAxes)
  const axisValues = (key: keyof WorkAxes): string[] =>
    sortCanonicalTags(intersectAll(axes.map((work) => work[key])))
  const series = commonSeriesName(matched.map((work) => work.title))
  const picked = [
    ...axisValues("demographics"),
    ...axisValues("broadcasters"),
    ...axisValues("year"),
    ...(series === null ? [] : [series]),
    ...axisValues("studios"),
    ...axisValues("source"),
    ...axisValues("magazine"),
    ...axisValues("genres"),
  ].slice(0, SHARE_TAGS_MAX)
  return filterTagLength(sortCanonicalTags(picked))
}
