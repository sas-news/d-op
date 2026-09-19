import { describe, expect, it } from "vitest"
import { fetchChapterDocument } from "../../src/adapter/chapter-fetch"

describe("bounded chapter fetch", () => {
  it("models rejected fetches and oversized bytes", async () => {
    const failed = await fetchChapterDocument({
      url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=x",
      origin: "https://animestore.docomo.ne.jp",
      fetcher: async () => {
        throw new Error("offline")
      },
    })
    expect(failed).toEqual({ kind: "fetch-failed" })

    const oversized = await fetchChapterDocument({
      url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=x",
      origin: "https://animestore.docomo.ne.jp",
      maxBytes: 1,
      fetcher: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) }),
    })
    expect(oversized.kind).toBe("oversized")
  })
})
