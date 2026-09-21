import { describe, expect, it } from "vitest"
import { InMemoryStorageDriver, StorageWriteError } from "../../src/storage/driver"
import { createLocalRepository } from "../../src/storage/repository"
import { localItem, NOW, operationId } from "./fixtures"

describe("background local repository", () => {
  it("serializes concurrent writes without losing additions", async () => {
    // Given: one initialized repository and two clients at successive revisions.
    const driver = new InMemoryStorageDriver()
    const repository = createLocalRepository({
      driver,
      now: () => NOW,
      newId: () => "playlist-1",
    })
    await repository.initialize()
    const create = await repository.dispatch({
      kind: "create-playlist",
      operationId: operationId(1),
      expectedRevision: 0,
      name: "Favorites",
    })
    expect(create).toMatchObject({ kind: "committed", revision: 1 })

    // When: clients submit additions concurrently through the single writer.
    const first = repository.dispatch({
      kind: "add-item",
      operationId: operationId(2),
      expectedRevision: 1,
      playlistId: "playlist-1",
      item: localItem("item-a"),
    })
    const second = repository.dispatch({
      kind: "add-item",
      operationId: operationId(3),
      expectedRevision: 2,
      playlistId: "playlist-1",
      item: localItem("item-b"),
    })

    // Then: both commits survive in submission order.
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "committed", operationId: operationId(2), revision: 2 },
      { kind: "committed", operationId: operationId(3), revision: 3 },
    ])
    expect((await repository.readPublic()).playlists[0]?.items.map((item) => item.id)).toEqual([
      "item-a",
      "item-b",
    ])
  })

  it("replays a persisted receipt after restart without duplicating an addition", async () => {
    // Given: a commit persisted before its acknowledgement was observed.
    const driver = new InMemoryStorageDriver()
    const firstRepository = createLocalRepository({
      driver,
      now: () => NOW,
      newId: () => "unused",
    })
    await firstRepository.initialize()
    await firstRepository.dispatch({
      kind: "replace-library",
      operationId: operationId(10),
      expectedRevision: 0,
      playlists: [{ id: "playlist-1", name: "One", items: [] }],
    })
    const request = {
      kind: "add-item",
      operationId: operationId(11),
      expectedRevision: 1,
      playlistId: "playlist-1",
      item: localItem("item-a"),
    } as const
    const committed = await firstRepository.dispatch(request)
    const restarted = createLocalRepository({ driver, now: () => NOW, newId: () => "unused" })
    await restarted.initialize()

    // When: the exact operation is retried with its original revision.
    const replayed = await restarted.dispatch(request)

    // Then: the persisted result is replayed and the item exists once.
    expect(replayed).toEqual(committed)
    expect((await restarted.readPublic()).playlists[0]?.items).toHaveLength(1)
  })

  it("rejects operation id reuse with a different request", async () => {
    // Given: a committed operation receipt.
    const repository = createLocalRepository({
      driver: new InMemoryStorageDriver(),
      now: () => NOW,
      newId: () => "playlist-1",
    })
    await repository.initialize()
    await repository.dispatch({
      kind: "create-playlist",
      operationId: operationId(20),
      expectedRevision: 0,
      name: "Original",
    })

    // When: the same operation id carries a different request.
    const result = await repository.dispatch({
      kind: "create-playlist",
      operationId: operationId(20),
      expectedRevision: 0,
      name: "Different",
    })

    // Then: no second mutation occurs.
    expect(result).toEqual({ kind: "operation-conflict", operationId: operationId(20) })
    expect((await repository.readPublic()).playlists).toHaveLength(1)
  })

  it("rejects stale revisions without partially writing", async () => {
    // Given: revision one.
    const driver = new InMemoryStorageDriver()
    const repository = createLocalRepository({
      driver,
      now: () => NOW,
      newId: () => "playlist-1",
    })
    await repository.initialize()
    await repository.dispatch({
      kind: "create-playlist",
      operationId: operationId(30),
      expectedRevision: 0,
      name: "Original",
    })

    // When: a stale client attempts another write.
    const result = await repository.dispatch({
      kind: "rename-playlist",
      operationId: operationId(31),
      expectedRevision: 0,
      playlistId: "playlist-1",
      name: "Stale",
    })

    // Then: state and receipt ledger remain unchanged.
    expect(result).toEqual({ kind: "revision-conflict", actualRevision: 1, expectedRevision: 0 })
    const persisted: Record<string, unknown> & { readonly dop_v2_state?: unknown } =
      await driver.get(["dop_v2_state"])
    expect(persisted.dop_v2_state).toMatchObject({
      revision: 1,
      playlists: [{ name: "Original" }],
      appliedOperations: [{ operationId: operationId(30) }],
    })
  })

  it("bounds persisted receipts to the latest 256 operations", async () => {
    // Given: one playlist followed by more mutations than the receipt budget.
    const driver = new InMemoryStorageDriver()
    const repository = createLocalRepository({
      driver,
      now: () => NOW,
      newId: () => "playlist-1",
    })
    await repository.initialize()
    await repository.dispatch({
      kind: "create-playlist",
      operationId: operationId(1),
      expectedRevision: 0,
      name: "Start",
    })

    // When: 257 further commits are serialized.
    for (let revision = 1; revision <= 257; revision += 1) {
      await repository.dispatch({
        kind: "rename-playlist",
        operationId: operationId(revision + 1),
        expectedRevision: revision,
        playlistId: "playlist-1",
        name: `Name ${revision}`,
      })
    }

    // Then: only the deterministic newest receipt window remains.
    const persisted: Record<string, unknown> & { readonly dop_v2_state?: unknown } =
      await driver.get(["dop_v2_state"])
    expect(persisted.dop_v2_state).toMatchObject({
      appliedOperations: expect.arrayContaining([
        expect.objectContaining({ operationId: operationId(3) }),
        expect.objectContaining({ operationId: operationId(258) }),
      ]),
    })
    const state = persisted.dop_v2_state
    expect(
      typeof state === "object" && state !== null && "appliedOperations" in state
        ? state.appliedOperations
        : [],
    ).toHaveLength(256)
  })

  it("does not publish a receipt or state change when persistence fails", async () => {
    // Given: initialized storage that will reject the next atomic set.
    const driver = new InMemoryStorageDriver()
    const repository = createLocalRepository({
      driver,
      now: () => NOW,
      newId: () => "playlist-1",
    })
    await repository.initialize()
    driver.failNextSet(new StorageWriteError("quota"))
    const command = {
      kind: "create-playlist",
      operationId: operationId(300),
      expectedRevision: 0,
      name: "Retryable",
    } as const

    // When: the commit fails and the exact command is retried.
    await expect(repository.dispatch(command)).rejects.toMatchObject({ name: "StorageWriteError" })
    const retry = await repository.dispatch(command)

    // Then: the retry commits exactly once from the unchanged revision.
    expect(retry).toEqual({ kind: "committed", operationId: operationId(300), revision: 1 })
    expect((await repository.readPublic()).playlists).toHaveLength(1)
  })
})
