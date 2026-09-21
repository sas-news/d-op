import { describe, expect, it } from "vitest"
import {
  decideEnforcement,
  decidePreviousClick,
  type EnforcementInput,
} from "../../src/player/enforcement"

const RANGE_A = { startMs: 10_000, endMs: 90_000 }
const RANGE_B = { startMs: 120_000, endMs: 140_000 }

function base(overrides: Partial<EnforcementInput> = {}): EnforcementInput {
  return {
    mode: "playlist",
    hasPlayback: true,
    fullEpisode: false,
    ranges: [RANGE_A],
    positionMs: 50_000,
    durationMs: 180_000,
    ended: false,
    seekingStart: false,
    now: 10_000_000,
    lastActionAt: 0,
    cooldownUntil: 0,
    sameVideoItems: [],
    currentItemId: "item-1",
    ...overrides,
  }
}

describe("decideEnforcement", () => {
  it("does nothing when idle or when no ranges are enforced", () => {
    expect(decideEnforcement(base({ mode: "idle", hasPlayback: false }))).toEqual({
      kind: "none",
    })
    expect(decideEnforcement(base({ ranges: [] }))).toEqual({ kind: "none" })
  })

  it("full-episode (range:null) plays through and only advances on ended", () => {
    expect(decideEnforcement(base({ fullEpisode: true, positionMs: 0 }))).toEqual({
      kind: "none",
    })
    expect(decideEnforcement(base({ fullEpisode: true, ended: true }))).toEqual({
      kind: "advance",
    })
  })

  it("respects the post-start cooldown window", () => {
    expect(decideEnforcement(base({ positionMs: 1_000, cooldownUntil: 10_000_500 }))).toEqual({
      kind: "none",
    })
  })

  it("reports in-range inside the tolerance window and clears nothing else", () => {
    for (const positionMs of [
      RANGE_A.startMs - 50,
      RANGE_A.startMs,
      RANGE_A.endMs,
      RANGE_A.endMs + 1_050,
    ]) {
      expect(decideEnforcement(base({ positionMs }))).toEqual({ kind: "in-range" })
    }
    expect(decideEnforcement(base({ positionMs: RANGE_A.startMs - 51 }))).toEqual({
      kind: "seek",
      timeMs: RANGE_A.startMs,
    })
    expect(decideEnforcement(base({ positionMs: RANGE_A.endMs + 1_051 }))).toEqual({
      kind: "advance",
    })
  })

  it("enforces the 200 ms minimum gap between actions", () => {
    expect(decideEnforcement(base({ positionMs: 0, lastActionAt: 10_000_000 - 199 }))).toEqual({
      kind: "none",
    })
    expect(decideEnforcement(base({ positionMs: 0, lastActionAt: 10_000_000 - 200 }))).toEqual({
      kind: "seek",
      timeMs: RANGE_A.startMs,
    })
  })

  it("seeks to the first range start when playback sits before the range", () => {
    expect(decideEnforcement(base({ positionMs: 5_000 }))).toEqual({
      kind: "seek",
      timeMs: RANGE_A.startMs,
    })
  })

  it("retargets the item when the user seeked into another same-video range", () => {
    // Position sits past the current range but inside another same-video
    // item's range (legacy trySwitchToOtherRange, content.js:522-546).
    const decision = decideEnforcement(
      base({
        positionMs: 130_000,
        ranges: [RANGE_A],
        sameVideoItems: [{ itemId: "item-2", startMs: 120_000, endMs: 140_000 }],
      }),
    )
    expect(decision).toEqual({ kind: "switch-item", itemId: "item-2" })
    // The same item never retargets itself — plain advance instead.
    expect(
      decideEnforcement(
        base({
          positionMs: 130_000,
          ranges: [RANGE_A],
          sameVideoItems: [{ itemId: "item-1", startMs: 120_000, endMs: 140_000 }],
        }),
      ),
    ).toEqual({ kind: "advance" })
    // In the gap between ranges a same-video match wins over the seek.
    expect(
      decideEnforcement(
        base({
          positionMs: 100_000,
          ranges: [RANGE_A, RANGE_B],
          sameVideoItems: [{ itemId: "item-3", startMs: 95_000, endMs: 110_000 }],
        }),
      ),
    ).toEqual({ kind: "switch-item", itemId: "item-3" })
  })

  it("seeks back to the start while the initial seek is still landing", () => {
    expect(decideEnforcement(base({ positionMs: 95_000, seekingStart: true }))).toEqual({
      kind: "seek",
      timeMs: RANGE_A.startMs,
    })
  })

  it("advances the playlist past the last range end and on ended", () => {
    expect(decideEnforcement(base({ positionMs: 95_000 }))).toEqual({ kind: "advance" })
    expect(decideEnforcement(base({ positionMs: 50_000, ended: true }))).toEqual({
      kind: "in-range",
    })
    // ended with position outside range still advances.
    expect(decideEnforcement(base({ positionMs: 95_000, ended: true }))).toEqual({
      kind: "advance",
    })
  })

  it("op-ed seeks near the end instead of pausing, with the 1 s end margin", () => {
    const input = base({
      mode: "op-ed",
      hasPlayback: false,
      ranges: [RANGE_A],
      positionMs: 100_000,
      durationMs: 180_000,
    })
    expect(decideEnforcement(input)).toEqual({ kind: "seek-end", timeMs: 179_500 })
    // Inside the 1 s end margin nothing happens (legacy parity).
    expect(decideEnforcement({ ...input, positionMs: 179_500 })).toEqual({ kind: "none" })
    // Unknown duration: no seek.
    expect(decideEnforcement({ ...input, durationMs: Number.POSITIVE_INFINITY })).toEqual({
      kind: "none",
    })
  })

  it("custom-preview pauses past the range end", () => {
    expect(
      decideEnforcement(base({ mode: "custom-preview", hasPlayback: false, positionMs: 95_000 })),
    ).toEqual({ kind: "pause" })
  })

  it("hops to the next range start in the gap between ranges", () => {
    expect(decideEnforcement(base({ ranges: [RANGE_A, RANGE_B], positionMs: 95_000 }))).toEqual({
      kind: "seek",
      timeMs: RANGE_B.startMs,
    })
  })
})

describe("decidePreviousClick", () => {
  const click = {
    hasPlayback: true,
    positionMs: 10_500,
    rangeStartMs: 10_000,
    lastPrevClickAt: 0,
    now: 1_000_000,
  }

  it("ignores clicks without active playback", () => {
    expect(decidePreviousClick({ ...click, hasPlayback: false })).toEqual({ kind: "none" })
  })

  it("restarts the range on a single click", () => {
    expect(decidePreviousClick(click)).toEqual({
      kind: "restart-range",
      timeMs: 10_000,
    })
  })

  it("steps back only when near the range start inside the 1500 ms window", () => {
    expect(decidePreviousClick({ ...click, lastPrevClickAt: 999_000 })).toEqual({
      kind: "step-back",
    })
    // Outside the double-click window it restarts instead.
    expect(decidePreviousClick({ ...click, lastPrevClickAt: 998_000 })).toEqual({
      kind: "restart-range",
      timeMs: 10_000,
    })
    // Far from the start it always restarts.
    expect(decidePreviousClick({ ...click, positionMs: 60_000, lastPrevClickAt: 999_500 })).toEqual(
      { kind: "restart-range", timeMs: 10_000 },
    )
  })

  it("null-range items restart at zero and never dereference null", () => {
    expect(decidePreviousClick({ ...click, rangeStartMs: null })).toEqual({
      kind: "restart-range",
      timeMs: 0,
    })
  })
})
