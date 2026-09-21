import { beforeAll, describe, expect, it } from "vitest"
import {
  cursorPayload,
  dayBefore,
  db,
  expireSnapshot,
  listAt,
  listData,
  listRequest,
  listViaRoute,
  migratedDb,
  seedImport,
  seedMany,
  seedPlaylist,
  snapshotCount,
  tagsViaRoute,
} from "./helpers.js"

// Collection mechanics (task 19): pagination, cursors, visibility re-checks,
// truncation, validation, the tag dictionary and route wiring. The adaptive
// window ladder lives in windows.test.ts — the two files get separate
// Miniflare D1s.
//
// IMPORTANT ISOLATION RULE: tests in a file share one D1 AND the snapshot
// cache keyed by query fingerprint. Every test therefore uses a UNIQUE tag
// (or q) so its fingerprint — and its materialized candidate set — can never
// collide with another test's snapshot. Assertions scope to that subset.

const NOW = new Date("2026-03-10T12:00:00.000Z")
const ISO = (month: number, day: number) =>
  `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00.000Z`

beforeAll(async () => {
  await migratedDb()
})

async function pub(firstPublishedAt: string, options: Parameters<typeof seedPlaylist>[1] = {}) {
  return seedPlaylist(db(), { ...options, firstPublishedAt })
}

async function seedTagged(tag: string, count: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    ids.push(await seedPlaylist(db(), { firstPublishedAt: ISO(3, 1 + i), tags: [tag] }))
  }
  return ids // ids[i] published before ids[j] for i<j
}

function shareIdsOf(data: Awaited<ReturnType<typeof listData>>): string[] {
  return data.items.map((item) => item.shareId)
}

describe("public-only eligibility", () => {
  it("unlisted, pending and blocked rows never surface through the listing", async () => {
    const publics = await seedTagged("vis-ok", 4)
    const hidden = [
      await pub(ISO(3, 6), { visibility: "unlisted", tags: ["vis-hid"] }),
      await pub(ISO(3, 7), { blocked: true, tags: ["vis-hid"] }),
      await seedPlaylist(db(), { pending: true, tags: ["vis-hid"] }),
    ]
    const visible = await listData(await listAt(listRequest({ sort: "new", tag: "vis-ok" }), NOW))
    expect(shareIdsOf(visible)).toEqual([...publics].reverse())
    // A tag whose only members are hidden yields an honest empty — not a leak.
    const hiddenRes = await listData(
      await listAt(listRequest({ sort: "new", tag: "vis-hid" }), NOW),
    )
    expect(hiddenRes.items).toEqual([])
    // And the hidden ids are absent from every surface of the visible listing.
    for (const id of hidden) expect(shareIdsOf(visible)).not.toContain(id)
  })

  it("suggested sources redact a non-public parent — no unlisted leak", async () => {
    const parent = await pub(ISO(3, 1), { visibility: "unlisted", tags: ["src-p"] })
    await seedPlaylist(db(), {
      firstPublishedAt: ISO(3, 2),
      tags: ["src-c"],
      derivedFrom: { shareId: parent, revision: 2 },
    })
    const data = await listData(await listAt(listRequest({ sort: "new", tag: "src-c" }), NOW))
    expect(data.items).toHaveLength(1)
    expect(data.items[0]?.source).toBeNull()
    // The projected playlist itself must not carry derivedFrom either.
    expect("derivedFrom" in (data.items[0]?.playlist ?? {})).toBe(false)
  })
})

