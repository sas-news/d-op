import { describe, expect, it } from "vitest"
import { InMemoryStorageDriver } from "../../src/storage/driver"
import {
  emptyTransientState,
  readTransientState,
  writeTransientState,
} from "../../src/storage/transient"

describe("transient storage envelope", () => {
  it("starts without stale legacy window ownership", async () => {
    // Given: only stale legacy playback and window ids.
    const driver = new InMemoryStorageDriver({
      dop_playback: { playlistId: "old", index: 1, windowId: 77 },
      dop_player_window: { id: 77 },
    })

    // When: the typed transient envelope is read.
    const transient = await readTransientState(driver)

    // Then: no legacy owner is activated.
    expect(transient).toEqual(emptyTransientState())
  })

  it("round-trips explicit owner generation data", async () => {
    // Given: a typed owner token and generation.
    const driver = new InMemoryStorageDriver()
    const transient = {
      schemaVersion: 1,
      generation: 4,
      playerWindow: {
        windowId: 88,
        ownerToken: "00000000-0000-4000-8000-000000000088",
        ownerGeneration: 4,
      },
    } as const

    // When: background transient storage persists the envelope.
    await writeTransientState(driver, transient)

    // Then: ownership remains explicit and typed.
    await expect(readTransientState(driver)).resolves.toEqual(transient)
  })
})
