import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { TagSuggestionResponseSchema } from "../../../../packages/shared/src/index"
import { ALL as allRoute, POST as postRoute } from "../../src/pages/api/v1/tag-suggestions.js"
import { suggestTags } from "../../src/server/services/tag-suggest.js"
import {
  anilistMedia,
  anilistPage,
  call,
  dataOf,
  errorOf,
  fakeLimiter,
  jikanAnimeList,
  jikanManga,
  migratedDb,
  stubUpstreams,
  syoboiTitles,
  tagRequest,
  withLimiters,
} from "./helpers.js"

// POST /api/v1/tag-suggestions: happy path + axis assembly, multi-work
// intersection, unmatched handling, cache behavior, intake failures and the
// shared admission contract. All upstream traffic is stubbed through the
// service's injectable fetch — no real origins in tests.

const REBORN_ANILIST = anilistPage([
  anilistMedia({
    id: 1604,
    title: {
      native: "家庭教師ヒットマンREBORN!",
      romaji: "Katekyo Hitman Reborn!",
      english: "Reborn!",
    },
    synonyms: ["REBORN"],
    seasonYear: 2005, // deliberately wrong: しょぼカル FirstYear wins
    studios: {
      nodes: [
        { name: "Artland", isAnimationStudio: true },
        { name: "TV Tokyo", isAnimationStudio: false },
        { name: "Dentsu", isAnimationStudio: false },
      ],
    },
    genres: ["Action", "Comedy"],
    source: "MANGA",
  }),
])

const REBORN_SYOBOI = syoboiTitles({
  "1": {
    Title: "家庭教師ヒットマンREBORN!",
    FirstCh: "テレビ東京",
    FirstYear: "2006",
    Cat: "10",
  },
})

const REBORN_JIKAN = jikanAnimeList([
  {
    title: "Katekyo Hitman Reborn!",
    title_japanese: "家庭教師ヒットマンREBORN!",
    demographics: [{ name: "Shounen" }],
    relations: [{ relation: "Adaptation", entry: [{ mal_id: 47, type: "manga" }] }],
  },
])

async function suggest(body: unknown, stub: ReturnType<typeof stubUpstreams>): Promise<Response> {
  return suggestTags(tagRequest({ body }), "req-test", { fetchImpl: stub.fetchImpl })
}