describe("search and tag filters", () => {
  it("q matches normalized search text; no-match yields an empty list", async () => {
    await pub(ISO(3, 1), { title: "特別なタイトル", tags: ["ft-a"] })
    await pub(ISO(3, 2), { title: "別のリスト", tags: ["ft-a"] })
    const hit = await listData(await listAt(listRequest({ sort: "new", q: "特別" }), NOW))
    expect(hit.items).toHaveLength(1)
    expect(hit.items[0]?.playlist.title).toBe("特別なタイトル")
    const miss = await listData(await listAt(listRequest({ sort: "new", q: "存在しない語" }), NOW))
    expect(miss.items).toEqual([])
    expect(miss.nextCursor).toBeUndefined()
  })

  it("LIKE metacharacters in q are literal, not patterns", async () => {
    await pub(ISO(3, 1), { title: "100% legit", tags: ["ft-b"] })
    // "%" alone is a wildcard in LIKE; escaped it must match literally and
    // only the playlist containing a real '%'.
    const res = await listData(await listAt(listRequest({ sort: "new", q: "%" }), NOW))
    expect(res.items).toHaveLength(1)
    expect(res.items[0]?.playlist.title).toBe("100% legit")
  })

  it("tag filter returns only matching playlists; no-match yields empty", async () => {
    const tagged = await pub(ISO(3, 1), { tags: ["ft-vocaloid"] })
    await pub(ISO(3, 2), { tags: ["ft-other"] })
    const hit = await listData(await listAt(listRequest({ sort: "new", tag: "FT-Vocaloid" }), NOW))
    expect(shareIdsOf(hit)).toEqual([tagged])
    const miss = await listData(await listAt(listRequest({ sort: "new", tag: "ft-nosuch" }), NOW))
    expect(miss.items).toEqual([])
  })

  it("a whitespace-only q is a real filter that matches nothing", async () => {
    await pub(ISO(3, 1), { tags: ["ft-c"] })
    const res = await listData(await listAt(listRequest({ sort: "new", q: "   " }), NOW))
    expect(res.items).toEqual([])
  })
})

