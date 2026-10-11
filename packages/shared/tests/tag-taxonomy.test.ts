// Tag taxonomy: normalization dictionaries and the suggestion rule engine.
import {
  BROADCASTER_CANONICAL,
  DEMOGRAPHIC_MAP,
  GENRE_JP_MAP,
  normalizeWorkTitleKey,
  SOURCE_MAP,
  STUDIO_SHORT_MAP,
  stripTitleDecorations,
  suggestPlaylistTags,
  type WorkTagMeta,
  workTagSet,
} from "@d-op/shared"
import { describe, expect, it } from "vitest"

function meta(overrides: Partial<WorkTagMeta> & { title: string }): WorkTagMeta {
  return {
    matched: true,
    broadcasters: [],
    demographics: [],
    studios: [],
    genres: [],
    ...overrides,
  }
}

describe("normalization dictionaries", () => {
  it("folds affiliate broadcasters into their canonical network names", () => {
    // Given: works carrying raw しょぼカル FirstCh strings.
    // Then: affiliates collapse to the network統一名; unmapped channels drop.
    const tags = workTagSet(
      meta({
        title: "w",
        broadcasters: ["ABCテレビ", "テレビ朝日", "テレビ愛知", "tvq", "謎のチャンネル"],
      }),
    )
    expect(tags).toContain("テレビ朝日")
    expect(tags).toContain("テレビ東京")
    expect(tags).not.toContain("abcテレビ")
    expect(tags).not.toContain("テレビ愛知")
    expect(tags).not.toContain("謎のチャンネル")
    // "ABCテレビ、テレビ朝日" is ONE raw string only after splitting
    // upstream-side; here the canonical name dedupes to a single tag.
    expect(tags.filter((t) => t === "テレビ朝日")).toHaveLength(1)
  })

  it("maps demographics directly and never synthesizes unmapped layers", () => {
    const tags = workTagSet(meta({ title: "w", demographics: ["Shounen", "Kids", "女児"] }))
    expect(tags).toContain("少年")
    expect(tags).toContain("キッズ")
    // No synthesis rules: unmapped demographics are dropped, never guessed.
    expect(tags).not.toContain("女児向け")
    expect(tags).not.toContain("女児")
  })

  it("maps genres to canonical 和名 and drops unmapped/adult labels", () => {
    const tags = workTagSet(
      meta({ title: "w", genres: ["Action", "Mahou Shoujo", "Ecchi", "Not A Genre"] }),
    )
    expect(tags).toContain("アクション")
    expect(tags).toContain("魔法少女")
    expect(tags).not.toContain("ecchi")
    expect(tags).not.toContain("not a genre")
  })

  it("maps sources to 原作媒体 tags and drops the rest", () => {
    expect(workTagSet(meta({ title: "w", source: "MANGA" }))).toContain("漫画原作")
    expect(workTagSet(meta({ title: "w", source: "LIGHT_NOVEL" }))).toContain("ラノベ原作")
    expect(workTagSet(meta({ title: "w", source: "VIDEO_GAME" }))).toContain("ゲーム原作")
    expect(workTagSet(meta({ title: "w", source: "ORIGINAL" }))).toContain("オリジナル")
    expect(workTagSet(meta({ title: "w", source: "WEB_NOVEL" }))).toHaveLength(0)
  })

  it("short-maps known studios and keeps unknown API names as-is", () => {
    const tags = workTagSet(
      meta({ title: "w", studios: ["Toei Animation", "Kyoto Animation", "Some Obscure Studio"] }),
    )
    expect(tags).toContain("東映アニメ")
    expect(tags).toContain("京都アニメ")
    // Dictionary miss keeps the API name (canonical form folds case).
    expect(tags).toContain("some obscure studio")
  })
})

describe("title normalization", () => {
  it("collides decorated/fullwidth spellings into one key", () => {
    expect(normalizeWorkTitleKey("フレッシュプリキュア！")).toBe(
      normalizeWorkTitleKey("フレッシュプリキュア"),
    )
    expect(normalizeWorkTitleKey("ＲＥＢＯＲＮ！")).toBe(normalizeWorkTitleKey("reborn"))
    expect(normalizeWorkTitleKey("ハートキャッチ プリキュア！")).toBe(
      normalizeWorkTitleKey("ハートキャッチプリキュア"),
    )
  })

  it("strips decorations for series extraction", () => {
    expect(stripTitleDecorations("スイートプリキュア♪")).toBe("スイートプリキュア")
  })
})

