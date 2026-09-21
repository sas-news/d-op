import { beforeAll, describe, expect, it } from "vitest"
import {
  canonicalBytes,
  canonicalString,
  SHARE_REQUEST_BODY_MAX_BYTES,
} from "../../../../packages/shared/src/index"
import { activateSnapshot } from "../../src/server/repositories/snapshots/activate.js"
import { createPendingSnapshot } from "../../src/server/repositories/snapshots/create.js"
import {
  getActiveSnapshot,
  getSnapshot,
  listTagLinks,
} from "../../src/server/repositories/snapshots/read.js"
import {
  db,
  hashOf,
  makeMaxPlaylist,
  makePlaylist,
  migratedDb,
  newOperationKey,
  newSecretHash,
  newShareId,
} from "./helpers.js"

// Index-plan verification, parameter-binding safety and D1 budget checks.

const NOW = new Date("2026-03-01T12:00:00.000Z")

async function explain(sql: string, binds: readonly unknown[]): Promise<readonly string[]> {
  const rows = await db()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...binds)
    .all<{ detail: string }>()
  return rows.results.map((row) => row.detail)
}

describe("index plans", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("uses the listing index for the eligible ordered scan", async () => {
    const plan = await explain(
      `SELECT share_id FROM playlists
       WHERE state = 'active' AND visibility = 'public' AND blocked = 0
       ORDER BY first_published_at DESC, share_id ASC LIMIT ?1`,
      [20],
    )
    expect(plan.join(" | ")).toContain("playlists_listing_idx")
  })

  it("uses the tag join index for tag-filtered listing", async () => {
    const plan = await explain(
      `SELECT pt.share_id FROM playlist_tags pt
       JOIN tags t ON t.tag_id = pt.tag_id
       WHERE t.tag = ?1`,
      ["any-tag"],
    )
    const joined = plan.join(" | ")
    expect(joined).toMatch(/tags.*using.*index/i)
    expect(joined).toContain("playlist_tags_tag_idx")
  })

  it("uses primary keys and expiry indexes for receipt and sweep lookups", async () => {
    const receipt = await explain(
      "SELECT status FROM publication_operations WHERE operation_key = ?1",
      ["k"],
    )
    expect(receipt.join(" | ")).toMatch(/publication_operations/)
    const expiry = await explain("DELETE FROM publication_operations WHERE expires_at <= ?1", [
      "2026-01-01",
    ])
    expect(expiry.join(" | ")).toContain("publication_operations_expiry_idx")
    // Ordering by day over a range scan requires the (day, share_id) index.
    const dayScan = await explain(
      "SELECT share_id, count FROM import_daily WHERE day >= ?1 ORDER BY day",
      ["2026-01-01"],
    )
    expect(dayScan.join(" | ")).toContain("import_daily_day_idx")
    const pendingSweep = await explain(
      `SELECT share_id FROM playlists
       WHERE state = 'pending' AND activation_expires_at <= ?1`,
      ["2026-01-01"],
    )
    expect(pendingSweep.join(" | ")).toContain("playlists_activation_expiry_idx")
  })
})

describe("parameter binding safety", () => {
  it("stores hostile strings literally and keeps the schema intact", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    const hostile = makePlaylist({
      title: "x'); DROP TABLE playlists;--",
      tags: ["%_tag", "a' OR '1'='1"],
    })
    const created = await createPendingSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: newOperationKey(),
      playlist: hostile,
      contentHash: await hashOf(hostile),
      now: NOW,
    })
    expect(created.kind).toBe("applied")
    const stored = await getSnapshot(db(), shareId)
    expect(stored?.snapshot.title).toBe("x'); DROP TABLE playlists;--")
    expect(stored?.tags).toEqual(["%_tag", "a' or '1'='1"])
    // The schema is untouched and the row count is exactly what was written.
    const count = await db()
      .prepare("SELECT count(*) AS n FROM playlists WHERE share_id = ?1")
      .bind(shareId)
      .first<{ n: number }>()
    expect(count?.n).toBe(1)
    const tables = await db()
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='playlists'")
      .first<{ n: number }>()
    expect(tables?.n).toBe(1)
  })
})

describe("D1 budget discipline", () => {
  it("persists a maximum-size snapshot within the 256 KiB body cap", async () => {
    const playlist = makeMaxPlaylist()
    const canonical = canonicalString(playlist)
    const bytes = canonicalBytes(canonical)
    expect(bytes.byteLength).toBeLessThanOrEqual(SHARE_REQUEST_BODY_MAX_BYTES)
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    const created = await createPendingSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: newOperationKey(),
      playlist,
      contentHash: await hashOf(playlist),
      now: NOW,
    })
    expect(created.kind).toBe("applied")
    const activated = await activateSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: newOperationKey(),
      expectedRevision: 1,
      now: NOW,
    })
    expect(activated.kind).toBe("applied")
    const stored = await getActiveSnapshot(db(), shareId)
    expect(stored?.itemCount).toBe(200)
    expect(stored?.snapshot.items[199]?.partId).toBe(playlist.items[199]?.partId)
    expect(await listTagLinks(db(), shareId)).toEqual(playlist.tags)
    // Whole replace path is bounded: a single canonical payload + json_each,
    // never hundreds of per-item statements.
  })
})
