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

// Exactly-once import accounting on real D1: the event receipt insert is the
// guard — it only fires when this attempt minted the actor dedup receipt —
// and both counter increments are gated on this attempt's nonce. Duplicates,
// replays, concurrent copies and fresh event ids from the same actor cannot
// double-count.

const NOW = new Date("2026-03-01T12:00:00.000Z")
const DAY = "2026-03-01"

/** Fresh actor receipt hash for one event (unique actor per call). */
async function actorHash(): Promise<string> {
  return sha256Hex(`dop-import-actor:test:${crypto.randomUUID()}`)
}

/**
 * Mirrors the service's actor dedup key: sha256 of
 * `dop-import-actor:<actorDigest>:<shareId>` — the same actor yields a
 * different stored hash on each share.
 */
async function actorHashFor(actor: string, shareId: string): Promise<string> {
  return sha256Hex(`dop-import-actor:${actor}:${shareId}`)
}

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
    const result = await recordImportEvent(db(), {
      shareId,
      eventHash,
      actorHash: await actorHash(),
      now: NOW,
    })
    expect(result.counted).toBe(true)
    expect(await dailyCount(shareId)).toBe(1)
    expect((await getSnapshot(db(), shareId))?.importCount).toBe(1)
  })

  it("never double-counts a replayed event", async () => {
    const shareId = await makeActiveShare()
    const eventHash = await sha256Hex(`event:${crypto.randomUUID()}`)
    const actor = await actorHash()
    const first = await recordImportEvent(db(), { shareId, eventHash, actorHash: actor, now: NOW })
    const second = await recordImportEvent(db(), { shareId, eventHash, actorHash: actor, now: NOW })
    const third = await recordImportEvent(db(), { shareId, eventHash, actorHash: actor, now: NOW })
    expect([first.counted, second.counted, third.counted]).toEqual([true, false, false])
    expect(await dailyCount(shareId)).toBe(1)
    expect((await getSnapshot(db(), shareId))?.importCount).toBe(1)
  })

  it("counts exactly once under concurrent duplicate notifications", async () => {
    const shareId = await makeActiveShare()
    const eventHash = await sha256Hex(`event:${crypto.randomUUID()}`)
    const actor = await actorHash()
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        recordImportEvent(db(), { shareId, eventHash, actorHash: actor, now: NOW }),
      ),
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
        actorHash: await actorHash(),
        now: NOW,
      })
      expect(result.counted).toBe(false)
    }
    expect((await getSnapshot(db(), unlisted))?.importCount).toBe(0)
  })

  it("counts distinct actors' events on the same day independently", async () => {
    const shareId = await makeActiveShare()
    for (let i = 0; i < 3; i += 1) {
      const result = await recordImportEvent(db(), {
        shareId,
        eventHash: await sha256Hex(`event:${crypto.randomUUID()}`),
        actorHash: await actorHash(),
        now: NOW,
      })
      expect(result.counted).toBe(true)
    }
    expect(await dailyCount(shareId)).toBe(3)
    expect((await getSnapshot(db(), shareId))?.importCount).toBe(3)
  })

  it("counts a second eventId from the same actor on the same share only once", async () => {
    const shareId = await makeActiveShare()
    const actor = await actorHash()
    const first = await recordImportEvent(db(), {
      shareId,
      eventHash: await sha256Hex(`event:${crypto.randomUUID()}`),
      actorHash: actor,
      now: NOW,
    })
    const second = await recordImportEvent(db(), {
      shareId,
      eventHash: await sha256Hex(`event:${crypto.randomUUID()}`),
      actorHash: actor,
      now: NOW,
    })
    expect([first.counted, second.counted]).toEqual([true, false])
    expect(await dailyCount(shareId)).toBe(1)
    expect((await getSnapshot(db(), shareId))?.importCount).toBe(1)
  })

  it("counts the same actor on a different share independently", async () => {
    const shareA = await makeActiveShare()
    const shareB = await makeActiveShare()
    const actor = crypto.randomUUID()
    for (const shareId of [shareA, shareB]) {
      const result = await recordImportEvent(db(), {
        shareId,
        eventHash: await sha256Hex(`event:${crypto.randomUUID()}`),
        actorHash: await actorHashFor(actor, shareId),
        now: NOW,
      })
      expect(result.counted).toBe(true)
    }
    expect((await getSnapshot(db(), shareA))?.importCount).toBe(1)
    expect((await getSnapshot(db(), shareB))?.importCount).toBe(1)
  })
})
