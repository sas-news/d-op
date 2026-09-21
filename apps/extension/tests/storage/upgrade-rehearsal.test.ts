// Task-26 module-level upgrade rehearsal — drives the REAL migration path
// (src/storage/migration.ts::loadOrMigrateState behind the repository's lazy
// initialize) against the task-26 seed fixtures, with the fault injections a
// real browser cannot perform deterministically: quota exhaustion mid-
// migration, an interrupted first persistence (resumable), a future schema
// version (fail closed, never downgrade) and a malformed canonical root.
// The real-browser legs (tests/browser/upgrade/*) rehearse the same seed on
// installed v1→v2 profiles; every assertion here is on real stored bytes.
import { describe, expect, it } from "vitest"
import { LEGACY_STORAGE_KEYS, LOCAL_STATE_KEY } from "../../../../packages/shared/src/limits"
import { parseLegacyLibrary } from "../../../../packages/shared/src/local-import"
import {
  EXPECTED,
  LEGACY_KEYS,
  LEGACY_PLAYLISTS,
  legacyStorage,
} from "../../../../tests/browser/upgrade/seed-data"
import {
  InMemoryStorageDriver,
  type StorageDriver,
  StorageWriteError,
} from "../../src/storage/driver"
import {
  FutureLocalSchemaError,
  loadOrMigrateState,
  MalformedLocalStateError,
} from "../../src/storage/migration"
import { createLocalRepository } from "../../src/storage/repository"
import { NOW, operationId } from "./fixtures"

const TRANSIENT_KEY = "dop_v2_transient"
const IMPORTS_KEY = "dop_v2_imports"

function seededDriver(): InMemoryStorageDriver {
  return new InMemoryStorageDriver(legacyStorage())
}

async function storedAll(driver: StorageDriver): Promise<Record<string, unknown>> {
  return driver.get([...LEGACY_KEYS, LOCAL_STATE_KEY, TRANSIENT_KEY, IMPORTS_KEY])
}

describe("upgrade-rehearsal / happy path", () => {
  it("migrates every valid clip/name/order/setting, repairs ids deterministically, quarantines corrupt entries", async () => {
    const driver = seededDriver()
    const state = await loadOrMigrateState(driver, () => NOW)

    // Shared-parser oracle agrees with the hand-computed constants.
    const oracle = parseLegacyLibrary(LEGACY_PLAYLISTS)
    expect(state.playlists).toEqual(oracle.playlists)
    expect(state.playlists).toHaveLength(EXPECTED.migratedPlaylistCount)
    expect(state.playlists.map((p) => p.id)).toEqual([...EXPECTED.migratedPlaylistIds])
    expect(state.playlists.reduce((n, p) => n + p.items.length, 0)).toBe(EXPECTED.migratedItemCount)

    // Fan-out + duplicate + missing-id repair, exactly as seeded.
    expect(state.playlists[2]?.items.map((i) => i.id)).toEqual([...EXPECTED.fanoutIds])
    expect(state.playlists[2]?.items.map((i) => i.range?.name)).toEqual([...EXPECTED.fanoutNames])
    expect(state.playlists[3]?.items.map((i) => i.id)).toEqual([...EXPECTED.duplicateIds])
    expect(state.playlists[4]?.items[1]?.id).toBe(EXPECTED.repairedMissingItemId)
    expect(state.playlists[1]?.items.map((i) => i.range?.name)).toEqual([
      ...EXPECTED.typedRangeNames,
    ])
    // Null-range clip preserved verbatim; empty playlist preserved.
    expect(state.playlists[4]?.items[0]?.range).toBeNull()
    expect(state.playlists[6]?.items).toHaveLength(0)

    // Global id uniqueness after repair.
    const ids = state.playlists.flatMap((p) => p.items.map((i) => i.id))
    expect(new Set(ids).size).toBe(ids.length)

    // Quarantine carries the original bytes with indexed locations.
    expect(state.migrationRecovery?.quarantined).toHaveLength(EXPECTED.quarantinedCount)
    const [itemEntry, playlistEntry] = state.migrationRecovery?.quarantined ?? []
    expect(itemEntry).toMatchObject({ playlistIndex: 5, itemIndex: 1 })
    expect(itemEntry?.originalJson).toContain("逆行区間")
    expect(playlistEntry).toMatchObject({ playlistIndex: 7 })
    expect(playlistEntry?.originalJson).toContain("壊れたリスト")
    expect(state.migrationRecovery?.migrationVersion).toBe(1)
    expect(state.migrationRecovery?.sourceKeys).toEqual([...LEGACY_STORAGE_KEYS])

    // Preferences migrated; every legacy key byte-identical afterwards.
    expect(state.preferences).toEqual(EXPECTED.preferences)
    expect(await driver.get(LEGACY_KEYS)).toEqual(legacyStorage())
    // No transient/import side-channel synthesized from legacy keys.
    expect(await driver.get([TRANSIENT_KEY, IMPORTS_KEY])).toEqual({})
  })

  it("is idempotent and deterministic across re-migration and fresh drivers", async () => {
    const driver = seededDriver()
    const first = await loadOrMigrateState(driver, () => NOW)
    const again = await loadOrMigrateState(driver, () => "2027-01-01T00:00:00.000Z")
    expect(again).toEqual(first) // stored envelope reused, not rebuilt

    const other = seededDriver()
    const fresh = await loadOrMigrateState(other, () => "2030-05-05T00:00:00.000Z")
    expect(fresh.playlists).toEqual(first.playlists) // same repaired ids
    expect(fresh.migrationRecovery?.quarantined).toEqual(first.migrationRecovery?.quarantined)
  })
})

