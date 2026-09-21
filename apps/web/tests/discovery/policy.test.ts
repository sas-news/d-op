import { describe, expect, it } from "vitest"
import {
  decodeCursorPayload,
  newCursorKey,
  queryFingerprint,
  signCursor,
  verifyCursorSignature,
} from "../../src/server/discovery/cursor.js"
import {
  canonicalizeTagQuery,
  decideRanking,
  escapeLikePattern,
  normalizeSearchQuery,
  utcDayOf,
  windowStartDay,
} from "../../src/server/discovery/policy.js"
import { generateShareId } from "../../src/server/security/capability.js"

// Pure policy + cursor codec tests — the D1-backed window matrix lives in
// collection.test.ts. Clock values are always injected; nothing reads wall time.

const FP = "0123456789abcdef".repeat(4)

describe("decideRanking — adaptive windows", () => {
  it("sort=new never counts imports and reports window none with no fallback", () => {
    expect(
      decideRanking("new", { positives30d: 99, positives90d: 99, positivesLifetime: 99 }),
    ).toEqual({ mode: "new", effectiveWindow: "none", fallbackReason: undefined })
  })

  it("degrades to new/none/no-imports when lifetime has no positive scores", () => {
    expect(
      decideRanking("popular", { positives30d: 0, positives90d: 0, positivesLifetime: 0 }),
    ).toEqual({
      mode: "new",
      effectiveWindow: "none",
      fallbackReason: "no-imports",
    })
  })

  it("uses 30d once at least five eligible playlists score within it", () => {
    const d = decideRanking("popular", {
      positives30d: 5,
      positives90d: 40,
      positivesLifetime: 40,
    })
    expect(d).toEqual({ mode: "popular", effectiveWindow: "30d", fallbackReason: undefined })
  })

  it("widens to 90d when 30d has fewer than five positives", () => {
    const d = decideRanking("popular", {
      positives30d: 4,
      positives90d: 5,
      positivesLifetime: 12,
    })
    expect(d.effectiveWindow).toBe("90d")
    expect(d.fallbackReason).toBe("insufficient-recent-data")
  })

  it("uses lifetime when shorter windows lack coverage but lifetime has positives", () => {
    const d = decideRanking("popular", {
      positives30d: 0,
      positives90d: 3,
      positivesLifetime: 4,
    })
    expect(d.effectiveWindow).toBe("lifetime")
    expect(d.fallbackReason).toBe("insufficient-recent-data")
  })

  it("requires no minimum total event count — playlist coverage alone decides", () => {
    // Five playlists with exactly one import each satisfy the 30d window.
    expect(
      decideRanking("popular", { positives30d: 5, positives90d: 5, positivesLifetime: 5 })
        .effectiveWindow,
    ).toBe("30d")
  })
})

describe("day math", () => {
  const now = new Date("2026-03-10T12:00:00.000Z")

  it("windows are N calendar days INCLUDING the current UTC day", () => {
    expect(windowStartDay(now, 30)).toBe("2026-02-09")
    expect(windowStartDay(now, 90)).toBe("2025-12-11")
  })

  it("utcDayOf returns the UTC YYYY-MM-DD regardless of time-of-day", () => {
    expect(utcDayOf(new Date("2026-03-10T23:59:59.999Z"))).toBe("2026-03-10")
    expect(utcDayOf(new Date("2026-03-10T00:00:00.000Z"))).toBe("2026-03-10")
  })
})

describe("filters", () => {
  it("normalizes tags to canonical lowercase form (matching publish-time)", () => {
    expect(canonicalizeTagQuery(" Vocaloid ")).toBe("vocaloid")
    // Case-folded but not width-folded — identical to stored-tag canonicalization.
    expect(canonicalizeTagQuery("ＯＰ")).toBe("ｏｐ")
  })

  it("collapses search whitespace; escaping makes LIKE literal", () => {
    expect(normalizeSearchQuery("  初音  ミク  ")).toBe("初音 ミク")
    expect(normalizeSearchQuery("   ")).toBe("")
    expect(escapeLikePattern("100%_")).toBe("100\\%\\_")
  })
})

describe("cursor codec", () => {
  it("round-trips a signed cursor", async () => {
    const key = newCursorKey()
    const cursor = await signCursor({ v: 1, s: generateShareId(), o: 42, f: FP }, key)
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
    expect(decodeCursorPayload(cursor)).toEqual({ v: 1, s: expect.any(String), o: 42, f: FP })
    expect(await verifyCursorSignature(cursor, key)).toEqual({
      v: 1,
      s: expect.any(String),
      o: 42,
      f: FP,
    })
  })

  it("rejects tampered payloads, wrong keys and malformed input", async () => {
    const key = newCursorKey()
    const other = newCursorKey()
    const shareId = generateShareId()
    const cursor = await signCursor({ v: 1, s: shareId, o: 0, f: FP }, key)
    const [body] = cursor.split(".")
    const forged = await signCursor({ v: 1, s: shareId, o: 99, f: FP }, key)
    const [, forgedSig] = forged.split(".")

    expect(await verifyCursorSignature(`${body}.${forgedSig}`, key)).toBeNull()
    expect(await verifyCursorSignature(cursor, other)).toBeNull()
    expect(await verifyCursorSignature("not-a-cursor", key)).toBeNull()
    expect(await verifyCursorSignature("AAAA.BBBB", key)).toBeNull()
    expect(decodeCursorPayload("no-dot")).toBeNull()
    // Payload without a 64-hex fingerprint never survives the shape check.
    expect(
      await verifyCursorSignature(
        await signCursor({ v: 1, s: shareId, o: 0, f: "short" }, key),
        key,
      ),
    ).toBeNull()
  })

  it("fingerprints differ on sort, window and filters alike", async () => {
    const base = { sort: "new", mode: "new", window: "none", q: null, tag: null }
    const fp = await queryFingerprint(base)
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    expect(await queryFingerprint({ ...base, sort: "popular" })).not.toBe(fp)
    expect(await queryFingerprint({ ...base, window: "30d" })).not.toBe(fp)
    expect(await queryFingerprint({ ...base, q: "op" })).not.toBe(fp)
    expect(await queryFingerprint({ ...base, tag: "vocaloid" })).not.toBe(fp)
    expect(await queryFingerprint(base)).toBe(fp)
  })
})
