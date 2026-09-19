import { describe, expect, it } from "vitest"
import { navigate, restartNavigation, startNavigation } from "../../src/domain/navigation"
import {
  reconcileShuffleOrder,
  reshuffleAfterCurrent,
  shuffleAll,
  shuffleFromClicked,
  shuffleFromCurrent,
} from "../../src/domain/shuffle"
import { playlist } from "./fixtures"

function sequenceRng(values: readonly number[]): () => number {
  let index = 0
  return () => {
    const value = values[index % values.length]
    index += 1
    return value ?? 0
  }
}

describe("ID-space shuffle", () => {
  it("produces deterministic permutations for many playlist sizes", () => {
    // Given: deterministic RNG values and unique stable IDs.
    for (let size = 0; size <= 40; size += 1) {
      const ids = Array.from({ length: size }, (_, index) => `item-${index}`)

      // When: shuffled. Then: each identity occurs exactly once.
      const result = shuffleAll(ids, sequenceRng([0.91, 0.17, 0.53, 0.02]))
      if (size === 0) {
        expect(result).toEqual({ kind: "empty-playlist" })
        continue
      }
      expect(result.kind).toBe("ready")
      if (result.kind !== "ready") continue
      expect([...result.order].sort()).toEqual([...ids].sort())
      expect(new Set(result.order).size).toBe(size)
    }
  })

  it("places a clicked item first and reshuffles only after the current item", () => {
    // Given: a clicked item and an active shuffled order.
    const ids = ["a", "b", "c", "d"]
    const clicked = shuffleFromClicked(ids, "c", sequenceRng([0, 0]))
    expect(clicked.kind).toBe("ready")
    if (clicked.kind !== "ready") return

    // When: reshuffling from the current position.
    const reshuffled = reshuffleAfterCurrent({
      itemIds: ids,
      order: ["d", "b", "c", "a"],
      currentItemId: "b",
      random: sequenceRng([0]),
    })

    // Then: clicked/current identity and already-played prefix remain stable.
    expect(clicked.order[0]).toBe("c")
    const fromCurrent = shuffleFromCurrent(ids, "b", sequenceRng([0, 0]))
    expect(fromCurrent.kind).toBe("ready")
    if (fromCurrent.kind === "ready") expect(fromCurrent.order[0]).toBe("b")
    expect(reshuffled).toEqual({ kind: "ready", order: ["d", "b", "a", "c"] })
  })

  it("reconciles stale orders by identity and stops when current was removed", () => {
    // Given: one removed ID, one newly added ID, and a stale duplicate.
    const reconciled = reconcileShuffleOrder(["a", "c", "d"], ["a", "b", "c", "c"], "c")

    // When/Then: surviving order is retained, duplicates removed, and new IDs appended.
    expect(reconciled).toEqual({ kind: "ready", order: ["a", "c", "d"] })
    expect(reconcileShuffleOrder(["a", "c"], ["a", "b", "c"], "b")).toEqual({
      kind: "stop",
      reason: "current-item-removed",
    })
  })

  it("rejects duplicate source identities and invalid RNG output", () => {
    // Given/When/Then: malformed identity/RNG sources fail explicitly.
    expect(shuffleAll(["same", "same"], () => 0)).toEqual({
      kind: "duplicate-id",
      id: "same",
    })
    expect(shuffleAll(["a", "b"], () => 1)).toEqual({ kind: "invalid-random", value: 1 })
  })
})

