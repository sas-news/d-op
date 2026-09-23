import { beforeAll, describe, expect, it } from "vitest"
import { loadExplorePage } from "../../src/server/services/explore-page.js"
import { db, migratedDb, seedImport, seedPlaylist } from "./helpers.js"

// /explore view-model tests (task 19): the page must surface the REAL ranking
// basis (window + fallback), pagination URLs and honest non-ready states —
// never a fake directory. Clock injected through loadExplorePage's deps.
// Every test uses a unique tag so its result set cannot collide with another
// test's (same file = same D1). Numbered paging is live — nothing expires.

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

  it("exposes a next-page URL that preserves filters with short s/p params", async () => {
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
    // Human-facing pages are plain ?p=N over live data — no snapshot id, no
    // signed cursor, nothing that can expire. Cursors stay API-only.
    expect(url.searchParams.get("s")).toBeNull()
    expect(url.searchParams.get("p")).toBe("2")
    expect(url.searchParams.get("cursor")).toBeNull()
    // Following the page URL returns the remaining item, proving SSR paging.
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

  it("exposes a numbered pager over live data", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedPlaylist(db(), { firstPublishedAt: ISO(i + 1), tags: ["xp-pager"] })
    }
    const page1 = await loadExplorePage(
      exploreRequest({ sort: "new", tag: "xp-pager", limit: "2" }),
      crypto.randomUUID(),
      { now: NOW },
    )
    expect(page1.kind).toBe("ready")
    if (page1.kind !== "ready") return
    const pager = page1.view.pager
    expect(pager).not.toBeNull()
    if (pager === null) return
    expect(pager.current).toBe(1)
    expect(pager.totalPages).toBe(3)
    expect(pager.total).toBe(5)
    expect(pager.links.map((link) => link.page)).toEqual([1, 2, 3])
    // Page 1 is the bare filtered URL; deeper pages are just ?p=N.
    expect(pager.links[0]?.url).not.toContain("s=")
    expect(pager.links[0]?.url).not.toContain("p=")
    expect(pager.links[1]?.url).toContain("p=2")
    expect(pager.links[1]?.url).not.toContain("s=")
    expect(pager.links[1]?.url).not.toContain("cursor=")
    expect(pager.prevUrl).toBeNull()
    expect(pager.nextUrl).not.toBeNull()
    expect(pager.lastUrl).not.toBeNull()

    // Following a numbered link lands exactly on that page's slice.
    const page2 = await loadExplorePage(
      new Request(new URL(pager.links[1]?.url ?? "", "https://d-op.sasnews.dev").toString(), {
        method: "GET",
      }),
      crypto.randomUUID(),
      { now: NOW },
    )
    expect(page2.kind).toBe("ready")
    if (page2.kind !== "ready") return
    expect(page2.view.pager?.current).toBe(2)
    expect(page2.view.pager?.prevUrl).not.toBeNull()
    // The middle of a 3-page list keeps links to 1, 2, 3.
    expect(page2.view.pager?.links.map((link) => link.page)).toEqual([1, 2, 3])
    expect(page2.view.pager?.links.find((link) => link.page === 2)?.current).toBe(true)
  })

  it("a bare form submit never errors: empty fields and stray params drop", async () => {
    await seedPlaylist(db(), { firstPublishedAt: ISO(1), tags: ["xp-form"] })
    // The GET form always submits every field — empty ones included — plus
    // whatever trackers a browser/extension appends.
    // Non-canonical queries are answered with a redirect to the clean URL —
    // never an error page, and following it lands on live data.
    for (const [suffix, expected] of [
      ["?sort=new&q=&tag=", "/explore?sort=new"],
      ["?sort=new&q=nonexistent&tag=", "/explore?sort=new&q=nonexistent"],
      ["?sort=new&utm_source=share", "/explore?sort=new"],
      ["?q=", "/explore"],
    ] as const) {
      const result = await loadExplorePage(
        new Request(`https://d-op.sasnews.dev/explore${suffix}`, { method: "GET" }),
        crypto.randomUUID(),
        { now: NOW },
      )
      expect(result.kind, suffix).toBe("redirect")
      if (result.kind !== "redirect") continue
      expect(result.location).toBe(expected)
      const followed = await loadExplorePage(
        new Request(`https://d-op.sasnews.dev${result.location}`, { method: "GET" }),
        crypto.randomUUID(),
        { now: NOW },
      )
      expect(followed.kind, `${suffix} -> ${result.location}`).toBe("ready")
    }
  })

  it("p alone pages live data; out-of-range p clamps to the last page", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedPlaylist(db(), { firstPublishedAt: ISO(i + 1), tags: ["xp-pjump"] })
    }
    const page2 = await loadExplorePage(
      exploreRequest({ tag: "xp-pjump", limit: "2", p: "2" }),
      crypto.randomUUID(),
      { now: NOW },
    )
    expect(page2.kind).toBe("ready")
    if (page2.kind !== "ready") return
    expect(page2.view.pager?.current).toBe(2)
    expect(page2.view.items).toHaveLength(2)

    // p beyond the end lands on the last page instead of an empty hole.
    const far = await loadExplorePage(
      exploreRequest({ tag: "xp-pjump", limit: "2", p: "999" }),
      crypto.randomUUID(),
      { now: NOW },
    )
    expect(far.kind).toBe("ready")
    if (far.kind !== "ready") return
    expect(far.view.pager?.current).toBe(3)
    expect(far.view.items).toHaveLength(1)
  })

  it("legacy s/cursor params canonicalize away — stale links still land fine", async () => {
    // Old snapshot-era URLs (?s=<id>&p=N, ?cursor=<signed>) redirect to the
    // clean live URL — the page itself can never expire.
    for (const [suffix, expected] of [
      [`?s=${crypto.randomUUID()}&p=2`, "/explore?p=2"],
      ["?cursor=tampered.garbage", "/explore"],
      ["?s=not-a-uuid", "/explore"],
    ] as const) {
      const result = await loadExplorePage(
        new Request(`https://d-op.sasnews.dev/explore${suffix}`, { method: "GET" }),
        crypto.randomUUID(),
        { now: NOW },
      )
      expect(result.kind, suffix).toBe("redirect")
      if (result.kind !== "redirect") continue
      expect(result.location).toBe(expected)
    }
  })

  it("malformed p values canonicalize to the bare page — never an error", async () => {
    for (const suffix of ["?p=abc", "?p=0x2", "?p=-1", "?p=", "?p=1", "?p=0"]) {
      const result = await loadExplorePage(
        new Request(`https://d-op.sasnews.dev/explore${suffix}`, { method: "GET" }),
        crypto.randomUUID(),
        { now: NOW },
      )
      expect(result.kind, suffix).toBe("redirect")
      if (result.kind !== "redirect") continue
      expect(result.location).toBe("/explore")
    }
  })

  it("invalid query -> kind invalid (page renders 400)", async () => {
    const result = await loadExplorePage(exploreRequest({ limit: "999" }), crypto.randomUUID(), {
      now: NOW,
    })
    expect(result.kind).toBe("invalid")
  })

  it("an expired snapshot-era cursor redirects to live data — never a 410", async () => {
    // Even a syntactically real (but stale) cursor is canonicalized away;
    // following the redirect renders live data instead of an expiry page.
    for (let i = 0; i < 3; i += 1) {
      await seedPlaylist(db(), { firstPublishedAt: ISO(i + 1), tags: ["xp-d"] })
    }
    const result = await loadExplorePage(
      exploreRequest({ sort: "new", tag: "xp-d", cursor: "AAAA.BBBB" }),
      crypto.randomUUID(),
      { now: NOW },
    )
    expect(result.kind).toBe("redirect")
    if (result.kind !== "redirect") return
    expect(result.location).toBe("/explore?sort=new&tag=xp-d")
    const followed = await loadExplorePage(
      new Request(`https://d-op.sasnews.dev${result.location}`, { method: "GET" }),
      crypto.randomUUID(),
      { now: NOW },
    )
    expect(followed.kind).toBe("ready")
    if (followed.kind !== "ready") return
    expect(followed.view.items.length).toBeGreaterThan(0)
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