describe("upgrade-rehearsal / quota exhaustion mid-migration", () => {
  it("fails closed: legacy snapshot intact, no envelope, no marker, then resumes", async () => {
    const driver = seededDriver()
    driver.failNextSet(new StorageWriteError("quota"))

    await expect(loadOrMigrateState(driver, () => NOW)).rejects.toBeInstanceOf(StorageWriteError)

    // Old snapshot fully accessible; nothing half-written, no completion lie.
    const stored = await storedAll(driver)
    for (const key of LEGACY_KEYS) expect(stored[key]).toEqual(legacyStorage()[key])
    expect(stored[LOCAL_STATE_KEY]).toBeUndefined()
    expect(stored[TRANSIENT_KEY]).toBeUndefined()
    expect(stored[IMPORTS_KEY]).toBeUndefined()

    // Once space exists the SAME migration retries cleanly (resumable).
    const recovered = await loadOrMigrateState(driver, () => NOW)
    expect(recovered.playlists).toHaveLength(EXPECTED.migratedPlaylistCount)
    expect(await driver.get(LEGACY_KEYS)).toEqual(legacyStorage())
  })

  it("repository dispatch chain is not wedged by a failed initialize", async () => {
    const driver = seededDriver()
    const repository = createLocalRepository({
      driver,
      now: () => NOW,
      newId: () => "fresh",
    })
    driver.failNextSet(new StorageWriteError("storage"))

    await expect(repository.initialize()).rejects.toBeInstanceOf(StorageWriteError)
    // The serialized queue must still accept work after the rejection.
    const state = await repository.readPublic()
    expect(state.playlists).toHaveLength(EXPECTED.migratedPlaylistCount)
    const reply = await repository.dispatch({
      kind: "rename-playlist",
      operationId: operationId(1),
      expectedRevision: state.revision,
      playlistId: "pl-modern",
      name: "renamed-after-fault",
    })
    expect(reply).toMatchObject({ kind: "committed" })
    expect(await driver.get(LEGACY_KEYS)).toEqual(legacyStorage())
  })
})

describe("upgrade-rehearsal / future schema + malformed root", () => {
  it("future canonical schema fails closed without downgrading or touching legacy", async () => {
    const seed: Record<string, unknown> = {
      ...legacyStorage(),
      [LOCAL_STATE_KEY]: { schemaVersion: 3 },
    }
    const driver = new InMemoryStorageDriver(seed)
    const repository = createLocalRepository({
      driver,
      now: () => NOW,
      newId: () => "fresh",
    })

    await expect(repository.initialize()).rejects.toBeInstanceOf(FutureLocalSchemaError)

    const stored = await storedAll(driver)
    expect(stored[LOCAL_STATE_KEY]).toEqual({ schemaVersion: 3 }) // never overwritten
    for (const key of LEGACY_KEYS) expect(stored[key]).toEqual(seed[key])
  })

  it("malformed canonical root fails closed, leaving both snapshots readable", async () => {
    const seed: Record<string, unknown> = {
      ...legacyStorage(),
      [LOCAL_STATE_KEY]: { schemaVersion: 2, nope: true },
    }
    const driver = new InMemoryStorageDriver(seed)

    await expect(loadOrMigrateState(driver, () => NOW)).rejects.toBeInstanceOf(
      MalformedLocalStateError,
    )
    const stored = await storedAll(driver)
    expect(stored[LOCAL_STATE_KEY]).toEqual({ schemaVersion: 2, nope: true })
    for (const key of LEGACY_KEYS) expect(stored[key]).toEqual(seed[key])
  })
})
