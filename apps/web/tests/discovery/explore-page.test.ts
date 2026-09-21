import { beforeAll, describe, expect, it } from "vitest"
import { loadExplorePage } from "../../src/server/services/explore-page.js"
import {
  cursorPayload,
  db,
  expireSnapshot,
  listAt,
  listData,
  listRequest,
  migratedDb,
  seedImport,
  seedPlaylist,
} from "./helpers.js"

// /explore view-model tests (task 19): the page must surface the REAL ranking
// basis (window + fallback), pagination URLs and honest non-ready states —
// never a fake directory. Clock injected through loadExplorePage's deps.
// Every test uses a unique tag so its query fingerprint — and therefore its
// cached snapshot — cannot collide with another test's (same file = same D1).

const NOW = new Date("2026-03-10T12:00:00.000Z")
const ISO = (day: number) => `2026-03-${String(day).padStart(2, "0")}T00:00:00.000Z`

beforeAll(async () => {
  await migratedDb()
})

function exploreRequest(params: Record<string, string> = {}): Request {
  const query = new URLSearchParams(params).toString()
  return new Request(`https://d-op.sasnews.dev/explore${query === "" ? "" : `?${query}`}`, {
    method: "GET",
  })
}

describe("loadExplorePage", () => {
  it("ready: items carry public fields and never leak hidden rows", async () => {
    const shown = await seedPlaylist(db(), { firstPublishedAt: ISO(1), tags: ["xp-a"] })
    await seedPlaylist(db(), {
      firstPublishedAt: ISO(2),
      visibility: "unlisted",
      tags: ["xp-a"],
    })
    const result = await loadExplorePage(exploreRequest({ tag: "xp-a" }), crypto.randomUUID(), {
      now: NOW,
    })
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") return
    expect(result.view.items.map((item) => item.shareId)).toEqual([shown])
    expect(result.view.items[0]?.url).toBe(`/p/${shown}`)
    expect(result.view.filters).toEqual({ sort: "new", q: null, tag: "xp-a" })
    expect(result.view.canonicalUrl).toBe("https://d-op.sasnews.dev/explore")
  })

  it("labels the real effective window and the fallback reason", async () => {
    for (let i = 0; i < 5; i += 1) {
      const id = await seedPlaylist(db(), { firstPublishedAt: ISO(i + 1), tags: ["xp-b"] })
      await seedImport(db(), id, "2026-03-09")
    }
    const popular = await loadExplorePage(
      exploreRequest({ sort: "popular", tag: "xp-b" }),
      crypto.randomUUID(),
      { now: NOW },
    )
    expect(popular.kind).toBe("ready")
    if (popular.kind !== "ready") return
    expect(popular.view.ranking.effectiveWindow).toBe("30d")
    expect(popular.view.basisLabel).toContain("人気順")
    expect(popular.view.basisLabel).toContain("30日")
    expect(popular.view.fallbackLabel).toBeNull()

    // At a distant clock the same rows only have lifetime positives -> the
    // widened-window explanation renders instead of a bare silent listing.
    const widened = await loadExplorePage(
      exploreRequest({ sort: "popular", tag: "xp-b" }),
      crypto.randomUUID(),
      { now: new Date("2030-01-01T00:00:00.000Z") },
    )
    expect(widened.kind).toBe("ready")
    if (widened.kind !== "ready") return
    expect(widened.view.ranking.effectiveWindow).toBe("lifetime")
    expect(widened.view.fallbackLabel).toContain("広げて")
  })

  it("exposes a next-page URL that preserves filters and carries the cursor", async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedPlaylist(db(), { firstPublishedAt: ISO(i + 1), tags: ["xp-c"] })
    }
    const result = await loadExplorePage(
      exploreRequest({ sort: "new", tag: "xp-c", limit: "2" }),
      crypto.randomUUID(),
      { now: NOW },
    )
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") return
    expect(result.view.items).toHaveLength(2)
    expect(result.view.nextPageUrl).not.toBeNull()
    const url = new URL(result.view.nextPageUrl ?? "", "https://d-op.sasnews.dev")
    expect(url.pathname).toBe("/explore")
    expect(url.searchParams.get("sort")).toBe("new")
    expect(url.searchParams.get("tag")).toBe("xp-c")
    expect(url.searchParams.get("cursor")).not.toBeNull()
    // Following the page URL returns the remaining item, proving SSR cursor flow.
    const page2 = await loadExplorePage(
      new Request(url.toString(), { method: "GET" }),
      crypto.randomUUID(),
      { now: NOW },
    )
    expect(page2.kind).toBe("ready")
    if (page2.kind !== "ready") return
    expect(page2.view.items).toHaveLength(1)
    expect(page2.view.nextPageUrl).toBeNull()
    expect(page2.view.restartUrl).not.toBeNull()
  })

  it("invalid query -> kind invalid (page renders 400)", async () => {
    const result = await loadExplorePage(exploreRequest({ limit: "999" }), crypto.randomUUID(), {
      now: NOW,
    })
    expect(result.kind).toBe("invalid")
  })

  it("expired cursor -> kind expired with restart guidance", async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedPlaylist(db(), { firstPublishedAt: ISO(i + 1), tags: ["xp-d"] })
    }
    // Real signed cursor from the real engine, then expire its snapshot row.
    const page1 = await listData(
      await listAt(listRequest({ sort: "new", tag: "xp-d", limit: "1" }), NOW),
    )
    const cursor = page1.nextCursor ?? ""
    expect(cursor).not.toBe("")
    await expireSnapshot(db(), cursorPayload(cursor).s, NOW)
    const result = await loadExplorePage(
      exploreRequest({ sort: "new", tag: "xp-d", cursor }),
      crypto.randomUUID(),
      { now: NOW },
    )
    expect(result.kind).toBe("expired")
  })

  it("tag chips come from the public dictionary and mark the active tag", async () => {
    await seedPlaylist(db(), { firstPublishedAt: ISO(1), tags: ["xp-e"] })
    const result = await loadExplorePage(exploreRequest({ tag: "xp-e" }), crypto.randomUUID(), {
      now: NOW,
    })
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") return
    const chip = result.view.tagChips.find((row) => row.tag === "xp-e")
    expect(chip).toBeDefined()
    expect(chip?.active).toBe(true)
    expect(chip?.count).toBe(1)
    expect(chip?.url).toContain("tag=xp-e")
  })
})
