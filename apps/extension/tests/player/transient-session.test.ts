import { describe, expect, it } from "vitest"
import type {
  LocalItem,
  LocalPlaylist,
  TransientPlayback,
  TransientState,
} from "../../../../packages/shared/src/local-model"
import {
  type ActivePlayback,
  fromTransientPlayback,
  isOpEdModeFresh,
  isPlaybackFresh,
  mutateTransientState,
  toTransientPlayback,
  withOpEdMode,
  withOwnedPlaybackCleared,
  withPlayback,
} from "../../src/player/transient-session"
import { InMemoryStorageDriver } from "../../src/storage/driver"
import { readTransientState, writeTransientState } from "../../src/storage/transient"

const OWNER = { token: "11111111-1111-4111-8111-111111111111", generation: 3 }
const OTHER_OWNER = { token: "22222222-2222-4222-8222-222222222222", generation: 1 }

const playlist: LocalPlaylist = {
  id: "pl-1",
  name: "P",
  items: [
    {
      id: "a",
      partId: "p1",
      title: "W",
      episodeTitle: "E1",
      url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=p1",
      range: { start: 10_000, end: 90_000, name: "OP" },
    },
    {
      id: "b",
      partId: "p2",
      title: "W",
      episodeTitle: "E2",
      range: null,
    },
    {
      id: "c",
      partId: "p1",
      title: "W",
      episodeTitle: "E1",
      range: { start: 100_000, end: 140_000, name: "ED" },
    },
  ],
}

function active(overrides: Partial<ActivePlayback> = {}): ActivePlayback {
  return {
    playlistId: "pl-1",
    order: ["a", "b", "c"],
    currentItemId: "a",
    item: playlist.items.at(0) as LocalItem,
    mode: "ordered",
    endMenuShown: false,
    ...overrides,
  }
}

describe("toTransientPlayback", () => {
  it("ordered mode stores the order position as index, no shuffledIndices", () => {
    const result = toTransientPlayback(active({ currentItemId: "c" }), playlist, OWNER, 1000)
    expect(result).toEqual({
      kind: "ok",
      playback: {
        playlistId: "pl-1",
        index: 2,
        updatedAt: 1000,
        ownerToken: OWNER.token,
        ownerGeneration: 3,
      },
    })
  })

  it("shuffle mode maps order positions to real playlist indexes", () => {
    const result = toTransientPlayback(
      active({ order: ["c", "a", "b"], currentItemId: "a", mode: "shuffle" }),
      playlist,
      OWNER,
      1000,
    )
    expect(result).toEqual({
      kind: "ok",
      playback: {
        playlistId: "pl-1",
        index: 1,
        shuffledIndices: [2, 0, 1],
        updatedAt: 1000,
        ownerToken: OWNER.token,
        ownerGeneration: 3,
      },
    })
  })

  it("rejects shuffle playback whose order fell out of the playlist", () => {
    // Ordered mode stores a bare position; only shuffle order→index mapping
    // can fail when an order id no longer resolves to a playlist row.
    const result = toTransientPlayback(
      active({ order: ["a", "gone"], currentItemId: "gone", mode: "shuffle" }),
      playlist,
      OWNER,
      1000,
    )
    expect(result).toEqual({ kind: "unresolved-order" })
  })
})

