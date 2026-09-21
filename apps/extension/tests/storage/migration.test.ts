import { describe, expect, it } from "vitest"
import { InMemoryStorageDriver, StorageWriteError } from "../../src/storage/driver"
import { loadOrMigrateState } from "../../src/storage/migration"
import { NOW } from "./fixtures"

const LEGACY = {
  dop_playlists: [
    {
      id: "same",
      name: "Legacy",
      items: [
        {
          id: "clip",
          partId: "part-1",
          workId: "work-1",
          title: "Work",
          episodeTitle: "Episode",
          episodeNumber: "12.5",
          url: "https://anime.dmkt-sp.jp/animestore/sc_d_pc?partId=part-1",
          opRange: { start: 1_001, end: 91_009 },
          edRange: { start: 1_320_003, end: 1_410_011 },
          customRange: { start: 600_007, end: 660_013 },
        },
      ],
    },
  ],
  dop_playback: { playlistId: "same", index: 0, windowId: 44 },
  dop_pending: { secret: "legacy-private-value" },
  dop_oped_mode: true,
  dop_window_mode: "tab",
  dop_collapsed_playlists: { same: true },
  dop_player_window: { id: 44 },
} as const

describe("legacy-preserving migration", () => {
  it("is deterministic, idempotent, and leaves every legacy key untouched", async () => {
    // Given: historical fan-out data and stale transient ownership.
    const driver = new InMemoryStorageDriver(LEGACY)

    // When: migration runs twice.
    const first = await loadOrMigrateState(driver, () => NOW)
    const second = await loadOrMigrateState(driver, () => "2026-09-19T13:00:00.000Z")

    // Then: the complete envelope is reused byte-for-byte and old keys remain frozen.
    expect(second).toEqual(first)
    expect(first.playlists[0]?.items.map((item) => [item.id, item.range?.name])).toEqual([
      ["clip", "OP"],
      ["clip-c1", "ED"],
      ["clip-c2", "CUSTOM"],
    ])
    expect(first.playlists[0]?.items.map((item) => item.range)).toEqual([
      { start: 1_001, end: 91_009, name: "OP" },
      { start: 1_320_003, end: 1_410_011, name: "ED" },
      { start: 600_007, end: 660_013, name: "CUSTOM" },
    ])
    expect(first.preferences).toEqual({ windowMode: "tab", collapsedPlaylists: { same: true } })
    const all = await driver.get(Object.keys(LEGACY))
    expect(all).toEqual(LEGACY)
    expect(await driver.get(["dop_v2_transient"])).toEqual({})
  })

  it("keeps legacy data and no v2 marker when the atomic write exceeds quota", async () => {
    // Given: a driver whose next write fails like browser quota exhaustion.
    const driver = new InMemoryStorageDriver(LEGACY)
    driver.failNextSet(new StorageWriteError("quota"))

    // When: migration attempts its only v2 write.
    const migration = loadOrMigrateState(driver, () => NOW)

    // Then: failure is explicit, legacy survives, and no completion envelope exists.
    await expect(migration).rejects.toBeInstanceOf(StorageWriteError)
    expect(await driver.get(Object.keys(LEGACY))).toEqual(LEGACY)
    expect(await driver.get(["dop_v2_state"])).toEqual({})
  })

  it("fails closed for a future canonical schema", async () => {
    // Given: storage written by a future extension.
    const driver = new InMemoryStorageDriver({ dop_v2_state: { schemaVersion: 3 } })

    // When: current code loads it.
    const loading = loadOrMigrateState(driver, () => NOW)

    // Then: it is not downgraded or replaced.
    await expect(loading).rejects.toMatchObject({ name: "FutureLocalSchemaError", version: 3 })
    expect(await driver.get(["dop_v2_state"])).toEqual({
      dop_v2_state: { schemaVersion: 3 },
    })
  })
})
