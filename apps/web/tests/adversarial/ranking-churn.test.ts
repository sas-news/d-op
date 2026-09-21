import { beforeAll, describe, expect, it } from "vitest"
import {
  cursorPayload,
  dayBefore,
  db,
  listData,
  listRequest,
  listViaRoute,
  migratedDb,
  seedImport,
  seedPlaylist,
} from "./helpers.js"

// Task-27 adversarial: adaptive-ranking churn, cursor forgery and the
// "hide a parent during pagination" QA failure case — all through the REAL
// collection route on wall clock (no injected service clock). The frozen
// snapshot contract under attack: a continuation must keep the first page's
// ranking basis and candidate set; forged/swapped cursor halves must fail
// closed; a parent hidden mid-pagination must redact a child's lineage on
// the continuation page without reordering or orphaning anything public.
//
// ISOLATION: like tests/discovery, every test filters on a UNIQUE tag so its
// query fingerprint (and cached snapshot) can never collide.

const NOW = new Date()
const ISO = (offsetDays: number) => new Date(NOW.getTime() - offsetDays * 86_400_000).toISOString()

async function seedTagged(tag: string, count: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    ids.push(await seedPlaylist(db(), { firstPublishedAt: ISO(30 - i), tags: [tag] }))
  }
  return ids // ids[i] published before ids[j] for i<j; newest last
}

function shareIdsOf(data: { items: readonly { shareId: string }[] }): string[] {
  return data.items.map((item) => item.shareId)
}

describe("frozen continuation under ranking churn", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("imports flooding the tail mid-pagination never reorder a popular-mode continuation", async () => {
    const tag = "adv-churn-pop"
    const ids = await seedTagged(tag, 5)
    // sort=popular with lifetime fallback: order follows import_count then
    // recency. Page 1 freezes the candidate set + ranking basis.
    const page1 = await listData(
      await listViaRoute(listRequest({ sort: "popular", tag, limit: "2" })),
    )
    expect(page1.items).toHaveLength(2)
    const basis = page1.ranking
    // Churn: a huge import burst on the LAST eligible row + a brand-new row.
    await seedImport(db(), ids[0] ?? "", dayBefore(NOW, 0), 500)
    const newcomer = await seedPlaylist(db(), { firstPublishedAt: ISO(0), tags: [tag] })
    const page2 = await listData(
      await listViaRoute(
        listRequest({ sort: "popular", tag, limit: "2", cursor: page1.nextCursor ?? "" }),
      ),
    )
    const page3 = await listData(
      await listViaRoute(
        listRequest({ sort: "popular", tag, limit: "2", cursor: page2.nextCursor ?? "" }),
      ),
    )
    const seen = [...shareIdsOf(page1), ...shareIdsOf(page2), ...shareIdsOf(page3)]
    expect(new Set(seen).size).toBe(5)
    expect(seen).not.toContain(newcomer)
    // The continuation still reports the FIRST page's ranking basis — the
    // snapshot's mode/window is frozen, not recomputed under churn.
    expect(page2.ranking).toEqual(basis)
    expect(page3.ranking).toEqual(basis)
    expect(page3.nextCursor).toBeUndefined()
  })

  it("rows hidden or deleted between pages consume positions without reordering", async () => {
    const tag = "adv-churn-hide"
    const ids = await seedTagged(tag, 6)
    const page1 = await listData(await listViaRoute(listRequest({ sort: "new", tag, limit: "2" })))
    expect(shareIdsOf(page1)).toEqual([ids[5], ids[4]])
    // Mid-pagination attacks: block the next visible row, delete the one
    // after, and flip another to unlisted.
    await db().prepare("UPDATE playlists SET blocked = 1 WHERE share_id = ?").bind(ids[3]).run()
    await db().prepare("DELETE FROM playlists WHERE share_id = ?").bind(ids[2]).run()
    await db()
      .prepare("UPDATE playlists SET visibility = 'unlisted' WHERE share_id = ?")
      .bind(ids[1])
      .run()
    const page2 = await listData(
      await listViaRoute(
        listRequest({ sort: "new", tag, limit: "2", cursor: page1.nextCursor ?? "" }),
      ),
    )
    // Positions for blocked/deleted/unlisted ids were consumed, not refilled
    // — page 2 can only yield the still-eligible remainder, in order.
    const remaining = shareIdsOf(page2)
    for (const hidden of [ids[3], ids[2], ids[1]]) {
      expect(remaining).not.toContain(hidden)
    }
    expect(remaining).toEqual([ids[0]])
    expect(page2.nextCursor).toBeUndefined()
  })

  it("a parent hidden mid-pagination redacts child lineage on the continuation", async () => {
    const tag = "adv-churn-parent"
    const parent = await seedPlaylist(db(), { firstPublishedAt: ISO(20), tags: [tag] })
    const child = await seedPlaylist(db(), {
      firstPublishedAt: ISO(10),
      tags: [tag],
      derivedFrom: { shareId: parent, revision: 2 },
    })
    // Page 1 (limit 1) shows the child WITH its public source link.
    const page1 = await listData(await listViaRoute(listRequest({ sort: "new", tag, limit: "1" })))
    expect(shareIdsOf(page1)).toEqual([child])
    expect(page1.items[0]?.source).toEqual({ shareId: parent, revision: 2 })
    expect(page1.items[0]?.playlist.derivedFrom).toEqual({ shareId: parent, revision: 2 })

    // Hide the parent between pages; the continuation (parent row itself)
    // must not surface, and a fresh read of the child redacts lineage.
    await db().prepare("UPDATE playlists SET blocked = 1 WHERE share_id = ?").bind(parent).run()
    const page2 = await listData(
      await listViaRoute(
        listRequest({ sort: "new", tag, limit: "1", cursor: page1.nextCursor ?? "" }),
      ),
    )
    // The frozen snapshot still holds the parent's position but the row is
    // re-checked at read time: it is skipped, not served.
    expect(shareIdsOf(page2)).toEqual([])
    expect(page2.nextCursor).toBeUndefined()

    // Same redaction on a NEW snapshot and on the public GET — hidden-source
    // never leaks derivedFrom anywhere public.
    const fresh = await listData(await listViaRoute(listRequest({ sort: "new", tag })))
    expect(shareIdsOf(fresh)).toEqual([child])
    expect(fresh.items[0]?.source).toBeNull()
    expect("derivedFrom" in (fresh.items[0]?.playlist ?? {})).toBe(false)
    const get = await listData(await listViaRoute(listRequest({ sort: "new", tag, limit: "5" })))
    expect(get.items[0]?.source).toBeNull()
    // The stored row keeps provenance — redaction is a projection, not a
    // destructive rewrite of first-publication lineage.
    const row = await db()
      .prepare("SELECT derived_from_share_id FROM playlists WHERE share_id = ?")
      .bind(child)
      .first<{ derived_from_share_id: string | null }>()
    expect(row?.derived_from_share_id).toBe(parent)
  })
})