describe("fromTransientPlayback", () => {
  const stored = (overrides: Partial<TransientPlayback>): TransientPlayback => ({
    playlistId: "pl-1",
    index: 0,
    updatedAt: 1000,
    ownerToken: OWNER.token,
    ownerGeneration: 1,
    ...overrides,
  })

  it("restores ordered playback in item-ID space", () => {
    expect(fromTransientPlayback(stored({ index: 2 }), playlist)).toEqual({
      playlistId: "pl-1",
      currentItemId: "c",
      order: ["a", "b", "c"],
      mode: "ordered",
    })
  })

  it("resolves the stored index through shuffledIndices", () => {
    expect(
      fromTransientPlayback(stored({ index: 1, shuffledIndices: [2, 0, 1] }), playlist),
    ).toEqual({
      playlistId: "pl-1",
      currentItemId: "a",
      order: ["c", "a", "b"],
      mode: "shuffle",
    })
  })

  it("returns null for out-of-range indexes and dangling order entries", () => {
    expect(fromTransientPlayback(stored({ index: 9 }), playlist)).toBeNull()
    expect(fromTransientPlayback(stored({ index: 0, shuffledIndices: [99] }), playlist)).toBeNull()
  })

  it("round-trips through toTransientPlayback", () => {
    const written = toTransientPlayback(
      active({ order: ["b", "c", "a"], currentItemId: "c", mode: "shuffle" }),
      playlist,
      OWNER,
      42,
    )
    if (written.kind !== "ok") throw new Error("expected ok")
    expect(fromTransientPlayback(written.playback, playlist)).toEqual({
      playlistId: "pl-1",
      currentItemId: "c",
      order: ["b", "c", "a"],
      mode: "shuffle",
    })
  })
})

describe("freshness windows", () => {
  const stored: TransientPlayback = {
    playlistId: "pl-1",
    index: 0,
    updatedAt: 1_000,
    ownerToken: OWNER.token,
    ownerGeneration: 1,
  }
  it("playback resume expires after 5 minutes (legacy DOP_RESUME_MAX_AGE_MS)", () => {
    expect(isPlaybackFresh(stored, 1_000 + 5 * 60 * 1000)).toBe(true)
    expect(isPlaybackFresh(stored, 1_000 + 5 * 60 * 1000 + 1)).toBe(false)
  })
  it("op-ed intent expires after 5 minutes (legacy DOP_OPED_MODE_MAX_AGE_MS)", () => {
    const state: TransientState = {
      schemaVersion: 1,
      generation: 0,
      opedMode: { active: true, updatedAt: 1_000 },
    }
    expect(isOpEdModeFresh(state, 1_000 + 299_999)).toBe(true)
    expect(isOpEdModeFresh(state, 1_000 + 300_000)).toBe(false)
    expect(isOpEdModeFresh({ schemaVersion: 1, generation: 0 }, 1_000)).toBe(false)
  })
})

describe("owner guard", () => {
  it("withOwnedPlaybackCleared only clears the caller's own record", () => {
    const state: TransientState = {
      schemaVersion: 1,
      generation: 2,
      playback: {
        playlistId: "pl-1",
        index: 0,
        updatedAt: 1,
        ownerToken: OWNER.token,
        ownerGeneration: 1,
      },
    }
    expect(withOwnedPlaybackCleared(state, OTHER_OWNER.token)).toBe(state)
    expect(withOwnedPlaybackCleared(state, OWNER.token).playback).toBeUndefined()
  })
})

describe("mutateTransientState", () => {
  it("bumps generation, preserves foreign fields and round-trips the driver", async () => {
    const driver = new InMemoryStorageDriver()
    const initial: TransientState = {
      schemaVersion: 1,
      generation: 7,
      playerWindow: { windowId: 42, ownerToken: OWNER.token, ownerGeneration: 1, width: 800 },
    }
    await writeTransientState(driver, initial)
    const next = await mutateTransientState(
      () => readTransientState(driver),
      (state) => writeTransientState(driver, state),
      (current) => withOpEdMode(current, true, 500),
    )
    expect(next.generation).toBe(8)
    expect(next.playerWindow?.windowId).toBe(42)
    expect(next.opedMode).toEqual({ active: true, updatedAt: 500 })
    expect((await readTransientState(driver)).generation).toBe(8)
  })

  it("withPlayback deletes rather than writes undefined", () => {
    const state: TransientState = {
      schemaVersion: 1,
      generation: 0,
      playback: {
        playlistId: "pl-1",
        index: 0,
        updatedAt: 1,
        ownerToken: OWNER.token,
        ownerGeneration: 1,
      },
    }
    const cleared = withPlayback(state, undefined)
    expect("playback" in cleared).toBe(false)
  })
})
