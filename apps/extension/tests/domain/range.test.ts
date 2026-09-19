import { describe, expect, it } from "vitest"
import { guessRangeName, parseRange } from "../../src/domain/range"

describe("range domain", () => {
  it("preserves a custom name and exact millisecond precision", () => {
    // Given: a named range with non-second-aligned boundaries.
    // When: parsed at the domain boundary.
    const result = parseRange({ start: 12_345, end: 98_765, name: "ユーザー指定" })

    // Then: no rounding or label replacement occurs.
    expect(result).toEqual({
      kind: "valid",
      range: { start: 12_345, end: 98_765, name: "ユーザー指定" },
    })
  })

  it("keeps a null range as a valid full episode", () => {
    // Given: the local full-episode representation.
    // When: parsed.
    const result = parseRange(null)

    // Then: null remains a valid domain value.
    expect(result).toEqual({ kind: "valid", range: null })
  })

  it("rejects reversed, equal, fractional, and negative ranges", () => {
    // Given: invalid millisecond boundaries.
    const candidates = [
      { start: 2, end: 1 },
      { start: 1, end: 1 },
      { start: 0.5, end: 2 },
      { start: -1, end: 2 },
    ]

    // When: each candidate is parsed. Then: none enters the domain.
    for (const candidate of candidates) expect(parseRange(candidate).kind).toBe("invalid-range")
  })

  it("retains the observed legacy heuristic labels", () => {
    // Given: near-start, near-end, and fallback chapter geometry in milliseconds.
    // When: labels are inferred. Then: the legacy thresholds remain stable.
    expect(
      guessRangeName({
        range: { start: 0, end: 90_000 },
        index: 0,
        total: 1,
        durationMs: 1_410_000,
      }),
    ).toBe("OP")
    expect(
      guessRangeName({
        range: { start: 1_320_000, end: 1_410_000 },
        index: 1,
        total: 2,
        durationMs: 1_410_000,
      }),
    ).toBe("ED")
    expect(
      guessRangeName({
        range: { start: 0, end: 10_000 },
        index: 0,
        total: 3,
        durationMs: 1_410_000,
      }),
    ).toBe("イントロ")
    expect(
      guessRangeName({
        range: { start: 600_000, end: 660_000 },
        index: 1,
        total: 3,
        durationMs: 1_410_000,
      }),
    ).toBe("パート2")
  })
})
