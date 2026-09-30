import { beforeAll, describe, expect, it } from "vitest"
import { POST as importRoute } from "../../src/pages/api/v1/playlists/[shareId]/import.js"
import {
  call,
  dailyCount,
  db,
  deletePublished,
  importNotify,
  lifetimeCount,
  makePlaylist,
  migratedDb,
  postImport,
  publishPlaylist,
  receiptCount,
  seedPendingRow,
} from "./helpers.js"

// POST /:shareId/import aggregate accounting (task 18): the route always
// answers 204 for a well-formed body — counted, duplicate, unknown, unlisted,
// pending and deleted ids are deliberately indistinguishable. Only active +
// public + unblocked snapshots move the UTC-day bucket and the lifetime
// counter, and the receipt insert gates both increments exactly once per 48 h
// window — including under concurrency. Each counted event writes two
// receipts (the per-actor dedup row and the per-event row), and a single actor
// can move a share's counters at most once per window.

const today = (): string => new Date().toISOString().slice(0, 10)

describe("import aggregate counters", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("counts a concurrent burst of identical eventIds exactly once", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const eventId = crypto.randomUUID()
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => postImport(published.shareId, eventId)),
    )
    for (const res of responses) expect(res.status).toBe(204)
    expect(await dailyCount(db(), published.shareId, today())).toBe(1)
    expect(await lifetimeCount(db(), published.shareId)).toBe(1)
    expect(await receiptCount(db(), published.shareId)).toBe(2)
  })

  it("accumulates distinct eventIds into daily and lifetime totals", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    // One count per actor per share: four events need four distinct actors.
    for (let i = 0; i < 4; i += 1) {
      const res = await postImport(published.shareId, crypto.randomUUID(), `198.51.100.${i + 1}`)
      expect(res.status).toBe(204)
    }
    expect(await dailyCount(db(), published.shareId, today())).toBe(4)
    expect(await lifetimeCount(db(), published.shareId)).toBe(4)

    // A second share counts independently.
    const other = await publishPlaylist(makePlaylist({}))
    expect((await postImport(other.shareId, crypto.randomUUID())).status).toBe(204)
    expect(await dailyCount(db(), other.shareId, today())).toBe(1)
    expect(await lifetimeCount(db(), other.shareId)).toBe(1)
    expect(await dailyCount(db(), published.shareId, today())).toBe(4)
  })

  it("caps one actor at a single count per share per window", async () => {
    // Issue #36: regenerating event ids from the same actor must not inflate
    // the counters — only the first fresh eventId counts.
    const published = await publishPlaylist(makePlaylist({}))
    for (let i = 0; i < 4; i += 1) {
      const res = await postImport(published.shareId, crypto.randomUUID(), "198.51.100.9")
      expect(res.status).toBe(204)
    }
    expect(await dailyCount(db(), published.shareId, today())).toBe(1)
    expect(await lifetimeCount(db(), published.shareId)).toBe(1)
    expect(await receiptCount(db(), published.shareId)).toBe(2)
  })

  it("returns the generic 204 with no count for unlisted, deleted, pending and unknown ids", async () => {
    const unlisted = await publishPlaylist(makePlaylist({ visibility: "unlisted" }))
    const deleted = await publishPlaylist(makePlaylist({}))
    const pending = await seedPendingRow(new Date())
    const removed = await deletePublished(deleted.shareId, deleted.manageSecret, 2)
    expect(removed.status).toBe(204)

    const targets = [
      unlisted.shareId,
      deleted.shareId,
      pending.shareId,
      "a".repeat(22), // well-formed but absent
      "not-a-share-id", // malformed route param
    ]
    for (const shareId of targets) {
      const res = await call(importRoute, importNotify(shareId, crypto.randomUUID()), { shareId })
      expect(res.status).toBe(204)
      expect(res.headers.get("cache-control")).toBe("no-store")
    }
    expect(await dailyCount(db(), unlisted.shareId, today())).toBe(0)
    expect(await dailyCount(db(), deleted.shareId, today())).toBe(0)
    expect(await dailyCount(db(), pending.shareId, today())).toBe(0)
    expect(await lifetimeCount(db(), unlisted.shareId)).toBe(0)
    // Deleted shares are hard-deleted: no row, no bucket, no receipt.
    expect(await lifetimeCount(db(), deleted.shareId)).toBeNull()
    expect(await receiptCount(db(), deleted.shareId)).toBe(0)
  })

  it("rejects malformed bodies with the fixed error envelope, never a count", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const bad = await call(importRoute, importNotify(published.shareId, "not-a-uuid"), {
      shareId: published.shareId,
    })
    expect(bad.status).toBe(422)
    const missing = await call(importRoute, importNotify(published.shareId, undefined), {
      shareId: published.shareId,
    })
    expect([400, 422]).toContain(missing.status)
    expect(await lifetimeCount(db(), published.shareId)).toBe(0)
  })

  it("counts a resend once the receipt TTL has expired (ingestion expiry check)", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const eventId = crypto.randomUUID()
    expect((await postImport(published.shareId, eventId)).status).toBe(204)
    expect(await lifetimeCount(db(), published.shareId)).toBe(1)

    // Force the receipt past its 48 h TTL without running the sweeper.
    await db()
      .prepare("UPDATE import_receipts SET expires_at = ?1 WHERE share_id = ?2")
      .bind(new Date(Date.now() - 1000).toISOString(), published.shareId)
      .run()

    expect((await postImport(published.shareId, eventId)).status).toBe(204)
    expect(await lifetimeCount(db(), published.shareId)).toBe(2)
    expect(await dailyCount(db(), published.shareId, today())).toBe(2)
    // Both receipts (actor + event) expired together and were re-minted.
    expect(await receiptCount(db(), published.shareId)).toBe(2)
  })
})
