// Legacy pure-logic characterization (task 3).
// Given: the checked-in legacy common.js at the task-1 baseline.
// When: its pure migration helpers are evaluated in-test only.
// Then: preserved behavior vs intentional fixes are pinned without shipping
// legacy globals into production source.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

type LegacyChapter = { readonly start: number; readonly end: number }
type LegacyRangeInput = {
  readonly start?: number
  readonly end?: number
  readonly name?: string
  readonly type?: string
}
type LegacyItemInput = {
  readonly id?: string
  readonly partId?: string
  readonly workId?: string
  readonly title?: string
  readonly episodeTitle?: string
  readonly episodeNumber?: string
  readonly url?: string
  readonly range?: LegacyRangeInput | null
  readonly opRange?: LegacyChapter
  readonly edRange?: LegacyChapter
  readonly customRange?: LegacyChapter
}
type LegacyPureApi = {
  readonly deriveRangeName: (range: LegacyRangeInput | null) => string | null
  readonly cleanItem: (item: LegacyItemInput) => {
    readonly range: {
      readonly start?: number
      readonly end?: number
      readonly name?: string
    } | null
    readonly episodeNumber: string
    readonly id?: string
  }
  readonly migrateItem: (item: LegacyItemInput) => readonly {
    readonly id?: string
    readonly range: { readonly name?: string } | null
  }[]
  readonly migratePlaylist: (playlist: { readonly items?: readonly LegacyItemInput[] }) => {
    readonly items: readonly { readonly id?: string }[]
  }
  readonly guessRangeName: (
    chapter: LegacyChapter,
    index: number,
    total: number,
    durationSec: number,
  ) => string
  readonly dopCreateShuffledIndices: (n: number) => readonly number[]
}

function loadLegacyPure(): LegacyPureApi {
  const source = readFileSync(new URL("../../../common.js", import.meta.url), "utf8")
  const factory = new Function(
    `${source}; return { deriveRangeName, cleanItem, migrateItem, migratePlaylist, guessRangeName, dopCreateShuffledIndices };`,
  ) as () => LegacyPureApi
  return factory()
}

const legacy = loadLegacyPure()

describe("legacy deriveRangeName", () => {
  it("maps old range.type values to names", () => {
    // Given: historical typed ranges.
    // When: names are derived.
    // Then: op/ed/custom map exactly; modern name wins when both exist.
    expect(legacy.deriveRangeName({ type: "op", start: 0, end: 1 })).toBe("OP")
    expect(legacy.deriveRangeName({ type: "ed", start: 0, end: 1 })).toBe("ED")
    expect(legacy.deriveRangeName({ type: "custom", start: 0, end: 1 })).toBe("CUSTOM")
    expect(legacy.deriveRangeName({ name: "KEEP", type: "op", start: 0, end: 1 })).toBe("KEEP")
    expect(legacy.deriveRangeName(null)).toBeNull()
  })
})

describe("legacy migrateItem fan-out", () => {
  it("expands opRange/edRange/customRange in order with shared ids", () => {
    // Given: one legacy item with all three historical slots.
    // When: migrated.
    // Then: three clips in op/ed/custom order sharing the original id
    // (legacy behavior is characterized here; v2 repairs the collision while
    // retaining every clip and never deduplicating on partId).
    const clones = legacy.migrateItem({
      id: "orig",
      opRange: { start: 0, end: 90000 },
      edRange: { start: 1320000, end: 1410000 },
      customRange: { start: 600000, end: 660000 },
    })
    expect(clones.map((c) => c.range?.name)).toEqual(["OP", "ED", "CUSTOM"])
    expect(clones.map((c) => c.id)).toEqual(["orig", "orig", "orig"])
  })

  it("keeps a null range when no range slot exists", () => {
    // Given: a legacy item with no range information.
    // When: migrated.
    // Then: exactly one clip with a null range (valid local full-episode
    // data, invalid Share payload).
    const clones = legacy.migrateItem({ id: "bare" })
    expect(clones).toHaveLength(1)
    const first = clones[0]
    expect(first?.range).toBeNull()
  })

  it("defaults episodeNumber to empty string", () => {
    // Given: an item without episodeNumber.
    // When: cleaned.
    // Then: episodeNumber defaults to "" (v2 preserves real values; the
    // options.js import-cleaner loss is a task-11 fix, not preserved here).
    expect(legacy.cleanItem({ id: "x" }).episodeNumber).toBe("")
  })
})

describe("legacy guessRangeName heuristics", () => {
  it("labels ~90s near-start chapters OP and near-end chapters ED", () => {
    // Given: synthetic chapter geometry in milliseconds.
    // When: heuristic names are guessed.
    // Then: OP/ED/intro/part fallback follow the documented thresholds.
    expect(legacy.guessRangeName({ start: 0, end: 90000 }, 0, 1, 1410000 / 1000)).toBe("OP")
    expect(legacy.guessRangeName({ start: 1320000, end: 1410000 }, 1, 2, 1410000 / 1000)).toBe("ED")
    expect(legacy.guessRangeName({ start: 0, end: 10000 }, 0, 3, 1410000 / 1000)).toBe("イントロ")
    expect(legacy.guessRangeName({ start: 600000, end: 660000 }, 1, 3, 1410000 / 1000)).toBe(
      "パート2",
    )
  })
})

describe("legacy shuffle helper shape", () => {
  it("returns a permutation of 0..n-1", () => {
    // Given: n = 7.
    // When: shuffled indices are created.
    // Then: the result is a permutation (order random, membership exact).
    const indices = legacy.dopCreateShuffledIndices(7)
    expect([...indices].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
})