describe("cursor forgery and scan bounds", () => {
  it("mix-and-match cursor halves (valid payload + foreign signature) fail closed", async () => {
    const tag = "adv-cursor-mix"
    await seedTagged(tag, 4)
    const p1 = await listData(await listViaRoute(listRequest({ sort: "new", tag, limit: "1" })))
    const p2 = await listData(await listViaRoute(listRequest({ sort: "new", tag, limit: "2" })))
    const c1 = p1.nextCursor ?? ""
    const c2 = p2.nextCursor ?? ""
    const [body1] = c1.split(".")
    const [, sig2] = c2.split(".")
    // Attacker splices a genuine payload with a different request's MAC —
    // the HMAC binds payload+query so this must be rejected like a forgery.
    const spliced = `${body1}.${sig2}`
    const res = await listViaRoute(listRequest({ sort: "new", tag, cursor: spliced }))
    expect(res.status).toBe(400)
    expect(res.headers.get("cache-control")).toContain("no-store")
  })

  it("re-encoded payload with attacker offset keeps failing (signature covers payload)", async () => {
    const tag = "adv-cursor-forge"
    await seedTagged(tag, 4)
    const p1 = await listData(await listViaRoute(listRequest({ sort: "new", tag, limit: "2" })))
    const cursor = p1.nextCursor ?? ""
    const payload = cursorPayload(cursor)
    // Forge: same snapshot id, offset reset to 0 (rewind attack) — or pushed
    // past the 1_000_000 scan bound. Both payloads are re-encoded by the
    // attacker, who cannot produce a matching HMAC.
    for (const forgedOffset of [0, 2_000_000, Number.MAX_SAFE_INTEGER]) {
      const forgedBody = btoa(JSON.stringify({ v: 1, ...payload, o: forgedOffset }))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "")
      const forged = `${forgedBody}.${cursor.split(".")[1] ?? ""}`
      const res = await listViaRoute(listRequest({ sort: "new", tag, cursor: forged }))
      expect(res.status).toBe(400)
    }
    // Garbage that merely LOOKS structured.
    for (const junk of ["AAAA.BBBB", "..", `${"x".repeat(500)}.${"y".repeat(100)}`]) {
      const res = await listViaRoute(listRequest({ sort: "new", tag, cursor: junk }))
      expect(res.status).toBe(400)
    }
  })

  it("a valid cursor cannot be replayed across sort/filter/query changes", async () => {
    const tag = "adv-cursor-scope"
    await seedTagged(tag, 4)
    const p1 = await listData(await listViaRoute(listRequest({ sort: "new", tag, limit: "2" })))
    const cursor = p1.nextCursor ?? ""
    // The fingerprint binds mode/q/sort/tag/window — never the page size
    // (continuations legitimately pick a different limit).
    for (const replay of [
      { sort: "popular", tag, cursor },
      { sort: "new", tag, q: "anything", cursor },
      { sort: "new", cursor }, // dropped tag
      { sort: "new", tag: `${tag}-other`, cursor }, // swapped tag
    ]) {
      const res = await listViaRoute(listRequest(replay))
      expect(res.status).toBe(400)
    }
  })
})
