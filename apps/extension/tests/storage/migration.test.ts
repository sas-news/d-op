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

describe("v1 real-world payload shapes", () => {
  it("migrates a dop_playlists value stored as a JSON string", async () => {
    // Given: the legacy key holds stringified JSON (devtools edits / export
    // channels have produced this) — v2.0.0 threw and rendered empty.
    const playlists = [
      {
        id: "pl-str",
        name: "文字列化リスト",
        items: [
          {
            id: "s1",
            partId: "pt_str",
            title: "作品",
            episodeTitle: "第1話",
            range: { start: 0, end: 90_000, name: "OP" },
          },
        ],
      },
    ]
    const driver = new InMemoryStorageDriver({
      dop_playlists: JSON.stringify(playlists),
    })

    const state = await loadOrMigrateState(driver, () => NOW)

    expect(state.playlists.map((p) => p.id)).toEqual(["pl-str"])
    expect(state.migrationRecovery?.quarantined).toHaveLength(0)
  })

  it("keeps the extension usable when dop_playlists is unparseable", async () => {
    // Given: a payload even the lenient importer cannot read.
    const driver = new InMemoryStorageDriver({ dop_playlists: "{not json" })

    // When: migration runs.
    const state = await loadOrMigrateState(driver, () => NOW)

    // Then: an empty library with the raw bytes parked in quarantine — the
    // initialize no longer rejects forever, and legacy keys survive for a
    // later repair.
    expect(state.playlists).toEqual([])
    expect(state.migrationRecovery?.quarantined).toHaveLength(1)
    expect(state.migrationRecovery?.quarantined[0]?.originalJson).toContain("not json")
    expect(await driver.get(["dop_playlists"])).toEqual({ dop_playlists: "{not json" })
  })

  it("recovers empty-workId clips v1 wrote instead of losing them", async () => {
    // Given: v1's item writer persisted workId: '' whenever lookup failed.
    const driver = new InMemoryStorageDriver({
      dop_playlists: [
        {
          id: "pl-v1",
          name: "v1リスト",
          items: [
            {
              id: "w1",
              partId: "pt_w1",
              workId: "",
              title: "作品",
              episodeTitle: "第2話",
              episodeNumber: "2",
              url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=pt_w1",
              range: { start: 60_000, end: 150_000, name: "OP" },
            },
            {
              id: "w2",
              partId: "",
              title: "作品2",
              episodeTitle: "第4話",
              url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=pt_rescued",
              range: null,
            },
          ],
        },
      ],
    })

    const state = await loadOrMigrateState(driver, () => NOW)

    const items = state.playlists[0]?.items ?? []
    expect(state.migrationRecovery?.quarantined).toHaveLength(0)
    expect(items).toHaveLength(2)
    expect(items[0]?.workId).toBeUndefined()
    expect(items[1]?.partId).toBe("pt_rescued")
  })
})

describe("v2.0.0 quarantine repair", () => {
  // A canonical state as the v2.0.0 importer produced it: no parserVersion,
  // the unlucky entries listed in migrationRecovery.quarantined.
  const legacyRepairPlaylists = [
    {
      id: "pl-a",
      name: "残す",
      items: [
        {
          id: "ok",
          partId: "pt_ok",
          title: "A",
          episodeTitle: "1",
          range: { start: 0, end: 90_000, name: "OP" },
        },
        {
          id: "lost",
          partId: "pt_lost",
          workId: "",
          title: "B",
          episodeTitle: "2",
          range: { start: 0, end: 60_000, name: "ED" },
        },
      ],
    },
    {
      id: "pl-b",
      name: "",
      items: [
        {
          id: "q1",
          partId: "pt_q1",
          title: "C",
          episodeTitle: "3",
          range: null,
        },
      ],
    },
    {
      id: "pl-c",
      name: "消す",
      items: [
        {
          id: "gone",
          partId: "pt_gone",
          title: "D",
          episodeTitle: "4",
          range: null,
        },
      ],
    },
  ]
  const v200State = {
    schemaVersion: 2,
    revision: 3,
    playlists: [
      // pl-a migrated with only "ok"; "lost" was quarantined. The user then
      // deleted "ok" under v2.0.0 — repair must not resurrect it.
      { id: "pl-a", name: "残す", items: [] },
      // pl-c migrated fully, then the user deleted the whole playlist.
    ],
    publications: [],
    pendingCreates: [],
    preferences: { windowMode: "window", collapsedPlaylists: {} },
    appliedOperations: [],
    migrationRecovery: {
      quarantined: [
        {
          playlistIndex: 0,
          itemIndex: 1,
          originalJson: JSON.stringify(legacyRepairPlaylists[0]?.items[1]),
          issues: ["items.1.workId"],
          reason: "String must contain at least 1 character(s)",
        },
        {
          playlistIndex: 1,
          originalJson: JSON.stringify(legacyRepairPlaylists[1]),
          issues: ["name"],
          reason: "String must contain at least 1 character(s)",
        },
      ],
      migratedAt: NOW,
      migrationVersion: 1,
      sourceKeys: ["dop_playlists"],
    },
  }

  it("merges quarantined items back, recovers quarantined playlists, and never resurrects deletions", async () => {
    // Given: the v2.0.0 envelope above with the legacy keys still intact.
    const driver = new InMemoryStorageDriver({
      dop_v2_state: structuredClone(v200State),
      dop_playlists: legacyRepairPlaylists,
    })

    const state = await loadOrMigrateState(driver, () => NOW)

    // pl-a gains only the quarantined "lost" clip — "ok" stays deleted.
    const plA = state.playlists.find((p) => p.id === "pl-a")
    expect(plA?.items.map((item) => item.id)).toEqual(["lost"])
    expect(plA?.items[0]?.workId).toBeUndefined()

    // pl-b was quarantined whole under v2.0.0 (empty name); it comes back
    // with the deterministic fallback name.
    const plB = state.playlists.find((p) => p.id === "pl-b")
    expect(plB?.name).toBe("プレイリスト 2")
    expect(plB?.items.map((item) => item.id)).toEqual(["q1"])

    // pl-c was deleted by the user after migrating — never resurrected.
    expect(state.playlists.find((p) => p.id === "pl-c")).toBeUndefined()
    expect(state.playlists).toHaveLength(2)

    // Everything parses now: quarantine drains and the repair is stamped.
    expect(state.migrationRecovery?.quarantined).toHaveLength(0)
    expect(state.migrationRecovery?.parserVersion).toBe(2)
    expect(state.revision).toBe(4)

    // Legacy keys remain untouched.
    const legacy = await driver.get(["dop_playlists"])
    expect(legacy["dop_playlists"]).toEqual(legacyRepairPlaylists)
  })

  it("runs the repair exactly once — the stamped version skips re-import", async () => {
    const driver = new InMemoryStorageDriver({
      dop_v2_state: structuredClone(v200State),
      dop_playlists: legacyRepairPlaylists,
    })

    const first = await loadOrMigrateState(driver, () => NOW)
    const stored = await driver.get(["dop_v2_state"])
    const second = await loadOrMigrateState(driver, () => "2030-01-01T00:00:00.000Z")

    // Second pass returns the persisted envelope without further writes.
    expect(second).toEqual(first)
    expect(stored["dop_v2_state"]).toMatchObject({
      migrationRecovery: { parserVersion: 2, quarantined: [] },
    })
  })
})