describe("stable navigation", () => {
  const clock = () => 1_789_776_000_123

  it("navigates by stable item ID after reorder and insertion", () => {
    // Given: playback started at b with an ID order, then playlist positions change.
    const started = startNavigation({
      playlist: playlist("p", ["a", "b", "c"]),
      currentItemId: "b",
      order: ["a", "b", "c"],
      mode: "ordered",
      clock,
    })
    expect(started.kind).toBe("target")
    if (started.kind !== "target") return
    const edited = playlist("p", ["new", "c", "b", "a"])

    // When: moving next. Then: c is selected by identity, never positional index 2 (b).
    const result = navigate({
      playlist: edited,
      playback: started.playback,
      direction: "next",
      clock,
    })
    expect(result.kind).toBe("target")
    if (result.kind !== "target") return
    expect(result.item.id).toBe("c")
    expect(result.playback.currentItemId).toBe("c")
    expect(result.playback.updatedAt).toBe(1_789_776_000_123)
  })

  it("stops explicitly for removed current, deleted, and empty playlists", () => {
    // Given: active playback at b.
    const started = startNavigation({
      playlist: playlist("p", ["a", "b"]),
      currentItemId: "b",
      order: ["a", "b"],
      mode: "shuffle",
      clock,
    })
    expect(started.kind).toBe("target")
    if (started.kind !== "target") return

    // When/Then: destructive edits never silently select another item.
    expect(
      navigate({
        playlist: playlist("p", ["a"]),
        playback: started.playback,
        direction: "next",
        clock,
      }),
    ).toEqual({ kind: "stop", reason: "current-item-removed" })
    expect(
      navigate({ playlist: null, playback: started.playback, direction: "next", clock }),
    ).toEqual({ kind: "stop", reason: "playlist-deleted" })
    expect(
      startNavigation({
        playlist: playlist("p", []),
        currentItemId: "b",
        order: [],
        mode: "ordered",
        clock,
      }),
    ).toEqual({ kind: "stop", reason: "empty-playlist" })
  })

  it("returns explicit boundaries and supports intentional restart", () => {
    // Given: playback at each edge.
    const atStart = startNavigation({
      playlist: playlist("p", ["a", "b"]),
      currentItemId: "a",
      order: ["a", "b"],
      mode: "ordered",
      clock,
    })
    const atEnd = startNavigation({
      playlist: playlist("p", ["a", "b"]),
      currentItemId: "b",
      order: ["a", "b"],
      mode: "ordered",
      clock,
    })
    expect(atStart.kind).toBe("target")
    expect(atEnd.kind).toBe("target")
    if (atStart.kind !== "target" || atEnd.kind !== "target") return

    // When/Then: boundaries do not wrap; restart is a separate explicit action.
    expect(
      navigate({
        playlist: playlist("p", ["a", "b"]),
        playback: atStart.playback,
        direction: "previous",
        clock,
      }),
    ).toEqual({ kind: "boundary", edge: "start" })
    expect(
      navigate({
        playlist: playlist("p", ["a", "b"]),
        playback: atEnd.playback,
        direction: "next",
        clock,
      }),
    ).toEqual({ kind: "boundary", edge: "end" })
    const restarted = restartNavigation(playlist("p", ["a", "b"]), atEnd.playback, clock)
    expect(restarted.kind).toBe("target")
    if (restarted.kind === "target") expect(restarted.item.id).toBe("a")
  })

  it("allows null-range full episodes and rejects stale out-of-bounds mappings", () => {
    // Given: a full episode and an order containing only unknown identities.
    const fullEpisode = playlist("p", ["a"])
    const first = fullEpisode.items[0]
    const local =
      first === undefined ? fullEpisode : { ...fullEpisode, items: [{ ...first, range: null }] }

    // When/Then: null range is a valid target; unknown current mapping stops.
    const started = startNavigation({
      playlist: local,
      currentItemId: "a",
      order: ["a"],
      mode: "ordered",
      clock,
    })
    expect(started.kind).toBe("target")
    if (started.kind === "target") expect(started.item.range).toBeNull()
    expect(
      startNavigation({
        playlist: local,
        currentItemId: "ghost",
        order: ["ghost"],
        mode: "shuffle",
        clock,
      }),
    ).toEqual({ kind: "stop", reason: "current-item-removed" })
  })
})
