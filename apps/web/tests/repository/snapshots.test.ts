import { beforeAll, describe, expect, it } from "vitest"
import { canonicalString } from "../../../../packages/shared/src/index"
import { readOperationRow } from "../../src/server/repositories/guard.js"
import { deleteExpiredPending } from "../../src/server/repositories/maintenance.js"
import { activateSnapshot } from "../../src/server/repositories/snapshots/activate.js"
import { createPendingSnapshot } from "../../src/server/repositories/snapshots/create.js"
import { deleteSnapshot } from "../../src/server/repositories/snapshots/delete.js"
import {
  getActiveSnapshot,
  getSnapshot,
  listShareIdsByTag,
  listTagLinks,
} from "../../src/server/repositories/snapshots/read.js"
import { replaceSnapshot } from "../../src/server/repositories/snapshots/replace.js"
import {
  db,
  hashOf,
  makePlaylist,
  migratedDb,
  newOperationKey,
  newSecretHash,
  newShareId,
} from "./helpers.js"

// Happy-path lifecycle over real D1: create -> activate -> replace -> delete,
// with exact item order, denormalized and relational tag state checked at
// every step.

const NOW = new Date("2026-03-01T12:00:00.000Z")

describe("snapshot repository lifecycle", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("creates a pending snapshot with exact order, tags and receipt", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    const playlist = makePlaylist({ itemCount: 5 })
    const contentHash = await hashOf(playlist)
    const result = await createPendingSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: newOperationKey(),
      playlist,
      contentHash,
      now: NOW,
    })
    expect(result.kind).toBe("applied")
    if (result.kind !== "applied") return
    expect(result.outcome.revision).toBe(1)
    expect(result.outcome.state).toBe("pending")
    expect(result.outcome.contentHash).toBe(contentHash)
    expect(result.outcome.activationExpiresAt).toBe("2026-03-01T13:00:00.000Z")

    const stored = await getSnapshot(db(), shareId)
    if (stored === null) throw new Error("expected stored snapshot")
    expect(stored.state).toBe("pending")
    expect(stored.snapshot.items.map((item) => item.partId)).toEqual(
      playlist.items.map((item) => item.partId),
    )
    expect(canonicalString(stored.snapshot)).toBe(canonicalString(playlist))
    expect(stored.tags).toEqual(["tag-one", "tag-two"])
    expect(stored.itemCount).toBe(5)
    expect(stored.totalDurationMs).toBe(5 * 90000)
    expect(await listTagLinks(db(), shareId)).toEqual(["tag-one", "tag-two"])
    expect(await listShareIdsByTag(db(), "tag-one")).toContain(shareId)
    // Pending is never publicly readable.
    expect(await getActiveSnapshot(db(), shareId)).toBeNull()
  })

  it("activates pending -> active at revision 2 with first_published_at", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    const playlist = makePlaylist({})
    await createPendingSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: newOperationKey(),
      playlist,
      contentHash: await hashOf(playlist),
      now: NOW,
    })
    const result = await activateSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: newOperationKey(),
      expectedRevision: 1,
      now: new Date("2026-03-01T12:30:00.000Z"),
    })
    expect(result.kind).toBe("applied")
    if (result.kind !== "applied") return
    expect(result.outcome.revision).toBe(2)
    expect(result.outcome.publishedAt).toBe("2026-03-01T12:30:00.000Z")

    const active = await getActiveSnapshot(db(), shareId)
    expect(active?.revision).toBe(2)
    expect(active?.firstPublishedAt).toBe("2026-03-01T12:30:00.000Z")
    expect(active?.activationExpiresAt).toBeNull()
  })

  it("replaces snapshot and refreshes relational tags atomically", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    const playlist = makePlaylist({ tags: ["old-tag"] })
    await createPendingSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: newOperationKey(),
      playlist,
      contentHash: await hashOf(playlist),
      now: NOW,
    })
    await activateSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: newOperationKey(),
      expectedRevision: 1,
      now: NOW,
    })
    const next = makePlaylist({ title: "新しいタイトル", tags: ["new-tag"], itemPrefix: "nx" })
    const result = await replaceSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: newOperationKey(),
      expectedRevision: 2,
      playlist: next,
      contentHash: await hashOf(next),
      now: new Date("2026-03-02T00:00:00.000Z"),
    })
    expect(result.kind).toBe("applied")
    if (result.kind !== "applied") return
    expect(result.outcome.revision).toBe(3)
    expect(result.outcome.publishedAt).toBe("2026-03-01T12:00:00.000Z")

    const stored = await getSnapshot(db(), shareId)
    expect(stored?.revision).toBe(3)
    expect(stored?.snapshot.title).toBe("新しいタイトル")
    expect(stored?.snapshot.items[0]?.partId).toBe("nx_0")
    // Relational tag rows moved fully: old link gone, new link present.
    expect(await listTagLinks(db(), shareId)).toEqual(["new-tag"])
    expect(await listShareIdsByTag(db(), "old-tag")).not.toContain(shareId)
    expect(await listShareIdsByTag(db(), "new-tag")).toContain(shareId)
    // Denormalized read copy agrees with the relational rows.
    expect(stored?.tags).toEqual(["new-tag"])
  })

  it("hard-deletes payload and tags but keeps the mutation receipt", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    const playlist = makePlaylist({})
    const opKey = newOperationKey()
    await createPendingSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: opKey,
      playlist,
      contentHash: await hashOf(playlist),
      now: NOW,
    })
    await activateSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: newOperationKey(),
      expectedRevision: 1,
      now: NOW,
    })
    const deleteKey = newOperationKey()
    const result = await deleteSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: deleteKey,
      expectedRevision: 2,
      now: NOW,
    })
    expect(result.kind).toBe("applied")
    if (result.kind !== "applied") return
    expect(result.outcome.deletedRevision).toBe(2)

    expect(await getSnapshot(db(), shareId)).toBeNull()
    expect(await listTagLinks(db(), shareId)).toEqual([])
    const receipt = await readOperationRow(db(), deleteKey)
    expect(receipt?.status).toBe("completed")
    expect(receipt?.method).toBe("delete")
    // The receipt keeps only hashes: never the raw secret.
    expect(receipt?.secret_hash).toBe(secretHash)
  })

  it("sweeps expired pending snapshots including tag rows", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    const playlist = makePlaylist({ tags: ["doomed-tag"] })
    await createPendingSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: newOperationKey(),
      playlist,
      contentHash: await hashOf(playlist),
      now: NOW,
    })
    const removed = await deleteExpiredPending(db(), new Date("2026-03-01T13:00:00.001Z"))
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(await getSnapshot(db(), shareId)).toBeNull()
    expect(await listTagLinks(db(), shareId)).toEqual([])
  })

  it("returns null for unknown share ids", async () => {
    expect(await getSnapshot(db(), "no_such_share_id_0000")).toBeNull()
    expect(await getActiveSnapshot(db(), "no_such_share_id_0000")).toBeNull()
  })
})
