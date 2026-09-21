// Task-11 detach + stale-playback acceptance at the command layer: local-only
// deletion and JSON replace DETACH publication records (localPlaylistId=null,
// state="local-deleted") instead of dropping keys; `discard-publication-
// management` is the distinct typed command that destroys a record; committed
// library-scale removals reconcile the transient playback pointer so a dead
// reference stops cleanly.
import { describe, expect, it } from "vitest"
import type { TransientState } from "../../../../packages/shared/src/local-model"
import {
  InMemoryStorageDriver,
  type StorageDriver,
  StorageWriteError,
} from "../../src/storage/driver"
import { createLocalRepository, type LocalRepository } from "../../src/storage/repository"
import { localItem, operationId } from "../storage/fixtures"
import { NOW_ISO, publicationRecord, transientWithPlayback, v2State } from "./fixtures"

const STATE_KEY = "dop_v2_state"
const TRANSIENT_KEY = "dop_v2_transient"

function repo(driver: StorageDriver): LocalRepository {
  return createLocalRepository({ driver, now: () => NOW_ISO, newId: () => "fresh-id" })
}

async function transient(driver: StorageDriver): Promise<TransientState | undefined> {
  const stored = await driver.get([TRANSIENT_KEY])
  return stored[TRANSIENT_KEY] as TransientState | undefined
}

