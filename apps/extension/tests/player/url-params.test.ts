import { describe, expect, it } from "vitest"
import {
  buildPlaylistItemUrl,
  isPlayerPageUrl,
  readPlayerUrlParams,
  stripPlayerUrlParams,
} from "../../src/player/url-params"

const PLAYER =
  "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=12345&dopPlaylistId=pl-1&dopIndex=2&dopRangeIndex=1&dopTitle=W&dopEpisodeTitle=E"

describe("readPlayerUrlParams", () => {
  it("parses every dop* param plus partId", () => {
    expect(readPlayerUrlParams(PLAYER)).toEqual({
      partId: "12345",
      playlistId: "pl-1",
      playlistIndex: 2,
      rangeIndex: 1,
      workTitle: "W",
      episodeTitle: "E",
    })
  })

  it("returns null for absent or malformed indexes", () => {
    const url =
      "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=p1&dopIndex=-3&dopRangeIndex=abc"
    const params = readPlayerUrlParams(url)
    expect(params.playlistIndex).toBeNull()
    expect(params.rangeIndex).toBeNull()
    expect(params.playlistId).toBeNull()
  })
})

describe("stripPlayerUrlParams", () => {
  it("removes every dop* key and keeps the rest", () => {
    expect(stripPlayerUrlParams(PLAYER)).toBe(
      "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=12345",
    )
  })
})

describe("buildPlaylistItemUrl", () => {
  it("adds dopPlaylistId + real dopIndex to the item url", () => {
    const url = buildPlaylistItemUrl(
      "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=77",
      "pl-9",
      3,
    )
    const parsed = readPlayerUrlParams(url)
    expect(parsed.playlistId).toBe("pl-9")
    expect(parsed.playlistIndex).toBe(3)
    expect(parsed.partId).toBe("77")
  })
})

describe("isPlayerPageUrl", () => {
  it("accepts both supported origins and requires a query string", () => {
    expect(isPlayerPageUrl("https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=1")).toBe(
      true,
    )
    expect(isPlayerPageUrl("https://anime.dmkt-sp.jp/animestore/sc_d_pc?x=1")).toBe(true)
    // Legacy isDAnimeUrl required sc_d_pc? — no query, not a live player tab.
    expect(isPlayerPageUrl("https://animestore.docomo.ne.jp/animestore/sc_d_pc")).toBe(false)
    expect(isPlayerPageUrl("https://animestore.docomo.ne.jp/other?x=1")).toBe(false)
    expect(isPlayerPageUrl("https://evil.example/animestore/sc_d_pc?x=1")).toBe(false)
    expect(isPlayerPageUrl("http://127.0.0.1:8123/animestore/sc_d_pc?x=1")).toBe(false)
    expect(isPlayerPageUrl(undefined)).toBe(false)
    expect(isPlayerPageUrl("not a url")).toBe(false)
  })
})
