import { beforeAll, describe, expect, it } from "vitest"
import { sha256Hex } from "../../src/server/repositories/hashing.js"
import { recordImportEvent } from "../../src/server/repositories/imports.js"
import { activateSnapshot } from "../../src/server/repositories/snapshots/activate.js"
import { createPendingSnapshot } from "../../src/server/repositories/snapshots/create.js"
import { getSnapshot } from "../../src/server/repositories/snapshots/read.js"
import {
  db,
  hashOf,
  makePlaylist,
  migratedDb,
  newOperationKey,
  newSecretHash,
  newShareId,
} from "./helpers.js"

// Exactly-once import accounting on real D1: the receipt insert is the guard and
// both counter increments are gated on this attempt's nonce — duplicates,
// replays and concurrent copies cannot double-count.

const NOW = new Date("2026-03-01T12:00:00.000Z")
const DAY = "2026-03-01"

async function makeActiveShare(visibility: "public" | "unlisted" = "public") {
  const shareId = newShareId()
  const secretHash = await newSecretHash(shareId)
  const playlist = makePlaylist({ visibility })
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
  return shareId
}

async function dailyCount(shareId: string): Promise<number> {
  const row = await db()
    .prepare("SELECT count AS c FROM import_daily WHERE share_id = ?1 AND day = ?2")
    .bind(shareId, DAY)
    .first<{ c: number }>()
  return row?.c ?? 0
}

describe("import event accounting", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("counts a first event once into daily and lifetime counters", async () => {
    const shareId = await makeActiveShare()
    const eventHash = await sha256Hex(`event:${crypto.randomUUID()}`)
    const result = await recordImportEvent(db(), { shareId, eventHash, now: NOW })
    expect(result.counted).toBe(true)
    expect(await dailyCount(shareId)).toBe(1)
    expect((await getSnapshot(db(), shareId))?.importCount).toBe(1)
  })

  it("never double-counts a replayed event", async () => {
    const shareId = await makeActiveShare()
    const eventHash = await sha256Hex(`event:${crypto.randomUUID()}`)
    const first = await recordImportEvent(db(), { shareId, eventHash, now: NOW })
    const second = await recordImportEvent(db(), { shareId, eventHash, now: NOW })
    const third = await recordImportEvent(db(), { shareId, eventHash, now: NOW })
    expect([first.counted, second.counted, third.counted]).toEqual([true, false, false])
    expect(await dailyCount(shareId)).toBe(1)
    expect((await getSnapshot(db(), shareId))?.importCount).toBe(1)
  })

  it("counts exactly once under concurrent duplicate notifications", async () => {
    const shareId = await makeActiveShare()
    const eventHash = await sha256Hex(`event:${crypto.randomUUID()}`)
    const results = await Promise.all(
      Array.from({ length: 5 }, () => recordImportEvent(db(), { shareId, eventHash, now: NOW })),
    )
    expect(results.filter((r) => r.counted).length).toBe(1)
    expect(await dailyCount(shareId)).toBe(1)
    expect((await getSnapshot(db(), shareId))?.importCount).toBe(1)
  })

  it("does not count unlisted, pending or unknown shares (no oracle)", async () => {
    const unlisted = await makeActiveShare("unlisted")
    const pending = newShareId()
    const pendingSecret = await newSecretHash(pending)
    const pendingPlaylist = makePlaylist({})
    await createPendingSnapshot(db(), {
      shareId: pending,
      secretHash: pendingSecret,
      operationKey: newOperationKey(),
      playlist: pendingPlaylist,
      contentHash: await hashOf(pendingPlaylist),
      now: NOW,
    })
    for (const shareId of [unlisted, pending, newShareId()]) {
      const result = await recordImportEvent(db(), {
        shareId,
        eventHash: await sha256Hex(`event:${crypto.randomUUID()}`),
        now: NOW,
      })
      expect(result.counted).toBe(false)
    }
    expect((await getSnapshot(db(), unlisted))?.importCount).toBe(0)
  })

  it("counts distinct events on the same day independently", async () => {
    const shareId = await makeActiveShare()
    for (let i = 0; i < 3; i += 1) {
      const result = await recordImportEvent(db(), {
        shareId,
        eventHash: await sha256Hex(`event:${crypto.randomUUID()}`),
        now: NOW,
      })
      expect(result.counted).toBe(true)
    }
    expect(await dailyCount(shareId)).toBe(3)
    expect((await getSnapshot(db(), shareId))?.importCount).toBe(3)
  })
})
