import { beforeAll, describe, expect, it } from "vitest"
import { REMIX_PAGE_SIZE } from "../../src/server/repositories/snapshots/read.js"
import { call, dataOf, db, getRoute, getShare, migratedDb, page, seedPlaylist } from "./helpers.js"

// Bounded direct-children Remix view (task 20): the /p/:shareId page lists
// only DIRECT children that are currently active+public+unblocked, paginated
// at REMIX_PAGE_SIZE with a hard page cap — never a recursive graph walk and
// never an unbounded result set. Ineligible children (pending, unlisted,
// blocked) drop out of both the items and the count at read time.

beforeAll(async () => {
  await migratedDb()
})

describe("direct-children remix view", () => {
  it("paginates at REMIX_PAGE_SIZE with a next link and an honest total", async () => {
    const database = db()
    const parentId = await seedPlaylist(database, { title: "remix-kids-parent" })
    const expectedTitles: string[] = []
    for (let index = 0; index < REMIX_PAGE_SIZE + 2; index += 1) {
      const title = `remix-kid-${String(index).padStart(2, "0")}`
      expectedTitles.push(title)
      await seedPlaylist(database, {
        title,
        derivedFrom: { shareId: parentId, revision: 2 },
      })
    }
    // Ineligible children — pending, unlisted and blocked all drop out.
    await seedPlaylist(database, {
      title: "remix-kid-pending",
      pending: true,
      derivedFrom: { shareId: parentId, revision: 2 },
    })
    await seedPlaylist(database, {
      title: "remix-kid-unlisted",
      visibility: "unlisted",
      derivedFrom: { shareId: parentId, revision: 2 },
    })
    await seedPlaylist(database, {
      title: "remix-kid-blocked",
      blocked: true,
      derivedFrom: { shareId: parentId, revision: 2 },
    })
    // A child of some OTHER parent never leaks into this view.
    const otherParent = await seedPlaylist(database, { title: "remix-kids-other" })
    await seedPlaylist(database, {
      title: "remix-kid-foreign",
      derivedFrom: { shareId: otherParent, revision: 2 },
    })

    const first = await page(parentId)
    expect(first.kind).toBe("ready")
    if (first.kind !== "ready") return
    expect(first.view.remix.total).toBe(REMIX_PAGE_SIZE + 2)
    expect(first.view.remix.page).toBe(1)
    expect(first.view.remix.items).toHaveLength(REMIX_PAGE_SIZE)
    expect(first.view.remix.nextUrl).toBe(`/p/${parentId}?remix=2`)

    const second = await page(parentId, "?remix=2")
    expect(second.kind).toBe("ready")
    if (second.kind !== "ready") return
    expect(second.view.remix.page).toBe(2)
    expect(second.view.remix.items).toHaveLength(2)
    expect(second.view.remix.nextUrl).toBeNull()
    expect(second.view.remix.total).toBe(REMIX_PAGE_SIZE + 2)

    const seen = [
      ...first.view.remix.items.map((item) => item.title),
      ...second.view.remix.items.map((item) => item.title),
    ]
    expect([...seen].sort()).toEqual([...expectedTitles].sort())
    const serialized = JSON.stringify([first.view.remix, second.view.remix])
    expect(serialized).not.toContain("pending")
    expect(serialized).not.toContain("unlisted")
    expect(serialized).not.toContain("blocked")
    expect(serialized).not.toContain("foreign")
  })

  it("out-of-range and malformed page params degrade safely", async () => {
    const database = db()
    const parentId = await seedPlaylist(database, { title: "remix-range-parent" })
    await seedPlaylist(database, {
      title: "remix-range-child",
      derivedFrom: { shareId: parentId, revision: 2 },
    })
    const malformed = await page(parentId, "?remix=abc")
    expect(malformed.kind).toBe("ready")
    if (malformed.kind === "ready") {
      expect(malformed.view.remix.page).toBe(1)
      expect(malformed.view.remix.items).toHaveLength(1)
    }
    const beyond = await page(parentId, "?remix=999")
    expect(beyond.kind).toBe("ready")
    if (beyond.kind === "ready") {
      expect(beyond.view.remix.items).toHaveLength(0)
      expect(beyond.view.remix.nextUrl).toBeNull()
      expect(beyond.view.remix.total).toBe(1)
    }
    const absent = await page(parentId, "?remix=-3")
    if (absent.kind === "ready") expect(absent.view.remix.page).toBe(1)
  })

  it("an unlisted parent's page still lists its public children", async () => {
    const database = db()
    const parentId = await seedPlaylist(database, {
      title: "remix-unlisted-parent",
      visibility: "unlisted",
    })
    await seedPlaylist(database, {
      title: "remix-unlisted-kid",
      derivedFrom: { shareId: parentId, revision: 2 },
    })
    const view = await page(parentId)
    expect(view.kind).toBe("ready")
    if (view.kind !== "ready") return
    expect(view.view.remix.total).toBe(1)
    expect(view.view.remix.items[0]?.title).toBe("remix-unlisted-kid")
  })

  it("children of a deleted parent stay readable; their source stays redacted", async () => {
    const database = db()
    const parentId = await seedPlaylist(database, { title: "remix-gone-parent" })
    const childId = await seedPlaylist(database, {
      title: "remix-gone-child",
      derivedFrom: { shareId: parentId, revision: 2 },
    })
    await database.prepare("DELETE FROM playlists WHERE share_id = ?1").bind(parentId).run()
    const res = await call(getRoute, getShare(childId), { shareId: childId })
    expect(res.status).toBe(200)
    const data = (await dataOf(res)) as Record<string, unknown>
    expect(data["source"]).toBeNull()
    expect(JSON.stringify(data)).not.toContain(parentId)
    const view = await page(childId)
    expect(view.kind).toBe("ready")
    if (view.kind === "ready") expect(view.view.sourceUrl).toBeNull()
  })
})