describe("suggestPlaylistTags", () => {
  it("returns every axis for a single matched work", () => {
    const tags = suggestPlaylistTags([
      meta({
        title: "家庭教師ヒットマンREBORN!",
        year: 2006,
        broadcasters: ["テレビ東京"],
        demographics: ["Shounen"],
        studios: ["Artland"],
        source: "MANGA",
        magazine: "週刊少年ジャンプ",
        genres: ["Action", "Comedy"],
      }),
    ])
    expect(tags).toEqual([
      "2006年",
      "アクション",
      "アートランド",
      "コメディ",
      "テレビ東京",
      "少年",
      "漫画原作",
      "週刊少年ジャンプ",
    ])
  })

  it("intersects axes across works — differing years drop naturally", () => {
    const fresh = meta({
      title: "フレッシュプリキュア！",
      year: 2009,
      broadcasters: ["ABCテレビ", "テレビ朝日"],
      demographics: ["Kids"],
      studios: ["Toei Animation"],
      source: "ORIGINAL",
    })
    const heartcatch = meta({
      title: "ハートキャッチプリキュア！",
      year: 2010,
      broadcasters: ["朝日放送", "テレビ朝日"],
      demographics: ["Kids"],
      studios: ["Toei Animation"],
      source: "ORIGINAL",
    })
    const tags = suggestPlaylistTags([fresh, heartcatch])
    expect(tags).toContain("プリキュア") // series tag from the common title substring
    expect(tags).toContain("テレビ朝日")
    expect(tags).toContain("キッズ")
    expect(tags).toContain("東映アニメ")
    expect(tags).toContain("オリジナル")
    expect(tags.filter((t) => /^\d{4}年$/.test(t))).toHaveLength(0)
    expect(tags).toHaveLength(5)
  })

  it("emits no series tag for a repeated identical work or disjoint titles", () => {
    const reborn = meta({ title: "家庭教師ヒットマンREBORN!", broadcasters: ["テレビ東京"] })
    expect(suggestPlaylistTags([reborn, reborn])).not.toContain(
      "家庭教師ヒットマンREBORN!".toLowerCase(),
    )
    const disjoint = suggestPlaylistTags([
      meta({ title: "AAAA", broadcasters: ["テレビ東京"] }),
      meta({ title: "BBBB", broadcasters: ["テレビ東京"] }),
    ])
    expect(disjoint).toEqual(["テレビ東京"])
  })

  it("excludes unmatched works from the intersection denominator", () => {
    const matched = meta({
      title: "w1",
      year: 2006,
      broadcasters: ["テレビ東京"],
      demographics: ["Shounen"],
    })
    const unmatched = meta({
      title: "w2",
      matched: false,
      broadcasters: ["TBS"], // must not leak: unmatched axes never count
      demographics: ["Josei"],
    })
    const tags = suggestPlaylistTags([matched, unmatched])
    expect(tags).toContain("テレビ東京")
    expect(tags).toContain("少年")
    expect(tags).toContain("2006年")
    expect(tags).not.toContain("tbs")
    expect(tags).not.toContain("女性")
  })

  it("returns no tags when nothing matched upstream", () => {
    expect(
      suggestPlaylistTags([
        meta({ title: "w1", matched: false, broadcasters: ["TBS"] }),
        meta({ title: "w2", matched: false, broadcasters: ["TBS"] }),
      ]),
    ).toEqual([])
  })

  it("caps suggestions at 10 following the axis priority order", () => {
    const tags = suggestPlaylistTags([
      meta({
        title: "w",
        year: 2006,
        broadcasters: ["テレビ東京", "テレビ朝日"],
        demographics: ["Shounen"],
        studios: ["Toei Animation"],
        source: "MANGA",
        magazine: "週刊少年ジャンプ",
        genres: ["Action", "Comedy", "Drama", "Fantasy", "Horror", "Music"],
      }),
    ])
    // 1 demographic + 2 broadcasters + 1 year + 1 studio + 1 source + 1 magazine
    // = 7 high-priority tags; genres fill the remaining 3 slots.
    expect(tags).toHaveLength(10)
    expect(tags).toContain("少年")
    expect(tags).toContain("テレビ東京")
    expect(tags).toContain("テレビ朝日")
    expect(tags).toContain("2006年")
    expect(tags).toContain("東映アニメ")
    expect(tags).toContain("漫画原作")
    expect(tags).toContain("週刊少年ジャンプ")
    const genres = tags.filter((t) =>
      [
        "アクション",
        "アドベンチャー",
        "コメディ",
        "ドラマ",
        "ファンタジー",
        "ホラー",
        "音楽",
      ].includes(t),
    )
    expect(genres).toHaveLength(3)
  })

  it("keeps tags inside the canonical 24-char budget", () => {
    const tags = suggestPlaylistTags([
      meta({
        title: "w",
        studios: [`A Very Long Studio Name That Exceeds The Limit ${"x".repeat(40)}`],
      }),
    ])
    expect(tags).toEqual([])
  })

  it("exposes the canonical dictionaries", () => {
    expect(BROADCASTER_CANONICAL["ABCテレビ"]).toBe("テレビ朝日")
    expect(DEMOGRAPHIC_MAP["Shounen"]).toBe("少年")
    expect(GENRE_JP_MAP["Sci-Fi"]).toBe("SF")
    expect(SOURCE_MAP["MANGA"]).toBe("漫画原作")
    expect(STUDIO_SHORT_MAP["Toei Animation"]).toBe("東映アニメ")
  })
})