describe("portable/detach", () => {
  it("delete-playlist detaches its publication record, keeping the key", async () => {
    const driver = new InMemoryStorageDriver({
      [STATE_KEY]: v2State({ publications: [publicationRecord({ localPlaylistId: "p1" })] }),
    })
    const repository = repo(driver)
    await repository.initialize()

    const reply = await repository.dispatch({
      kind: "delete-playlist",
      operationId: operationId(1),
      expectedRevision: 0,
      playlistId: "p1",
    })

    expect(reply).toMatchObject({ kind: "committed" })
    const vault = await repository.readVault()
    expect(vault.publications).toHaveLength(1)
    expect(vault.publications[0]).toMatchObject({
      localPlaylistId: null,
      state: "local-deleted",
      manageSecret: "m".repeat(43),
    })
    expect((await repository.readPublic()).playlists.map((p) => p.id)).toEqual(["p2"])
  })

  it("replace-library detaches records whose playlist vanished", async () => {
    const driver = new InMemoryStorageDriver({
      [STATE_KEY]: v2State({
        publications: [
          publicationRecord({ localPlaylistId: "p1" }),
          publicationRecord({ shareId: "0123456789abcdefghijkl", localPlaylistId: "p2" }),
        ],
      }),
    })
    const repository = repo(driver)
    await repository.initialize()

    await repository.dispatch({
      kind: "replace-library",
      operationId: operationId(2),
      expectedRevision: 0,
      playlists: [
        { id: "p2", name: "Kept", items: [localItem("k1")] },
        { id: "imported", name: "Imported", items: [] },
      ],
    })

    const vault = await repository.readVault()
    const byShare = new Map(vault.publications.map((record) => [record.shareId, record]))
    expect(byShare.get("abcdefghijklmnopqrstuv")).toMatchObject({
      localPlaylistId: null,
      state: "local-deleted",
    })
    expect(byShare.get("0123456789abcdefghijkl")).toMatchObject({
      localPlaylistId: "p2",
      state: "active",
    })
  })

  it("discard-publication-management is the distinct command that destroys a record", async () => {
    const driver = new InMemoryStorageDriver({
      [STATE_KEY]: v2State({
        publications: [
          publicationRecord({ localPlaylistId: null, state: "local-deleted" }),
          publicationRecord({
            shareId: "0123456789abcdefghijkl",
            localPlaylistId: "p2",
          }),
        ],
      }),
    })
    const repository = repo(driver)
    await repository.initialize()

    const reply = await repository.dispatch({
      kind: "discard-publication-management",
      operationId: operationId(3),
      expectedRevision: 0,
      shareId: "abcdefghijklmnopqrstuv",
    })

    expect(reply).toMatchObject({ kind: "committed" })
    const vault = await repository.readVault()
    expect(vault.publications).toHaveLength(1)
    expect(vault.publications[0]?.shareId).toBe("0123456789abcdefghijkl")
  })

  it("clears transient playback when the referenced playlist is deleted", async () => {
    const driver = new InMemoryStorageDriver({
      [STATE_KEY]: v2State(),
      [TRANSIENT_KEY]: transientWithPlayback("p1"),
    })
    const repository = repo(driver)
    await repository.initialize()

    await repository.dispatch({
      kind: "delete-playlist",
      operationId: operationId(4),
      expectedRevision: 0,
      playlistId: "p1",
    })

    const next = await transient(driver)
    expect(next?.playback).toBeUndefined()
    expect(next?.generation).toBe(1)
    // Other transient fields are preserved.
    expect(next?.opedMode).toEqual({ active: true, updatedAt: 1_700_000_000_000 })
  })

  it("clears transient playback when replace-library drops the playlist", async () => {
    const driver = new InMemoryStorageDriver({
      [STATE_KEY]: v2State(),
      [TRANSIENT_KEY]: transientWithPlayback("p1"),
    })
    const repository = repo(driver)
    await repository.initialize()

    await repository.dispatch({
      kind: "replace-library",
      operationId: operationId(5),
      expectedRevision: 0,
      playlists: [{ id: "imported", name: "Imported", items: [] }],
    })

    expect((await transient(driver))?.playback).toBeUndefined()
  })

  it("keeps playback that still resolves after replace-library", async () => {
    const driver = new InMemoryStorageDriver({
      [STATE_KEY]: v2State(),
      [TRANSIENT_KEY]: transientWithPlayback("p1", 1),
    })
    const repository = repo(driver)
    await repository.initialize()

    await repository.dispatch({
      kind: "replace-library",
      operationId: operationId(6),
      expectedRevision: 0,
      // Same playlist id with the same items appended — index 1 still resolves.
      playlists: [
        {
          id: "p1",
          name: "Playlist p1",
          items: [localItem("a"), localItem("b"), localItem("c"), localItem("d")],
        },
      ],
    })

    const next = await transient(driver)
    expect(next?.playback).toMatchObject({ playlistId: "p1", index: 1 })
  })

  it("clears playback whose index can no longer resolve", async () => {
    const driver = new InMemoryStorageDriver({
      [STATE_KEY]: v2State(),
      [TRANSIENT_KEY]: transientWithPlayback("p1", 99),
    })
    const repository = repo(driver)
    await repository.initialize()

    await repository.dispatch({
      kind: "delete-playlist",
      operationId: operationId(7),
      expectedRevision: 0,
      playlistId: "p2", // p1 survives but index 99 is out of range
    })

    expect((await transient(driver))?.playback).toBeUndefined()
  })

  it("still commits the canonical mutation when the transient write fails", async () => {
    const base = new InMemoryStorageDriver({
      [STATE_KEY]: v2State(),
      [TRANSIENT_KEY]: transientWithPlayback("p1"),
    })
    const driver: StorageDriver = {
      get: (keys) => base.get(keys),
      set: async (values) => {
        if (TRANSIENT_KEY in values) throw new StorageWriteError("quota")
        return base.set(values)
      },
    }
    const repository = repo(driver)
    await repository.initialize()

    const reply = await repository.dispatch({
      kind: "delete-playlist",
      operationId: operationId(8),
      expectedRevision: 0,
      playlistId: "p1",
    })

    // Canonical commit stands; the dangling pointer stays unresolvable at read.
    expect(reply).toMatchObject({ kind: "committed" })
    expect((await repository.readPublic()).playlists.map((p) => p.id)).toEqual(["p2"])
    expect((await transient(driver))?.playback?.playlistId).toBe("p1")
  })

  it("does not create a transient record when none existed", async () => {
    const driver = new InMemoryStorageDriver({ [STATE_KEY]: v2State() })
    const repository = repo(driver)
    await repository.initialize()

    await repository.dispatch({
      kind: "delete-playlist",
      operationId: operationId(9),
      expectedRevision: 0,
      playlistId: "p1",
    })

    expect(await transient(driver)).toBeUndefined()
  })
})
