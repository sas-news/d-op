// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import {
  decodeHtmlEntities,
  formatRangeName,
  formatSec,
  isSystemPlaylist,
  itemPlaybackUrl,
  parseTimeInput,
} from "../../src/ui/format"

describe("ui/format (common.js parity)", () => {
  it("formatSec floors ms to m:ss", () => {
    expect(formatSec(0)).toBe("0:00")
    expect(formatSec(90_500)).toBe("1:30")
    expect(formatSec(3_723_999)).toBe("62:03")
    expect(formatSec(-5)).toBe("0:00")
  })

  it("parseTimeInput accepts m:ss and raw seconds, returns ms", () => {
    expect(parseTimeInput("1:30")).toBe(90_000)
    expect(parseTimeInput("90")).toBe(90_000)
    expect(parseTimeInput("90.6")).toBe(90_600)
    expect(parseTimeInput("")).toBeNull()
    expect(parseTimeInput("abc")).toBeNull()
    // Legacy quirk: a 3-part m:ss falls through to parseFloat("1:2:3")=1.
    expect(parseTimeInput("1:2:3")).toBe(1_000)
  })

  it("isSystemPlaylist filters __dop_ names", () => {
    expect(isSystemPlaylist({ name: "__dop_pending" })).toBe(true)
    expect(isSystemPlaylist({ name: "my list" })).toBe(false)
  })

  it("decodeHtmlEntities resolves entities via DOMParser", () => {
    expect(decodeHtmlEntities("A&amp;B &#39;C&#39;")).toBe("A&B 'C'")
    expect(decodeHtmlEntities("")).toBe("")
  })

  it("formatRangeName uses the stored name else 範囲", () => {
    expect(formatRangeName({ name: "OP" })).toBe("OP")
    expect(formatRangeName({ name: "" })).toBe("範囲")
    expect(formatRangeName({})).toBe("範囲")
    expect(formatRangeName(null)).toBe("範囲")
  })

  it("itemPlaybackUrl prefers the stored url, falls back to partId", () => {
    const stored = "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=p9"
    expect(itemPlaybackUrl({ partId: "p9", url: stored })).toBe(stored)
    expect(itemPlaybackUrl({ partId: "p9" })).toBe(
      "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=p9",
    )
    expect(itemPlaybackUrl({ partId: "" })).toBeNull()
  })
})
