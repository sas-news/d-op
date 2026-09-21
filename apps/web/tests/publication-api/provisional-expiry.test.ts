import { beforeAll, describe, expect, it } from "vitest"
import { POST as importRoute } from "../../src/pages/api/v1/playlists/[shareId]/import.js"
import { GET as getRoute, PATCH as patchRoute } from "../../src/pages/api/v1/playlists/[shareId].js"
import { runScheduledCleanup } from "../../src/server/services/maintenance.js"
import {
  activateShare,
  call,
  db,
  getShare,
  importNotify,
  makePlaylist,
  migratedDb,
  publishPlaylist,
  seedPendingRow,
} from "./helpers.js"

// Provisional pending snapshots: never readable/listable/importable, and
// activation expiry is enforced lazily on every read/write path (independent
// of cron) plus by the scheduled cleanup entry point — which must never
// touch a valid active publication.

const TWO_HOURS_AGO = () => new Date(Date.now() - 2 * 3_600_000)

async function pendingRow(shareId: string) {
  return db()
    .prepare("SELECT share_id, state FROM playlists WHERE share_id = ?1")
    .bind(shareId)
    .first<{ share_id: string; state: string }>()
}

describe("provisional pending snapshots and lazy expiry", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("expires a stale pending row on the read path and returns 404", async () => {
    const seeded = await seedPendingRow(TWO_HOURS_AGO())
    const res = await call(getRoute, getShare(seeded.shareId), { shareId: seeded.shareId })
    expect(res.status).toBe(404)
    // The lazy sweep physically removed the expired provisional row.
    expect(await pendingRow(seeded.shareId)).toBeNull()
  })

  it("refuses activation of an expired provisional with 404 and removes it", async () => {
    const seeded = await seedPendingRow(TWO_HOURS_AGO())
    const res = await call(patchRoute, activateShare(seeded.shareId, seeded.manageSecret), {
      shareId: seeded.shareId,
    })
    expect(res.status).toBe(404)
    expect(await pendingRow(seeded.shareId)).toBeNull()
  })

  it("never counts imports for pending or expired snapshots but still returns 204", async () => {
    const seeded = await seedPendingRow(TWO_HOURS_AGO())
    const res = await call(importRoute, importNotify(seeded.shareId, crypto.randomUUID()), {
      shareId: seeded.shareId,
    })
    expect(res.status).toBe(204)
    const counted = await db()
      .prepare("SELECT import_count AS c FROM playlists WHERE share_id = ?1")
      .bind(seeded.shareId)
      .first<{ c: number }>()
    expect(counted).toBeNull() // row swept by the lazy expiry on this write path
  })

  it("scheduled cleanup removes expired provisionals but never active publications", async () => {
    // Seed order matters: the lazy sweep inside route calls must not get a
    // chance to remove `expired` before runScheduledCleanup proves it can.
    const fresh = await seedPendingRow(new Date())
    const active = await publishPlaylist(makePlaylist({ title: "keepme" }))
    const expired = await seedPendingRow(TWO_HOURS_AGO())

    const report = await runScheduledCleanup(db())
    expect(report.expiredPendingPlaylists).toBeGreaterThanOrEqual(1)
    expect(await pendingRow(expired.shareId)).toBeNull()
    // A still-valid pending row and every active publication survive the sweep.
    expect((await pendingRow(fresh.shareId))?.state).toBe("pending")
    expect((await pendingRow(active.shareId))?.state).toBe("active")
    const got = await call(getRoute, getShare(active.shareId), { shareId: active.shareId })
    expect(got.status).toBe(200)
  })
})
