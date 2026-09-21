import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { beforeAll, describe, expect, it } from "vitest"
import { SnapshotRepositoryError } from "../../src/server/repositories/errors.js"
import { sha256Hex } from "../../src/server/repositories/hashing.js"
import { recordImportEvent } from "../../src/server/repositories/imports.js"
import { runScheduledCleanup } from "../../src/server/services/maintenance.js"
import {
  bucketRows,
  dailyCount,
  db,
  lifetimeCount,
  makePlaylist,
  migratedDb,
  publishPlaylist,
  receiptCount,
} from "./helpers.js"

// Batch atomicity and retention for import accounting (task 18). Any failed
// statement rolls the WHOLE guarded batch back — receipt, day bucket and
// lifetime counter move together or not at all. Scheduled pruning removes
// expired receipts and >90-day buckets while preserving the lifetime count.

const DAY_MS = 86_400_000

/** Wraps the real D1 binding so batch statement `failIndex` always errors. */
function sabotagedDb(real: D1Database, failIndex: number): D1Database {
  const wrapper = {
    prepare: (query: string) => real.prepare(query),
    batch: (statements: readonly D1PreparedStatement[]) =>
      real.batch(
        statements.map((statement, index) =>
          index === failIndex
            ? real.prepare("INSERT INTO missing_sabotage_table (x) VALUES (1)")
            : statement,
        ),
      ),
  }
  return wrapper as unknown as D1Database
}

async function eventHash(): Promise<string> {
  return sha256Hex(`dop-import:${crypto.randomUUID()}`)
}

describe("import batch atomicity", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it.each([
    // [0] expired-receipt cleanup, [1] receipt insert, [2] day bucket, [3] lifetime
    { name: "day-bucket upsert", failIndex: 2 },
    { name: "lifetime increment", failIndex: 3 },
  ])("a failing $name statement rolls back the whole batch", async ({ failIndex }) => {
    const published = await publishPlaylist(makePlaylist({}))
    const hash = await eventHash()
    const failing = sabotagedDb(db(), failIndex)
    await expect(
      recordImportEvent(failing, { shareId: published.shareId, eventHash: hash, now: new Date() }),
    ).rejects.toThrow(SnapshotRepositoryError)

    // Nothing survived: no receipt, no bucket, no lifetime increment.
    expect(await receiptCount(db(), published.shareId)).toBe(0)
    expect(await bucketRows(db(), published.shareId)).toHaveLength(0)
    expect(await lifetimeCount(db(), published.shareId)).toBe(0)

    // The rolled-back receipt does not block an honest retry: the same event
    // counts exactly once on a healthy database.
    const retry = await recordImportEvent(db(), {
      shareId: published.shareId,
      eventHash: hash,
      now: new Date(),
    })
    expect(retry.counted).toBe(true)
    expect(await lifetimeCount(db(), published.shareId)).toBe(1)
  })
})

describe("import artifact pruning", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("sweeps expired receipts and >90-day buckets while preserving the lifetime count", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const now = new Date()
    const old = new Date(now.getTime() - 100 * DAY_MS)
    const recent = new Date(now.getTime() - 10 * 3_600_000)

    // Expired receipt + a day bucket older than the retention window.
    const stale = await recordImportEvent(db(), {
      shareId: published.shareId,
      eventHash: await eventHash(),
      now: old,
    })
    expect(stale.counted).toBe(true)
    // Live receipt + a bucket inside the retention window.
    const fresh = await recordImportEvent(db(), {
      shareId: published.shareId,
      eventHash: await eventHash(),
      now: recent,
    })
    expect(fresh.counted).toBe(true)
    expect(await receiptCount(db(), published.shareId)).toBe(2)
    expect(await lifetimeCount(db(), published.shareId)).toBe(2)

    const report = await runScheduledCleanup(db(), now)

    expect(report.expiredImportReceipts).toBe(1)
    expect(report.prunedDayBuckets).toBe(1)
    expect(await receiptCount(db(), published.shareId)).toBe(1)
    // The recent bucket survives; the 100-day-old bucket is gone. The
    // lifetime count is never decremented by retention.
    const buckets = await bucketRows(db(), published.shareId)
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.day).toBe(recent.toISOString().slice(0, 10))
    expect(buckets[0]?.count).toBe(1)
    expect(await lifetimeCount(db(), published.shareId)).toBe(2)
  })

  it("keeps live receipts and recent buckets untouched", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const now = new Date()
    await recordImportEvent(db(), {
      shareId: published.shareId,
      eventHash: await eventHash(),
      now,
    })
    const report = await runScheduledCleanup(db(), now)
    expect(report.expiredImportReceipts).toBe(0)
    expect(report.prunedDayBuckets).toBe(0)
    expect(await receiptCount(db(), published.shareId)).toBe(1)
    expect(await dailyCount(db(), published.shareId, now.toISOString().slice(0, 10))).toBe(1)
    expect(await lifetimeCount(db(), published.shareId)).toBe(1)
  })
})
