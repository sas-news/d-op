import { describe, expect, it } from "vitest"
import { LOCAL_STATE_KEY, TRANSIENT_STATE_KEY } from "../../../../packages/shared/src/limits"
import { emptyTransientState } from "../../src/storage/transient"
import {
  createUiStorageClient,
  runMutation,
  type StorageChangeSurface,
  subscribePublicState,
  subscribeTransientState,
  UiStorageError,
} from "../../src/ui/storage-client"
import { playlist } from "../domain/fixtures"

const PUBLIC_REPLY = {
  schemaVersion: 2 as const,
  revision: 7,
  playlists: [playlist("p1")],
  preferences: { windowMode: "window" as const, collapsedPlaylists: {} },
}

function fakeSend(routes: Record<string, unknown>): {
  sent: unknown[]
  send: (message: { type: string }) => Promise<unknown>
} {
  const sent: unknown[] = []
  const send = async (message: { type: string }): Promise<unknown> => {
    sent.push(message)
    return routes[message.type]
  }
  return { sent, send }
}

describe("ui/storage-client", () => {
  it("readPublic validates and projects the public envelope", async () => {
    const { sent, send } = fakeSend({ DOP_STORAGE_READ_PUBLIC: PUBLIC_REPLY })
    const client = createUiStorageClient(send)
    const state = await client.readPublic()
    expect(state.revision).toBe(7)
    expect(state.playlists).toHaveLength(1)
    expect(sent).toEqual([{ type: "DOP_STORAGE_READ_PUBLIC" }])
  })

  it("readPublic rejects malformed replies with UiStorageError", async () => {
    const { send } = fakeSend({ DOP_STORAGE_READ_PUBLIC: { bogus: true } })
    const client = createUiStorageClient(send)
    await expect(client.readPublic()).rejects.toBeInstanceOf(UiStorageError)
  })

  it("dispatch parses committed replies and rejects unknown kinds", async () => {
    const committed = {
      send: async () => ({ kind: "committed", operationId: "op", revision: 9 }),
    }
    const client = createUiStorageClient(committed.send)
    const reply = await client.dispatch({
      kind: "create-playlist",
      name: "x",
      operationId: "op",
      expectedRevision: 8,
    })
    expect(reply).toEqual({ kind: "committed", operationId: "op", revision: 9 })

    const bad = createUiStorageClient(async () => ({ kind: "??" }))
    await expect(
      bad.dispatch({ kind: "create-playlist", name: "x", operationId: "o", expectedRevision: 0 }),
    ).rejects.toBeInstanceOf(UiStorageError)
  })

  it("runMutation retries revision-conflict with the SAME operationId", async () => {
    const seenOperationIds: string[] = []
    let revisions = [3, 4]
    const client = {
      readPublic: async () => ({
        ...PUBLIC_REPLY,
        revision: revisions[0] ?? 4,
      }),
      dispatch: async (command: { operationId: string; expectedRevision: number }) => {
        seenOperationIds.push(command.operationId)
        if (command.expectedRevision === 3) {
          revisions = [4]
          return { kind: "revision-conflict" as const, actualRevision: 4, expectedRevision: 3 }
        }
        return { kind: "committed" as const, operationId: command.operationId, revision: 5 }
      },
    }
    const reply = await runMutation(
      client,
      () => ({ kind: "create-playlist", name: "n" }),
      () => "op-fixed",
    )
    expect(reply.kind).toBe("committed")
    expect(seenOperationIds).toEqual(["op-fixed", "op-fixed"])
  })

  it("runMutation returns mutation-rejected when build declines", async () => {
    const client = {
      readPublic: async () => PUBLIC_REPLY,
      dispatch: async () => {
        throw new Error("must not dispatch")
      },
    }
    const reply = await runMutation(
      client,
      () => null,
      () => "op",
    )
    expect(reply).toEqual({ kind: "mutation-rejected", reason: "no-change" })
  })
})

describe("ui/storage-client subscriptions", () => {
  function fakeSurface(): {
    surface: StorageChangeSurface
    fire: (changes: Record<string, { newValue?: unknown }>, area?: string) => void
    listenerCount: () => number
  } {
    const listeners = new Set<
      (changes: Record<string, { newValue?: unknown }>, area: string) => void
    >()
    return {
      surface: {
        addListener: (l) => listeners.add(l),
        removeListener: (l) => listeners.delete(l),
      },
      fire: (changes, area = "local") => {
        for (const l of [...listeners]) l(changes, area)
      },
      listenerCount: () => listeners.size,
    }
  }

  it("subscribePublicState fires only on the canonical key in the local area", () => {
    const { surface, fire, listenerCount } = fakeSurface()
    const seen: number[] = []
    const unsubscribe = subscribePublicState(surface, (state) => seen.push(state.revision))
    // The stored value is the FULL canonical state (strict envelope with
    // publications/pendingCreates/appliedOperations) — not the readPublic
    // projection. Regression: a picked strict schema rejected it and every
    // re-render subscription silently died.
    const canonical = {
      ...PUBLIC_REPLY,
      publications: [],
      pendingCreates: [],
      appliedOperations: [],
    }
    fire({ [LOCAL_STATE_KEY]: { newValue: { ...canonical, revision: 11 } } })
    fire({ other_key: { newValue: canonical } })
    fire({ [LOCAL_STATE_KEY]: { newValue: canonical } }, "sync")
    fire({ [LOCAL_STATE_KEY]: { newValue: { not: "a state" } } })
    expect(seen).toEqual([11])
    unsubscribe()
    expect(listenerCount()).toBe(0)
  })

  it("subscribeTransientState validates the transient envelope", () => {
    const { surface, fire } = fakeSurface()
    const seen: number[] = []
    subscribeTransientState(surface, (state) => seen.push(state.generation))
    fire({ [TRANSIENT_STATE_KEY]: { newValue: { ...emptyTransientState(), generation: 42 } } })
    fire({ [TRANSIENT_STATE_KEY]: { newValue: { generation: "nan" } } })
    expect(seen).toEqual([42])
  })
})
