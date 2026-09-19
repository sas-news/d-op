import { describe, expect, it } from "vitest"
import { parseChapterDocument } from "../../src/adapter/chapter-parser"

describe("bounded chapter parser", () => {
  it("parses nested chapter JSON without regex truncation", () => {
    const html =
      '<script>window.data={"chapters":[{"start":0,"end":90000,"meta":{"label":"x"}}],"duration":120000}</script>'
    expect(parseChapterDocument(html)).toEqual({
      kind: "ok",
      chapters: [{ startMs: 0, endMs: 90000 }],
      durationMs: 120000,
    })
  })

  it("fails explicitly for malformed, nested, and oversized documents", () => {
    expect(parseChapterDocument('<script>{"chapters":[{"start":0}</script>').kind).toBe("malformed")
    expect(
      parseChapterDocument(
        '<script>{"chapters":[{"start":0,"end":2,"meta":{"x":1}],"duration":3</script>',
      ).kind,
    ).toBe("malformed")
    expect(parseChapterDocument("x".repeat(1_000_001)).kind).toBe("oversized")
  })
})