describe("pagination", () => {
  it("pages a frozen snapshot with opaque cursors until exhausted", async () => {
    const ids = await seedTagged("pg-a", 5)
    const page1 = await listData(
      await listAt(listRequest({ sort: "new", tag: "pg-a", limit: "2" }), NOW),
    )
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).toBeDefined()
    const page2 = await listData(
      await listAt(
        listRequest({ sort: "new", tag: "pg-a", limit: "2", cursor: page1.nextCursor ?? "" }),
        NOW,
      ),
    )
    expect(page2.items).toHaveLength(2)
    const page3 = await listData(
      await listAt(
        listRequest({ sort: "new", tag: "pg-a", limit: "2", cursor: page2.nextCursor ?? "" }),
        NOW,
      ),
    )
    expect(page3.items).toHaveLength(1)
    expect(page3.nextCursor).toBeUndefined()
    const seen = [...shareIdsOf(page1), ...shareIdsOf(page2), ...shareIdsOf(page3)]
    expect(seen).toEqual([...ids].reverse())
  })

  it("new imports and publications never enter an open continuation", async () => {
    const ids = await seedTagged("pg-b", 5)
    const page1 = await listData(
      await listAt(listRequest({ sort: "new", tag: "pg-b", limit: "2" }), NOW),
    )
    // Frozen snapshot already taken; mutate underneath it: a fresh import on
    // the tail entry plus a brand-new publication must stay invisible.
    await seedImport(db(), ids[0] ?? "", dayBefore(NOW, 0))
    const newcomer = await pub(ISO(3, 9), { tags: ["pg-b"] })
    const page2 = await listData(
      await listAt(
        listRequest({ sort: "new", tag: "pg-b", limit: "2", cursor: page1.nextCursor ?? "" }),
        NOW,
      ),
    )
    const page3 = await listData(
      await listAt(
        listRequest({ sort: "new", tag: "pg-b", limit: "2", cursor: page2.nextCursor ?? "" }),
        NOW,
      ),
    )
    const seen = [...shareIdsOf(page1), ...shareIdsOf(page2), ...shareIdsOf(page3)]
    expect(seen).toEqual([...ids].reverse())
    expect(seen).not.toContain(newcomer)
    expect(page3.nextCursor).toBeUndefined()
  })

  it("hidden/deleted rows are skipped but still consume scanned positions", async () => {
    const ids = await seedTagged("pg-c", 5)
    const page1 = await listData(
      await listAt(listRequest({ sort: "new", tag: "pg-c", limit: "2" }), NOW),
    )
    // Page 1 held positions 0-1 (ids[4], ids[3]). Block position 2, delete 3.
    await db().prepare("UPDATE playlists SET blocked = 1 WHERE share_id = ?").bind(ids[2]).run()
    await db().prepare("DELETE FROM playlists WHERE share_id = ?").bind(ids[1]).run()
    const page2 = await listData(
      await listAt(
        listRequest({ sort: "new", tag: "pg-c", limit: "2", cursor: page1.nextCursor ?? "" }),
        NOW,
      ),
    )
    // Positions 2 (blocked) and 3 (deleted) were consumed but skipped; only
    // position 4 (ids[0]) remains visible and the stream is exhausted.
    expect(shareIdsOf(page2)).toEqual([ids[0]])
    expect(page2.nextCursor).toBeUndefined()
  })

  it("rejects tampered, malformed and query-mismatched cursors with 400", async () => {
    await seedTagged("pg-d", 5)
    const page1 = await listData(
      await listAt(listRequest({ sort: "new", tag: "pg-d", limit: "2" }), NOW),
    )
    const cursor = page1.nextCursor ?? ""
    const [body] = cursor.split(".")

    for (const bad of [
      `${body}.AAAA`, // wrong signature
      "not-a-cursor",
      cursor.slice(0, -1), // truncated signature byte
    ]) {
      const res = await listAt(listRequest({ sort: "new", tag: "pg-d", cursor: bad }), NOW)
      expect(res.status).toBe(400)
      expect(res.headers.get("cache-control")).toContain("no-store")
    }

    // Same cursor under a different query -> fingerprint mismatch -> 400.
    for (const replay of [
      { sort: "popular", tag: "pg-d", cursor },
      { sort: "new", tag: "pg-d", q: "x", cursor },
      { sort: "new", cursor }, // missing tag changes the fingerprint too
    ]) {
      const res = await listAt(listRequest(replay), NOW)
      expect(res.status).toBe(400)
    }
  })

  it("answers 410 + restart guidance for an expired or swept snapshot", async () => {
    await seedTagged("pg-e", 5)
    const page1 = await listData(
      await listAt(listRequest({ sort: "new", tag: "pg-e", limit: "2" }), NOW),
    )
    const cursor = page1.nextCursor ?? ""
    await expireSnapshot(db(), cursorPayload(cursor).s, NOW)
    const res = await listAt(listRequest({ sort: "new", tag: "pg-e", cursor }), NOW)
    expect(res.status).toBe(410)
    expect(res.headers.get("cache-control")).toContain("no-store")
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("CURSOR_EXPIRED")
    expect(body.error.message).toContain("restart")

    // A snapshot row that no longer exists at all -> same honest 410.
    const live = await listData(
      await listAt(listRequest({ sort: "new", tag: "pg-e", limit: "2" }), NOW),
    )
    const liveCursor = live.nextCursor ?? ""
    await db()
      .prepare("DELETE FROM discovery_snapshots WHERE snapshot_id = ?")
      .bind(cursorPayload(liveCursor).s)
      .run()
    const gone = await listAt(listRequest({ sort: "new", tag: "pg-e", cursor: liveCursor }), NOW)
    expect(gone.status).toBe(410)
  })

  it("reuses a <60s snapshot for identical first pages, then materializes fresh", async () => {
    await seedTagged("pg-f", 3)
    const request = () => listRequest({ sort: "new", tag: "pg-f" })
    const before = await snapshotCount(db())
    await listAt(request(), NOW)
    await listAt(request(), NOW)
    expect(await snapshotCount(db())).toBe(before + 1)
    // Age every live snapshot past the 60s first-page reuse window.
    await db()
      .prepare("UPDATE discovery_snapshots SET created_at = ? WHERE expires_at > ?")
      .bind(new Date(NOW.getTime() - 61_000).toISOString(), NOW.toISOString())
      .run()
    await listAt(request(), NOW)
    expect(await snapshotCount(db())).toBe(before + 2)
  })
})

