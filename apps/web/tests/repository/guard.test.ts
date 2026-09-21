import { beforeAll, describe, expect, it } from "vitest"
import { readOperationRow } from "../../src/server/repositories/guard.js"
import { activateSnapshot } from "../../src/server/repositories/snapshots/activate.js"
import { createPendingSnapshot } from "../../src/server/repositories/snapshots/create.js"
import { deleteSnapshot } from "../../src/server/repositories/snapshots/delete.js"
import { getSnapshot, listTagLinks } from "../../src/server/repositories/snapshots/read.js"
import { replaceSnapshot } from "../../src/server/repositories/snapshots/replace.js"
import {
  db,
  hashOf,
  makeActive,
  makePlaylist,
  migratedDb,
  newOperationKey,
  newSecretHash,
  newShareId,
} from "./helpers.js"

// Guarded-operation semantics on real D1: conflicts write nothing and replays
// return the recorded receipt without writing. Concurrency/rollback proofs live
// in guard-atomicity.test.ts.

const NOW = new Date("2026-03-01T12:00:00.000Z")

describe("guarded mutation conflicts", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("rejects a stale revision without touching snapshot, tags or receipts", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    await makeActive(shareId, secretHash, NOW)
    const staleKey = newOperationKey()
    const next = makePlaylist({ tags: ["stale-tag"] })
    const result = await replaceSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: staleKey,
      expectedRevision: 99,
      playlist: next,
      contentHash: await hashOf(next),
      now: NOW,
    })
    expect(result).toEqual({ kind: "conflict", code: "REVISION_CONFLICT" })
    const stored = await getSnapshot(db(), shareId)
    expect(stored?.revision).toBe(2)
    expect(await listTagLinks(db(), shareId)).toEqual(["seed-tag"])
    expect(await readOperationRow(db(), staleKey)).toBeNull()
    expect(stored?.importCount).toBe(0)
  })

  it("rejects a wrong secret hash without revealing the revision", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    await makeActive(shareId, secretHash, NOW)
    const wrongSecret = await newSecretHash(shareId)
    const result = await deleteSnapshot(db(), {
      shareId,
      secretHash: wrongSecret,
      operationKey: newOperationKey(),
      expectedRevision: 2,
      now: NOW,
    })
    expect(result).toEqual({ kind: "conflict", code: "UNAUTHORIZED" })
    expect((await getSnapshot(db(), shareId))?.revision).toBe(2)
  })

  it("returns NOT_FOUND for an absent share id", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    const result = await replaceSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: newOperationKey(),
      expectedRevision: 1,
      playlist: makePlaylist({}),
      contentHash: "a".repeat(64),
      now: NOW,
    })
    expect(result).toEqual({ kind: "conflict", code: "NOT_FOUND" })
  })

  it("replays an identical request from the completed receipt, writing nothing", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    const playlist = makePlaylist({})
    const opKey = newOperationKey()
    const first = await createPendingSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: opKey,
      playlist,
      contentHash: await hashOf(playlist),
      now: NOW,
    })
    expect(first.kind).toBe("applied")
    // Same operation key + same request -> replay, no second write.
    const replay = await createPendingSnapshot(db(), {
      shareId: newShareId(), // even a regenerated id must not write
      secretHash: await newSecretHash(shareId),
      operationKey: opKey,
      playlist,
      contentHash: await hashOf(playlist),
      now: NOW,
    })
    expect(replay.kind).toBe("replayed")
    if (replay.kind === "replayed") {
      expect(replay.outcome.shareId).toBe(shareId)
    }
    // Still exactly one playlist row for this resource.
    const count = await db()
      .prepare("SELECT count(*) AS n FROM playlists WHERE share_id = ?1")
      .bind(shareId)
      .first<{ n: number }>()
    expect(count?.n).toBe(1)
  })

  it("rejects the same operation key with a different request body", async () => {
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
    const other = makePlaylist({ title: "別物" })
    const conflict = await createPendingSnapshot(db(), {
      shareId: newShareId(),
      secretHash,
      operationKey: opKey,
      playlist: other,
      contentHash: await hashOf(other),
      now: NOW,
    })
    expect(conflict).toEqual({ kind: "conflict", code: "IDEMPOTENCY_CONFLICT" })
  })

  it("rejects a replayed mutation presented under a different secret", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    await makeActive(shareId, secretHash, NOW)
    const opKey = newOperationKey()
    const next = makePlaylist({ title: "v3" })
    const first = await replaceSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: opKey,
      expectedRevision: 2,
      playlist: next,
      contentHash: await hashOf(next),
      now: NOW,
    })
    expect(first.kind).toBe("applied")
    const forged = await replaceSnapshot(db(), {
      shareId,
      secretHash: await newSecretHash(shareId),
      operationKey: opKey,
      expectedRevision: 2,
      playlist: next,
      contentHash: await hashOf(next),
      now: NOW,
    })
    expect(forged).toEqual({ kind: "conflict", code: "UNAUTHORIZED" })
    expect((await getSnapshot(db(), shareId))?.revision).toBe(3)
  })

  it("rejects activation of an expired pending snapshot", async () => {
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
      now: new Date("2026-03-01T13:00:00.001Z"), // just past the 1 h window
    })
    expect(result).toEqual({ kind: "conflict", code: "ACTIVATION_EXPIRED" })
    expect((await getSnapshot(db(), shareId))?.state).toBe("pending")
  })

  it("rejects replace on a pending (non-active) snapshot", async () => {
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
    const result = await replaceSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: newOperationKey(),
      expectedRevision: 1,
      playlist: makePlaylist({ title: "early" }),
      contentHash: "b".repeat(64),
      now: NOW,
    })
    expect(result).toEqual({ kind: "conflict", code: "INVALID_STATE" })
  })
})
