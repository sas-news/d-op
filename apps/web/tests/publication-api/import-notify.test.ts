import { beforeAll, describe, expect, it } from "vitest"
import { POST as importRoute } from "../../src/pages/api/v1/playlists/[shareId]/import.js"
import {
  call,
  db,
  importNotify,
  makePlaylist,
  migratedDb,
  publishPlaylist,
  seedPendingRow,
} from "./helpers.js"

// POST /:shareId/import: always 204 for a well-formed body — duplicate,
// unknown, unlisted, pending and malformed ids are indistinguishable so the
// route can never act as an existence oracle. Only active + public +
// unblocked snapshots move the counters.

async function importCount(shareId: string): Promise<number> {
  const row = await db()
    .prepare("SELECT import_count AS c FROM playlists WHERE share_id = ?1")
    .bind(shareId)
    .first<{ c: number }>()
  return row?.c ?? 0
}

describe("import notifications", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("counts an event once and returns the identical 204 for duplicates", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const eventId = crypto.randomUUID()
    const first = await call(importRoute, importNotify(published.shareId, eventId), {
      shareId: published.shareId,
    })
    expect(first.status).toBe(204)
    const dup = await call(importRoute, importNotify(published.shareId, eventId), {
      shareId: published.shareId,
    })
    expect(dup.status).toBe(204)
    expect(await importCount(published.shareId)).toBe(1)

    // A fresh event id from the SAME actor does not count again — the
    // actor×share dedup caps one actor at one count per 48 h window.
    const sameActor = await call(
      importRoute,
      importNotify(published.shareId, crypto.randomUUID()),
      { shareId: published.shareId },
    )
    expect(sameActor.status).toBe(204)
    expect(await importCount(published.shareId)).toBe(1)

    // A different actor's event still counts.
    const second = await call(
      importRoute,
      importNotify(published.shareId, crypto.randomUUID(), "198.51.100.20"),
      { shareId: published.shareId },
    )
    expect(second.status).toBe(204)
    expect(await importCount(published.shareId)).toBe(2)
  })

  it("returns 204 for unknown, unlisted, pending and malformed ids without counting", async () => {
    const unlisted = await publishPlaylist(makePlaylist({ visibility: "unlisted" }))
    const pending = await seedPendingRow(new Date())
    const targets = [
      "a".repeat(22), // well-formed but absent
      unlisted.shareId,
      pending.shareId,
      "not-even-valid", // malformed route param
    ]
    for (const target of targets) {
      const res = await call(importRoute, importNotify(target, crypto.randomUUID()), {
        shareId: target,
      })
      expect(res.status).toBe(204)
      expect(res.headers.get("cache-control")).toBe("no-store")
    }
    expect(await importCount(unlisted.shareId)).toBe(0)
    expect(await importCount(pending.shareId)).toBe(0)
  })
})