describe("materialization cap", () => {
  it("marks truncated at >1000 candidates and pages exactly 1000 frozen ids", async () => {
    await seedMany(db(), 1_005)
    const first = await listData(await listAt(listRequest({ sort: "new", q: "bulk" }), NOW))
    expect(first.truncated).toBe(true)
    const seen = new Set(shareIdsOf(first))
    let cursor = first.nextCursor
    while (cursor !== undefined) {
      const page = await listData(
        await listAt(listRequest({ sort: "new", q: "bulk", limit: "50", cursor }), NOW),
      )
      expect(page.truncated).toBe(true)
      for (const id of shareIdsOf(page)) seen.add(id)
      cursor = page.nextCursor
    }
    expect(seen.size).toBe(1_000)
  }, 120_000)
})

describe("query validation", () => {
  it("rejects invalid params with 400 and field details", async () => {
    for (const params of [
      { limit: "abc" },
      { limit: "51" },
      { limit: "0" },
      { sort: "bogus" },
      { bogus: "1" },
      { q: "" },
      { cursor: "" },
    ]) {
      const res = await listAt(listRequest(params), NOW)
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe("BAD_REQUEST")
    }
  })
})

describe("first_published_at stability", () => {
  it("metadata edits never change publication time or new-order", async () => {
    const older = await pub(ISO(1, 1), { title: "first", tags: ["meta"] })
    const newer = await pub(ISO(3, 1), { title: "second", tags: ["meta"] })
    await db()
      .prepare("UPDATE playlists SET title = ?, updated_at = ? WHERE share_id = ?")
      .bind("retitled", "2026-03-10T12:30:00.000Z", older)
      .run()
    const data = await listData(await listAt(listRequest({ sort: "new", tag: "meta" }), NOW))
    expect(shareIdsOf(data)).toEqual([newer, older])
    const olderItem = data.items.find((item) => item.shareId === older)
    expect(olderItem?.publishedAt).toBe(ISO(1, 1))
    expect(olderItem?.updatedAt).toBe("2026-03-10T12:30:00.000Z")
  })
})

describe("tag dictionary endpoint", () => {
  it("counts eligible public playlists only, ordered by usage", async () => {
    await pub(ISO(3, 1), { tags: ["tagdict-a", "tagdict-shared"] })
    await pub(ISO(3, 2), { tags: ["tagdict-b", "tagdict-shared"] })
    await pub(ISO(3, 3), { tags: ["tagdict-hid"], visibility: "unlisted" })
    await pub(ISO(3, 4), { tags: ["tagdict-blocked"], blocked: true })
    const res = await tagsViaRoute()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toContain("no-store")
    const body = (await res.json()) as {
      data: { tags: { tag: string; count: number }[] }
    }
    const tags = body.data.tags
    expect(tags).toContainEqual({ tag: "tagdict-shared", count: 2 })
    expect(tags).toContainEqual({ tag: "tagdict-a", count: 1 })
    expect(tags).toContainEqual({ tag: "tagdict-b", count: 1 })
    expect(tags.find((row) => row.tag === "tagdict-hid")).toBeUndefined()
    expect(tags.find((row) => row.tag === "tagdict-blocked")).toBeUndefined()
    // Ordering: count desc, then tag asc.
    const idxShared = tags.findIndex((row) => row.tag === "tagdict-shared")
    const idxA = tags.findIndex((row) => row.tag === "tagdict-a")
    expect(idxShared).toBeGreaterThanOrEqual(0)
    expect(idxShared).toBeLessThan(idxA === -1 ? Number.MAX_SAFE_INTEGER : idxA)
  })
})

describe("route wiring smoke", () => {
  it("GET /api/v1/playlists answers through the real Astro route", async () => {
    await pub(ISO(3, 1), { tags: ["smoke"] })
    const res = await listViaRoute(listRequest({ tag: "smoke" }))
    expect(res.status).toBe(200)
    const data = await listData(res)
    expect(data.ranking.mode).toBe("new")
    expect(data.items).toHaveLength(1)
  })
})
