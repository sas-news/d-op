// Merged seek-marker computation — ports getSeekRanges (content.js:887-949).
// The marker list is the union of:
//   1. chapter ranges (heuristic OP/ED/イントロ names via guessRangeName),
//   2. playlist-item ranges stored for the current partId — a stored custom
//      name overrides the heuristic label, otherwise an unlabeled '範囲'
//      marker is appended (content.js:925-948),
//   3. the custom-preview draft — a full range or a single-edge point marker
//      (content.js:909-924).
// `active` marks the currently playing playlist item's range (bounds match,
// content.js:1047-1054) or the selected op-ed range. Coloring is a separate
// snapshot flag (markersColored) — legacy only colors when a mode is active.
import { guessRangeName } from "../domain/range"
import type { EnforcedRange, PlayerModeKind } from "./enforcement"
import type { NamedRange, PlayerState, SeekMarker } from "./runtime"

export type SeekMarkerInput = {
  readonly mode: PlayerModeKind
  readonly state: PlayerState
  readonly chapters: readonly EnforcedRange[] | null
  /** Stored playlist-item ranges for the current partId (all playlists). */
  readonly libraryRanges: readonly NamedRange[]
  readonly durationMs: number
}

type MutableMarker = {
  startMs: number
  endMs: number
  label: string
  active: boolean
}

function pushUnique(markers: MutableMarker[], marker: MutableMarker): void {
  const dup = markers.some(
    (entry) => entry.startMs === marker.startMs && entry.endMs === marker.endMs,
  )
  if (!dup) markers.push(marker)
}

export function computeSeekMarkers(input: SeekMarkerInput): SeekMarker[] {
  const markers: MutableMarker[] = []
  const chapters = input.chapters ?? []
  const total = chapters.length
  for (const [index, chapter] of chapters.entries()) {
    markers.push({
      startMs: chapter.startMs,
      endMs: chapter.endMs,
      label: guessRangeName({
        range: { start: chapter.startMs, end: chapter.endMs },
        index,
        total,
        durationMs: input.durationMs,
      }),
      active: false,
    })
  }

  // Stored playlist ranges for this partId: a saved name overrides the
  // heuristic chapter label; unnamed ranges append as '範囲'.
  for (const range of input.libraryRanges) {
    const match = markers.find(
      (entry) => entry.startMs === range.startMs && entry.endMs === range.endMs,
    )
    if (match !== undefined) {
      if (range.name !== "") match.label = range.name
      continue
    }
    markers.push({
      startMs: range.startMs,
      endMs: range.endMs,
      label: range.name !== "" ? range.name : "範囲",
      active: false,
    })
  }

  const state = input.state
  if (state.mode === "playlist") {
    // Legacy marks every marker whose bounds equal the playing item's range.
    const range = state.playback.item.range
    if (range !== null) {
      for (const marker of markers) {
        if (marker.startMs === range.start && marker.endMs === range.end) marker.active = true
      }
    }
  } else if (state.mode === "op-ed") {
    const current = state.ranges[state.rangeIndex]
    if (current !== undefined) {
      for (const marker of markers) {
        if (marker.startMs === current.startMs && marker.endMs === current.endMs)
          marker.active = true
      }
    }
  } else if (state.mode === "custom-preview") {
    const draft = state.draft
    const label = draft.name !== "" ? draft.name : "CUSTOM"
    if (draft.startMs !== null && draft.endMs !== null && draft.startMs < draft.endMs) {
      pushUnique(markers, {
        startMs: draft.startMs,
        endMs: draft.endMs,
        label,
        active: true,
      })
    } else {
      // Single-edge draft renders as a point marker (content.js:919-923).
      const point = draft.startMs ?? draft.endMs
      if (point !== null) pushUnique(markers, { startMs: point, endMs: point, label, active: true })
    }
  }
  return markers
}