describe("POST /api/v1/tag-suggestions", () => {
  let restore: (() => void) | undefined

  beforeAll(async () => {
    await migratedDb()
  })

  afterEach(() => {
    restore?.()
    restore = undefined
  })

  it("resolves a single work across all upstreams into canonical tags", async () => {
    const stub = stubUpstreams({
      anilist: () => REBORN_ANILIST,
      syoboi: () => REBORN_SYOBOI,
      jikanAnime: () => REBORN_JIKAN,
      jikanManga: { 47: jikanManga("週刊少年ジャンプ") },
    })
    const response = await suggest({ works: [{ title: "家庭教師ヒットマンREBORN!" }] }, stub)
    expect(response.status).toBe(200)
    const data = TagSuggestionResponseSchema.parse(await dataOf(response))
    // しょぼカル FirstYear (2006) wins over AniList seasonYear (2005); TV Tokyo /
    // Dentsu are excluded by the isAnimationStudio flag.
    expect(data.tags).toEqual([
      "2006年",
      "アクション",
      "アートランド",
      "コメディ",
      "テレビ東京",
      "少年",
      "漫画原作",
      "週刊少年ジャンプ",
    ])
    expect(data.unmatched).toEqual([])
    expect(data.perWork).toEqual([
      {
        title: "家庭教師ヒットマンREBORN!",
        matched: true,
        tags: data.tags,
      },
    ])
    // One call per upstream + the manga serialization follow-up.
    expect(stub.calls.filter((u) => u.includes("anilist.co"))).toHaveLength(1)
    expect(stub.calls.filter((u) => u.includes("syoboi.jp"))).toHaveLength(1)
    expect(stub.calls.filter((u) => u.includes("jikan.moe/v4/anime"))).toHaveLength(1)
    expect(stub.calls.filter((u) => u.includes("jikan.moe/v4/manga/47"))).toHaveLength(1)
  })

  it("intersects axes for multi-work playlists and derives the series tag", async () => {
    const isFresh = (title: string) => title.includes("フレッシュ")
    const stub = stubUpstreams({
      anilist: (title) =>
        anilistPage([
          anilistMedia({
            title: {
              native: isFresh(title) ? "フレッシュプリキュア！" : "ハートキャッチプリキュア！",
            },
            seasonYear: isFresh(title) ? 2009 : 2010,
            studios: { nodes: [{ name: "Toei Animation", isAnimationStudio: true }] },
            source: "ORIGINAL",
          }),
        ]),
      syoboi: (title) =>
        syoboiTitles({
          "1": isFresh(title)
            ? {
                Title: "フレッシュプリキュア！",
                FirstCh: "ABCテレビ、テレビ朝日",
                FirstYear: "2009",
                Cat: "10",
              }
            : {
                Title: "ハートキャッチプリキュア！",
                FirstCh: "朝日放送、テレビ朝日",
                FirstYear: "2010",
                Cat: "10",
              },
        }),
      jikanAnime: (title) =>
        jikanAnimeList([{ title_japanese: title, demographics: [{ name: "Kids" }] }]),
    })
    const response = await suggest(
      { works: [{ title: "フレッシュプリキュア！" }, { title: "ハートキャッチプリキュア！" }] },
      stub,
    )
    expect(response.status).toBe(200)
    const data = TagSuggestionResponseSchema.parse(await dataOf(response))
    expect(data.tags).toContain("プリキュア")
    expect(data.tags).toContain("テレビ朝日")
    expect(data.tags).toContain("キッズ")
    expect(data.tags).toContain("東映アニメ")
    expect(data.tags).toContain("オリジナル")
    expect(data.tags.filter((tag) => /^\d{4}年$/.test(tag))).toHaveLength(0)
  })

  it("marks unmatched works and keeps them out of the suggestion", async () => {
    const stub = stubUpstreams({
      anilist: () => REBORN_ANILIST, // never equals the requested title
      syoboi: () => syoboiTitles({}),
    })
    const response = await suggest({ works: [{ title: "存在しない架空作品" }] }, stub)
    expect(response.status).toBe(200)
    const data = TagSuggestionResponseSchema.parse(await dataOf(response))
    expect(data.tags).toEqual([])
    expect(data.unmatched).toEqual(["存在しない架空作品"])
    expect(data.perWork).toEqual([{ title: "存在しない架空作品", matched: false, tags: [] }])
  })

  it("serves repeat requests from the D1 cache without re-fetching", async () => {
    // Own title: the per-file D1 is shared across tests, so reuse of the
    // REBORN key would hit the cache the first test already wrote.
    const stub = stubUpstreams({
      anilist: () =>
        anilistPage([anilistMedia({ title: { native: "キャッシュ作品" }, seasonYear: 2020 })]),
      syoboi: () => syoboiTitles({}),
    })
    const body = { works: [{ title: "キャッシュ作品" }] }
    const first = await suggest(body, stub)
    expect(first.status).toBe(200)
    const firstCalls = stub.calls.length
    expect(firstCalls).toBeGreaterThan(0)
    const second = await suggest(body, stub)
    expect(second.status).toBe(200)
    // Cache hit: zero additional upstream calls, identical payload.
    expect(stub.calls.length).toBe(firstCalls)
    expect(await second.json()).toEqual(await first.json())
  })

  it("returns 400 on malformed JSON through the route", async () => {
    const response = await call(
      postRoute,
      tagRequest({ body: "{not json", contentType: "application/json" }),
    )
    expect(response.status).toBe(400)
    const error = await errorOf(response)
    expect(error.code).toBe("BAD_REQUEST")
  })

  it("returns 400 with field paths on a schema-invalid body", async () => {
    const stub = stubUpstreams({})
    const response = await suggest({ works: [{ title: "" }] }, stub)
    expect(response.status).toBe(400)
    const error = await errorOf(response)
    expect(error.code).toBe("BAD_REQUEST")
    expect(JSON.stringify(error.details)).toContain("works.0.title")
    expect(stub.calls).toHaveLength(0)
  })

  it("answers 405 with Allow on non-POST methods", async () => {
    const response = await call(allRoute, tagRequest({ method: "GET" }))
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST")
    const error = await errorOf(response)
    expect(error.code).toBe("METHOD_NOT_ALLOWED")
  })

  it("refuses with 429 + Retry-After when the read limiter denies", async () => {
    const api = fakeLimiter(true)
    const read = fakeLimiter(false)
    restore = withLimiters({ api: api.binding, read: read.binding })
    const response = await call(postRoute, tagRequest({ body: { works: [{ title: "w" }] } }))
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("60")
    const error = await errorOf(response)
    expect(error.code).toBe("RATE_LIMITED")
    expect(read.calls).toHaveLength(1)
  })

  it("fails soft when an upstream is down and still answers", async () => {
    const stub = stubUpstreams({
      // no anilist plan -> 500 from the stub; syoboi alone carries the match
      syoboi: () => REBORN_SYOBOI,
      jikanAnime: () => jikanAnimeList([]),
    })
    const response = await suggest({ works: [{ title: "家庭教師ヒットマンREBORN!" }] }, stub)
    expect(response.status).toBe(200)
    const data = TagSuggestionResponseSchema.parse(await dataOf(response))
    expect(data.tags).toContain("テレビ東京")
    expect(data.tags).toContain("2006年")
  })
})
