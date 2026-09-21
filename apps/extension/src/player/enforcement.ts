// Pure playback enforcement decisions — ports content.js:453-519
// (enforceRanges/insideRange), 521-547 (trySwitchToOtherRange) and 352-367
// (handlePrevClick) from baseline fc9d7fd. The orchestrator applies the
// returned decisions; keeping this pure is what lets unit tests cover every
// timing branch without a DOM.
import {
  DOUBLE_CLICK_WINDOW_MS,
  ENFORCE_MIN_GAP_MS,
  OPED_END_MARGIN_MS,
  OPED_SEEK_END_OFFSET_MS,
  PREV_RESTART_THRESHOLD_MS,
  RANGE_TAIL_MS,
  RANGE_TOLERANCE_MS,
} from "./constants"

export type PlayerModeKind = "idle" | "playlist" | "op-ed" | "custom-preview"

export type EnforcedRange = { readonly startMs: number; readonly endMs: number }

/** Same-video playlist entries eligible for a seek-driven retarget. */
export type SameVideoRange = {
  readonly itemId: string
  readonly startMs: number
  readonly endMs: number
}

export type EnforcementInput = {
  readonly mode: PlayerModeKind
  readonly hasPlayback: boolean
  /** Playlist item with range null: full episode plays, `ended` advances. */
  readonly fullEpisode: boolean
  readonly ranges: readonly EnforcedRange[]
  readonly positionMs: number
  readonly durationMs: number
  readonly ended: boolean
  readonly seekingStart: boolean
  readonly now: number
  readonly lastActionAt: number
  readonly cooldownUntil: number
  readonly sameVideoItems: readonly SameVideoRange[]
  readonly currentItemId: string | null
}

export type EnforcementDecision =
  | { readonly kind: "none" }
  /** Inside a range — caller clears seekingStart/endMenuShown. */
  | { readonly kind: "in-range" }
  | { readonly kind: "seek"; readonly timeMs: number }
  | { readonly kind: "pause" }
  /** Playlist past end / ended — caller pauses, then advances once. */
  | { readonly kind: "advance" }
  /** User seeked into another same-video playlist range — retarget item. */
  | { readonly kind: "switch-item"; readonly itemId: string }
  /** Op-ed past the last range end — legacy seeks near duration end. */
  | { readonly kind: "seek-end"; readonly timeMs: number }

function insideRange(ranges: readonly EnforcedRange[], positionMs: number): boolean {
  // Port of insideRange (content.js:453-460): +/-50 ms tolerance, +1 s tail.
  return ranges.some(
    (range) =>
      positionMs >= range.startMs - RANGE_TOLERANCE_MS &&
      positionMs <= range.endMs + RANGE_TAIL_MS + RANGE_TOLERANCE_MS,
  )
}

function switchTarget(input: EnforcementInput, positionMs: number): SameVideoRange | undefined {
  // Port of trySwitchToOtherRange matching (content.js:522-527): a same-video
  // item whose [start, end + 1 s] window holds t, other than the current item.
  return input.sameVideoItems.find(
    (candidate) =>
      candidate.itemId !== input.currentItemId &&
      positionMs >= candidate.startMs &&
      positionMs <= candidate.endMs + RANGE_TAIL_MS,
  )
}

export function decideEnforcement(input: EnforcementInput): EnforcementDecision {
  if (input.mode === "idle") return { kind: "none" }
  // range:null playlist item — full-episode play (plan Local data step 5);
  // only a real `ended` advances. Never dereferences a null range.
  if (input.fullEpisode) return input.ended ? { kind: "advance" } : { kind: "none" }
  if (input.ranges.length === 0) return { kind: "none" }
  if (input.now < input.cooldownUntil) return { kind: "none" }

  const first = input.ranges[0]
  const last = input.ranges[input.ranges.length - 1]
  if (first === undefined || last === undefined) return { kind: "none" }
  const firstStart = first.startMs
  const lastEnd = last.endMs + RANGE_TAIL_MS
  const position = input.positionMs

  if (insideRange(input.ranges, position)) return { kind: "in-range" }

  // Minimum gap between enforce actions (content.js:483-484).
  if (input.now - input.lastActionAt < ENFORCE_MIN_GAP_MS) return { kind: "none" }

  if (position < firstStart) {
    const target = switchTarget(input, position)
    if (target !== undefined) return { kind: "switch-item", itemId: target.itemId }
    return { kind: "seek", timeMs: firstStart }
  }

  if (position > lastEnd || input.ended) {
    if (input.hasPlayback) {
      const target = switchTarget(input, position)
      if (target !== undefined) return { kind: "switch-item", itemId: target.itemId }
      // Still hunting the initial seek position — pull back to the start
      // instead of advancing (content.js:498).
      if (input.seekingStart) return { kind: "seek", timeMs: firstStart }
      return { kind: "advance" }
    }
    if (input.mode === "op-ed") {
      // content.js:501-505 — only seeks when there is room before the end.
      if (
        Number.isFinite(input.durationMs) &&
        position > lastEnd &&
        position < input.durationMs - OPED_END_MARGIN_MS
      ) {
        return { kind: "seek-end", timeMs: input.durationMs - OPED_SEEK_END_OFFSET_MS }
      }
      return { kind: "none" }
    }
    return { kind: "pause" }
  }

  // Between two ranges: jump to the next range start (content.js:512-518).
  for (const range of input.ranges) {
    if (position < range.startMs) {
      const target = switchTarget(input, position)
      if (target !== undefined) return { kind: "switch-item", itemId: target.itemId }
      return { kind: "seek", timeMs: range.startMs }
    }
  }
  return { kind: "none" }
}

export type PreviousClickDecision =
  | { readonly kind: "none" }
  /** Seek back to range start (0 for a null-range full episode) and play. */
  | { readonly kind: "restart-range"; readonly timeMs: number }
  /** Within 1 s of start AND second click inside 1500 ms — step back. */
  | { readonly kind: "step-back" }

export function decidePreviousClick(input: {
  readonly hasPlayback: boolean
  readonly positionMs: number | null
  readonly rangeStartMs: number | null
  readonly lastPrevClickAt: number
  readonly now: number
}): PreviousClickDecision {
  if (!input.hasPlayback) return { kind: "none" }
  // Legacy restart target: seconds(currentPlayback.item.range.start)
  // (content.js:355); a null-range full episode restarts at zero (plan §64).
  const start = input.rangeStartMs ?? 0
  const nearStart =
    input.positionMs !== null && Math.abs(input.positionMs - start) < PREV_RESTART_THRESHOLD_MS
  const doubleClick = nearStart && input.now - input.lastPrevClickAt < DOUBLE_CLICK_WINDOW_MS
  return doubleClick ? { kind: "step-back" } : { kind: "restart-range", timeMs: start }
}
