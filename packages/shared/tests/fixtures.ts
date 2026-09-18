// Synthetic characterization fixtures for task 3 (shared contracts).
// Every fixture is synthetic: no copied player bundle, no real authenticated
// HTML, no production host payloads. Plain data only — no imports from src so
// the red run fails solely on the missing contract modules.

export const MODERN_PLAYLIST = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  name: "お気に入りOP集",
  items: [
    {
      id: "123e4567-e89b-12d3-a456-426614174001",
      partId: "pt_abc-123",
      workId: "wk_456",
      title: "作品A",
      episodeTitle: "第1話",
      episodeNumber: "1",
      url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=pt_abc-123",
      range: { start: 90000, end: 180000, name: "OP" },
    },
    {
      id: "123e4567-e89b-12d3-a456-426614174002",
      partId: "pt_def-456",
      title: "作品B",
      episodeTitle: "第3話",
      episodeNumber: "3",
      url: "https://anime.dmkt-sp.jp/animestore/sc_d_pc?partId=pt_def-456",
      range: { start: 60000, end: 150000, name: "OP" },
    },
  ],
} as const

// Old name-only predecessor: range carries `type` instead of `name`.
export const TYPED_RANGE_ITEM = {
  id: "typed-item-1",
  partId: "pt_typed",
  workId: "wk_typed",
  title: "旧作",
  episodeTitle: "第2話",
  episodeNumber: "2",
  url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=pt_typed",
  range: { start: 0, end: 90000, type: "op" },
} as const

export const TYPED_RANGE_ED_ITEM = {
  id: "typed-item-2",
  partId: "pt_typed",
  title: "旧作",
  episodeTitle: "第2話",
  range: { start: 1320000, end: 1410000, type: "ed" },
} as const

export const TYPED_RANGE_CUSTOM_ITEM = {
  id: "typed-item-3",
  partId: "pt_typed",
  title: "旧作",
  episodeTitle: "第2話",
  range: { start: 600000, end: 660000, type: "custom" },
} as const

// One legacy item carrying all three historical range slots fans out to clips.
export const MULTI_RANGE_LEGACY_ITEM = {
  id: "multi-1",
  partId: "pt_multi",
  workId: "wk_multi",
  title: "三区切り作品",
  episodeTitle: "第5話",
  episodeNumber: "5",
  url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=pt_multi",
  opRange: { start: 0, end: 90000 },
  edRange: { start: 1320000, end: 1410000 },
  customRange: { start: 600000, end: 660000 },
} as const

export const NULL_RANGE_ITEM = {
  id: "null-range-1",
  partId: "pt_null",
  workId: "wk_null",
  title: "範囲未設定作品",
  episodeTitle: "第1話",
  episodeNumber: "1",
  url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=pt_null",
  range: null,
} as const

export const NULL_RANGE_PLAYLIST = {
  id: "null-range-pl",
  name: "未設定リスト",
  items: [NULL_RANGE_ITEM],
} as const

// Two clips intentionally share one id (legacy fan-out / import reuse defect).
export const DUPLICATE_ID_PLAYLIST = {
  id: "dup-pl",
  name: "重複IDリスト",
  items: [
    {
      id: "dup-shared-id",
      partId: "pt_a",
      title: "作品A",
      episodeTitle: "第1話",
      range: { start: 0, end: 90000, name: "OP" },
    },
    {
      id: "dup-shared-id",
      partId: "pt_b",
      title: "作品B",
      episodeTitle: "第1話",
      range: { start: 0, end: 90000, name: "OP" },
    },
  ],
} as const

// Mirrors the shape of test/sample_playlist.json (historical root array).
export const HISTORICAL_ROOT_ARRAY = [
  {
    id: "sample_pl_001",
    name: "お気に入りOP集",
    items: [
      {
        id: "sample_item_001",
        partId: "sample",
        workId: "sample",
        title: "作品A",
        episodeTitle: "第1話",
        url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=sample",
        range: { start: 90000, end: 180000, name: "OP" },
      },
    ],
  },
  {
    id: "sample_pl_002",
    name: "EDコレクション",
    items: [
      {
        id: "sample_item_003",
        partId: "sample",
        workId: "sample",
        title: "作品A",
        episodeTitle: "第1話",
        url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=sample",
        range: { start: 1320000, end: 1410000, name: "ED" },
      },
    ],
  },
] as const

export const FUTURE_ENVELOPE = {
  schemaVersion: 3,
  playlists: [],
} as const

export const FUTURE_SHARE = {
  schemaVersion: 2,
  title: "未来",
  description: "",
  author: "",
  tags: [],
  visibility: "public",
  items: [],
} as const

// Unicode: NFD input, case-variant tags, collapsed whitespace, breaks, injection.
export const UNICODE_SHARE_INPUT = {
  schemaVersion: 1,
  title: "  ＯＰ集  ",
  description: "一行目\n\n二行目\n<script>alert(1)</script>",
  author: "  たなか  ",
  tags: ["  OP", "op", "ＥＤ", "ed  ", "お気に入り　お気に入り"],
  visibility: "public",
  items: [
    {
      partId: "pt_uni",
      title: "かふぇ",
      episodeTitle: "[épisode]",
      episodeNumber: "１",
      range: { start: 0, end: 90000, name: "ＯＰ" },
    },
  ],
} as const

// e + combining acute (NFD) must canonicalize to é (NFC).
export const NFD_TITLE = "café"

export const MALFORMED_RANGES = {
  nan: { start: Number.NaN, end: 1000 },
  infinity: { start: 0, end: Number.POSITIVE_INFINITY },
  negative: { start: -1, end: 1000 },
  unsafeInteger: { start: 0, end: 2 ** 53 },
  endBeforeStart: { start: 5000, end: 5000 },
  endLessThanStart: { start: 9000, end: 1000 },
} as const

export const UNKNOWN_KEY_SAMPLES = {
  credentials: { password: "s3cret", sessionToken: "tok" },
  urlField: { playbackUrl: "https://evil.example/p" },
  capability: { manageSecret: "x".repeat(43) },
  publication: { publicationState: "active", importCount: 5 },
  browser: { windowId: 42, browserName: "chrome", accountId: "u1" },
} as const

export function makeRangeItems(count: number): readonly {
  readonly partId: string
  readonly title: string
  readonly episodeTitle: string
  readonly range: { readonly start: number; readonly end: number }
}[] {
  const items: {
    partId: string
    title: string
    episodeTitle: string
    range: { start: number; end: number }
  }[] = []
  for (let i = 0; i < count; i += 1) {
    items.push({
      partId: `pt_${i}`,
      title: `作品${i}`,
      episodeTitle: `第${i}話`,
      range: { start: i * 1000, end: i * 1000 + 500 },
    })
  }
  return items
}

export function makeShareBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    title: "共有リスト",
    description: "",
    author: "",
    tags: [],
    visibility: "public",
    items: [
      {
        partId: "pt_base",
        title: "作品A",
        episodeTitle: "第1話",
        range: { start: 0, end: 90000, name: "OP" },
      },
    ],
    ...overrides,
  }
}
