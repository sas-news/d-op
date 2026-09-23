import { expect, test } from "@playwright/test"
import {
  d1Execute,
  d1Migrate,
  hex64,
  isoDaysAgo,
  shareId,
  sqlString,
  utcDay,
  WEB_ORIGIN,
} from "./d1"

// Task-19 adaptive discovery e2e: GET /api/v1/playlists collection + the
// /explore SSR page against the real built Worker preview with local D1.
// Runs on web-chromium only (see playwright.config.ts testMatch).
//
// Seeding mirrors share-page.spec.ts — direct local-D1 writes via
// `wrangler d1 execute --local`, never the rate-limited POST API. Ranking
// coverage is GLOBAL by contract (filters never narrow the window decision),
// so the window matrix runs serially in widening phases: this spec is the
// only suite that writes import_daily, and it owns the counter state.
//
// Phases: 0 events -> no-imports; <=4 positives -> lifetime; five inside
// 90d only -> 90d; five inside 30d -> 30d. Frozen pagination, hidden-row
// rechecks, expired/tampered cursors, >1000 truncation and public-only
// exclusion are covered through the real API + page.

test.describe.configure({ mode: "serial" })

type SeedInput = {
  readonly title: string
  readonly description?: string
  readonly author?: string
  readonly tags?: readonly string[]
  readonly visibility?: "public" | "unlisted"
  readonly pending?: boolean
  readonly blocked?: boolean
  readonly firstPublishedAt?: string
  readonly importCount?: number
  /** [daysAgo, count] import_daily bucket pairs. */
  readonly buckets?: readonly (readonly [number, number])[]
}

/** Queues INSERTs for one playlist + optional tag joins + import buckets. */
function seed(shareIdValue: string, input: SeedInput, out: string[]): string {
  const title = input.title
  const description = input.description ?? "e2e discovery fixture"
  const author = input.author ?? "e2e-author"
  const tags = input.tags ?? []
  const pending = input.pending === true
  const now = new Date().toISOString()
  const firstPublished = input.firstPublishedAt ?? now
  const snapshot = {
    schemaVersion: 1,
    title,
    description,
    author,
    tags,
    visibility: input.visibility ?? "public",
    items: [
      {
        partId: "part_0",
        title: "作品0",
        episodeTitle: "第1話",
        range: { start: 0, end: 90_000, name: "OP" },
      },
    ],
  }
  const searchText = `${title} ${description} ${author}`.toLowerCase().replace(/\s+/g, " ").trim()
  out.push(
    `INSERT INTO playlists (
       share_id, revision, state, secret_hash, snapshot_json, content_hash, title,
       description, author, search_text, visibility, tags_json, item_count,
       total_duration_ms, import_count, derived_from_share_id, derived_from_revision,
       blocked, created_at, first_published_at, updated_at, activation_expires_at)
     VALUES (${sqlString(shareIdValue)}, ${pending ? 1 : 2}, '${
       pending ? "pending" : "active"
     }', ${sqlString(hex64())}, ${sqlString(JSON.stringify(snapshot))}, ${sqlString(
       hex64(),
     )}, ${sqlString(title)}, ${sqlString(description)}, ${sqlString(author)},
       ${sqlString(searchText)}, '${input.visibility ?? "public"}', ${sqlString(
         JSON.stringify(tags),
       )}, 1, 90000, ${input.importCount ?? 0}, NULL, NULL,
       ${input.blocked === true ? 1 : 0}, ${sqlString(now)}, ${
         pending ? "NULL" : sqlString(firstPublished)
       }, ${sqlString(now)}, ${pending ? sqlString(new Date(Date.now() + 86_400_000).toISOString()) : "NULL"})`,
  )
  for (const tag of tags) {
    out.push(`INSERT OR IGNORE INTO tags (tag) VALUES (${sqlString(tag)})`)
    out.push(
      `INSERT OR IGNORE INTO playlist_tags (share_id, tag_id)
       SELECT ${sqlString(shareIdValue)}, tag_id FROM tags WHERE tag = ${sqlString(tag)}`,
    )
  }
  for (const [daysAgo, count] of input.buckets ?? []) {
    out.push(
      `INSERT INTO import_daily (share_id, day, count)
       VALUES (${sqlString(shareIdValue)}, ${sqlString(utcDay(daysAgo))}, ${count})
       ON CONFLICT (share_id, day) DO UPDATE SET count = import_daily.count + excluded.count`,
    )
  }
  return shareIdValue
}

// d1Execute/d1Migrate live in ./d1.ts — wrangler batches are atomic, so the
// shared bounded-retry policy is replay-safe even for ON CONFLICT increments.

type ListData = {
  readonly items: { readonly shareId: string; readonly playlist: { readonly title: string } }[]
  readonly nextCursor?: string
  readonly truncated?: boolean
  readonly ranking: {
    readonly mode: string
    readonly effectiveWindow: string
    readonly fallbackReason?: string
  }
}

async function apiList(
  request: import("@playwright/test").APIRequestContext,
  params: Record<string, string>,
): Promise<{ status: number; data: ListData }> {
  const query = new URLSearchParams(params).toString()
  const res = await request.get(`${WEB_ORIGIN}/api/v1/playlists${query === "" ? "" : `?${query}`}`)
  const body = (await res.json()) as { data?: ListData }
  return { status: res.status(), data: body.data as ListData }
}

const MAIN_IDS: string[] = [] // five main public fixtures, oldest -> newest
let NEEDLE_ID = ""
let UNLISTED_ID = ""
let BLOCKED_ID = ""
let PENDING_ID = ""
const PAGE_IDS: string[] = [] // five frozen-pagination fixtures
const EXP_IDS: string[] = [] // five expired-cursor fixtures

test.beforeAll(() => {
  test.setTimeout(180_000)
  d1Migrate()
  // The shared local-D1 file persists across runs: prior phases leave import
  // rows that break phase 0's global "no import events" premise, and random
  // shareIds make stale e2e*-titled fixtures accumulate. This suite owns all
  // import-derived state (no other spec reads counters) — wipe it and the
  // stale fixtures before seeding. playlist_tags has no enforced cascade in
  // local D1, so delete its rows explicitly.
  d1Execute([
    "DELETE FROM discovery_snapshots",
    "DELETE FROM import_receipts",
    "DELETE FROM import_daily",
    "DELETE FROM playlist_tags WHERE share_id IN (SELECT share_id FROM playlists WHERE title LIKE 'e2e%')",
    "DELETE FROM playlists WHERE title LIKE 'e2e%'",
    "UPDATE playlists SET import_count = 0",
  ])
  const statements: string[] = []
  for (let i = 0; i < 5; i += 1) {
    MAIN_IDS.push(
      seed(
        shareId(),
        {
          title: `e2edis main ${i}`,
          tags: ["e2edis"],
          firstPublishedAt: isoDaysAgo(20 - i),
        },
        statements,
      ),
    )
  }
  // The needle fixture proves q-search; hidden rows prove public-only.
  NEEDLE_ID = seed(
    shareId(),
    {
      title: "e2edis needle uniquephrase",
      tags: ["e2edis", "e2etagged"],
      firstPublishedAt: isoDaysAgo(30),
    },
    statements,
  )
  UNLISTED_ID = seed(
    shareId(),
    {
      title: "e2edis unlisted hidden",
      tags: ["e2edis", "e2ehidden"],
      visibility: "unlisted",
      firstPublishedAt: isoDaysAgo(2),
    },
    statements,
  )
  BLOCKED_ID = seed(
    shareId(),
    {
      title: "e2edis blocked hidden",
      tags: ["e2edis", "e2ehidden"],
      blocked: true,
      firstPublishedAt: isoDaysAgo(3),
    },
    statements,
  )
  PENDING_ID = seed(
    shareId(),
    {
      title: "e2edis pending hidden",
      tags: ["e2edis", "e2ehidden"],
      pending: true,
    },
    statements,
  )
  for (let i = 0; i < 5; i += 1) {
    PAGE_IDS.push(
      seed(
        shareId(),
        {
          title: `e2epage ${i}`,
          tags: ["e2epage"],
          firstPublishedAt: isoDaysAgo(10 - i),
        },
        statements,
      ),
    )
  }
  for (let i = 0; i < 5; i += 1) {
    EXP_IDS.push(
      seed(
        shareId(),
        {
          title: `e2eexp ${i}`,
          tags: ["e2eexp"],
          firstPublishedAt: isoDaysAgo(10 - i),
        },
        statements,
      ),
    )
  }
  d1Execute(statements)
})

test("phase 0 — no import events: popular degrades to new with no-imports", async ({
  request,
  page,
}) => {
  const { status, data } = await apiList(request, { sort: "popular", tag: "e2edis" })
  expect(status).toBe(200)
  expect(data.ranking).toMatchObject({
    mode: "new",
    effectiveWindow: "none",
    fallbackReason: "no-imports",
  })
  // Public-only: unlisted/blocked/pending fixtures never surface.
  const ids = data.items.map((item) => item.shareId)
  for (const hidden of [UNLISTED_ID, BLOCKED_ID, PENDING_ID]) {
    expect(ids).not.toContain(hidden)
  }
  const response = await page.goto(`${WEB_ORIGIN}/explore?sort=popular&tag=e2edis`)
  expect(response?.ok()).toBe(true)
  await expect(page.locator("[data-testid='explore-basis']")).toContainText("新着順")
  await expect(page.locator("[data-testid='explore-fallback']")).toContainText("保存の実績")
})

test("phase 1 — fewer than five positives: popular widens to lifetime", async ({ request }) => {
  const statements: string[] = []
  for (const id of MAIN_IDS.slice(0, 3)) {
    statements.push(
      `INSERT INTO import_daily (share_id, day, count) VALUES (${sqlString(id)}, ${sqlString(
        utcDay(1),
      )}, 1)`,
      `UPDATE playlists SET import_count = import_count + 1 WHERE share_id = ${sqlString(id)}`,
    )
  }
  // Lifetime-only positive: counter moves without any day bucket.
  statements.push(
    `UPDATE playlists SET import_count = import_count + 7 WHERE share_id = ${sqlString(MAIN_IDS[3] ?? "")}`,
  )
  d1Execute(statements)

  const { status, data } = await apiList(request, { sort: "popular", tag: "e2edis" })
  expect(status).toBe(200)
  expect(data.ranking).toMatchObject({
    mode: "popular",
    effectiveWindow: "lifetime",
    fallbackReason: "insufficient-recent-data",
  })
})

test("phase 2 — five positives inside 90d only: effectiveWindow 90d", async ({ request }) => {
  const statements: string[] = []
  for (const id of MAIN_IDS) {
    statements.push(
      `INSERT INTO import_daily (share_id, day, count) VALUES (${sqlString(id)}, ${sqlString(
        utcDay(45),
      )}, 1)`,
      `UPDATE playlists SET import_count = import_count + 1 WHERE share_id = ${sqlString(id)}`,
    )
  }
  d1Execute(statements)
  const { data } = await apiList(request, { sort: "popular", tag: "e2edis" })
  // 30d still has only 3 positives (< 5) -> widened to 90d.
  expect(data.ranking.effectiveWindow).toBe("90d")
  expect(data.ranking.fallbackReason).toBe("insufficient-recent-data")
})

test("phase 3 — five positives inside 30d: effectiveWindow 30d, no fallback", async ({
  request,
  page,
}) => {
  const statements: string[] = []
  for (const id of MAIN_IDS) {
    statements.push(
      `INSERT INTO import_daily (share_id, day, count) VALUES (${sqlString(id)}, ${sqlString(
        utcDay(0),
      )}, 2)`,
      `UPDATE playlists SET import_count = import_count + 2 WHERE share_id = ${sqlString(id)}`,
    )
  }
  d1Execute(statements)
  const { data } = await apiList(request, { sort: "popular", tag: "e2edis" })
  expect(data.ranking.effectiveWindow).toBe("30d")
  expect(data.ranking.fallbackReason).toBeUndefined()
  // Frozen score order inside the tagged subset: MAIN[0..2] carry 3 points
  // (phase-1 + phase-3 buckets), MAIN[3..4] carry 2, the needle carries 0 —
  // score desc, then first-publication desc, then shareId asc. The zero-score
  // needle still appears (the zero tail is listed, never hidden).
  const subset = data.items.map((item) => item.shareId)
  expect(subset).toEqual([
    MAIN_IDS[2],
    MAIN_IDS[1],
    MAIN_IDS[0],
    MAIN_IDS[4],
    MAIN_IDS[3],
    NEEDLE_ID,
  ])

  const response = await page.goto(`${WEB_ORIGIN}/explore?sort=popular&tag=e2edis`)
  expect(response?.ok()).toBe(true)
  await expect(page.locator("[data-testid='explore-basis']")).toContainText("30日")
  await expect(page.locator("[data-testid='explore-fallback']")).toHaveCount(0)
  await expect(page.locator("[data-testid='explore-item']")).toHaveCount(6)
})

test("search narrows results but never the global window; no-match is an honest empty", async ({
  request,
  page,
}) => {
  const hit = await apiList(request, { sort: "popular", q: "uniquephrase" })
  expect(hit.data.ranking.effectiveWindow).toBe("30d")
  expect(hit.data.items).toHaveLength(1)
  expect(hit.data.items[0]?.playlist.title).toContain("uniquephrase")

  const miss = await apiList(request, { sort: "popular", q: "zzznevermatches" })
  expect(miss.data.items).toEqual([])
  expect(miss.data.ranking.effectiveWindow).toBe("30d")

  const response = await page.goto(`${WEB_ORIGIN}/explore?q=zzznevermatches`)
  expect(response?.ok()).toBe(true)
  await expect(page.locator("[data-testid='explore-empty']")).toContainText("該当なし")
})

test("tag filter narrows results; no-match tag is an honest empty", async ({ request }) => {
  const hit = await apiList(request, { sort: "new", tag: "e2etagged" })
  expect(hit.data.items).toHaveLength(1)
  const miss = await apiList(request, { sort: "new", tag: "e2enosuchtag" })
  expect(miss.data.items).toEqual([])
})

test("frozen pagination: later publications/imports never enter an open cursor", async ({
  request,
}) => {
  const page1 = await apiList(request, { sort: "new", tag: "e2epage", limit: "2" })
  expect(page1.data.items).toHaveLength(2)
  const cursor = page1.data.nextCursor ?? ""
  expect(cursor).not.toBe("")
  // Page 1 = newest two (PAGE_IDS[4], PAGE_IDS[3]). Under the frozen snapshot:
  // publish a newcomer, import on the tail, block position 2, delete position 3.
  const statements: string[] = []
  seed(shareId(), { title: "e2epage latecomer", tags: ["e2epage"] }, statements)
  statements.push(
    `UPDATE playlists SET blocked = 1 WHERE share_id = ${sqlString(PAGE_IDS[2] ?? "")}`,
    `DELETE FROM playlists WHERE share_id = ${sqlString(PAGE_IDS[1] ?? "")}`,
  )
  d1Execute(statements)

  const page2 = await apiList(request, { sort: "new", tag: "e2epage", limit: "2", cursor })
  // Positions 2 (blocked) and 3 (deleted) were consumed but skipped; only
  // PAGE_IDS[0] remains visible — the latecomer is invisible mid-stream.
  expect(page2.data.items.map((item) => item.shareId)).toEqual([PAGE_IDS[0]])
  expect(page2.data.nextCursor).toBeUndefined()
})

test("expired snapshot cursor: API answers 410; /explore just renders live data", async ({
  request,
  page,
}) => {
  const page1 = await apiList(request, { sort: "new", tag: "e2eexp", limit: "2" })
  const cursor = page1.data.nextCursor ?? ""
  expect(cursor).not.toBe("")
  // Force the snapshot row past its 15-minute continuation window.
  const past = new Date(Date.now() - 60_000).toISOString()
  d1Execute([`UPDATE discovery_snapshots SET expires_at = ${sqlString(past)}`])

  // The signed-cursor contract still expires for API clients...
  const res = await request.get(
    `${WEB_ORIGIN}/api/v1/playlists?sort=new&tag=e2eexp&cursor=${encodeURIComponent(cursor)}`,
  )
  expect(res.status()).toBe(410)
  const body = (await res.json()) as { error: { code: string; message: string } }
  expect(body.error.code).toBe("CURSOR_EXPIRED")
  expect(body.error.message).toContain("restart")

  // ...but humans never see it: stale paging params are dropped and /explore
  // renders the live first page — expiry states do not exist for the page.
  const response = await page.goto(
    `${WEB_ORIGIN}/explore?sort=new&tag=e2eexp&cursor=${encodeURIComponent(cursor)}`,
  )
  expect(response?.status()).toBe(200)
  await expect(page.locator("[data-testid='explore-expired']")).toHaveCount(0)
  await expect(page.locator("[data-testid='explore-item']").first()).toBeVisible()
})

test("tampered, malformed and query-mismatched cursors answer 400", async ({ request }) => {
  const page1 = await apiList(request, { sort: "new", tag: "e2edis", limit: "2" })
  const cursor = page1.data.nextCursor ?? ""
  expect(cursor).not.toBe("")
  const [body] = cursor.split(".")

  for (const bad of [`${body}.AAAA`, "not-a-cursor", `${cursor}x`]) {
    const res = await request.get(
      `${WEB_ORIGIN}/api/v1/playlists?sort=new&tag=e2edis&cursor=${encodeURIComponent(bad)}`,
    )
    expect(res.status()).toBe(400)
  }
  // Same cursor under a different tag -> fingerprint mismatch -> 400.
  const mismatch = await request.get(
    `${WEB_ORIGIN}/api/v1/playlists?sort=new&tag=e2etagged&cursor=${encodeURIComponent(cursor)}`,
  )
  expect(mismatch.status()).toBe(400)

  const invalid = await request.get(`${WEB_ORIGIN}/api/v1/playlists?limit=999`)
  expect(invalid.status()).toBe(400)
  const pageRes = await request.get(`${WEB_ORIGIN}/explore?limit=999`)
  expect(pageRes.status()).toBe(400)
})

test(">1000 candidates materialize truncated and page exactly 1000 ids", async ({
  request,
  page,
}) => {
  test.setTimeout(300_000)
  const statements: string[] = []
  for (let i = 0; i < 1_005; i += 1) {
    seed(shareId(), { title: `e2ebulk ${i}` }, statements)
  }
  d1Execute(statements)

  const first = await apiList(request, { sort: "new", q: "e2ebulk", limit: "50" })
  expect(first.status).toBe(200)
  expect(first.data.truncated).toBe(true)
  const seen = new Set(first.data.items.map((item) => item.shareId))
  let cursor = first.data.nextCursor
  while (cursor !== undefined) {
    const next = await apiList(request, {
      sort: "new",
      q: "e2ebulk",
      limit: "50",
      cursor,
    })
    for (const item of next.data.items) seen.add(item.shareId)
    cursor = next.data.nextCursor
  }
  expect(seen.size).toBe(1_000)

  const response = await page.goto(`${WEB_ORIGIN}/explore?sort=new&q=e2ebulk`)
  expect(response?.ok()).toBe(true)
  await expect(page.locator("[data-testid='explore-truncated']")).toContainText("1,000件")
})

test("explore page: sort links, search form, chips and pager navigation", async ({ page }) => {
  const response = await page.goto(`${WEB_ORIGIN}/explore?sort=new&tag=e2edis`)
  expect(response?.ok()).toBe(true)
  const csp = response?.headers()["content-security-policy"] ?? ""
  expect(csp).toContain("script-src 'self'")
  expect(csp).not.toContain("unsafe-inline")

  await expect(page.locator("[data-testid='explore-sort-popular']")).toHaveAttribute(
    "href",
    /sort=popular/,
  )
  await expect(page.locator("[data-testid='explore-sort-new']")).toHaveAttribute("href", /sort=new/)
  await expect(page.locator("[data-testid='explore-item-link']").first()).toHaveAttribute(
    "href",
    /\/p\//,
  )
  // Counts are labeled as approximate import notifications, never people.
  await expect(page.locator("[data-testid='explore-item']").first()).toContainText("保存通知")
  expect(await page.content()).not.toContain("人のユーザー")
  // Tag chips reflect the public dictionary.
  await expect(
    page.locator("[data-testid='explore-tag-chip']").filter({ hasText: "e2edis" }),
  ).toBeVisible()

  // The search form GETs /explore with the filters.
  await page.locator("[data-testid='explore-q']").fill("needle")
  await page.locator("[data-testid='explore-submit']").click()
  await expect(page).toHaveURL(/q=needle/)
  await expect(page.locator("[data-testid='explore-item']")).toHaveCount(1)

  // Paged views carry noindex; the first page does not.
  const pager = await page.goto(`${WEB_ORIGIN}/explore?sort=new&tag=e2edis&limit=2`)
  expect(pager?.ok()).toBe(true)
  const next = page.locator("[data-testid='explore-next']")
  if ((await next.count()) > 0) {
    const href = (await next.getAttribute("href")) ?? ""
    const followed = await page.goto(`${WEB_ORIGIN}${href}`)
    expect(followed?.ok()).toBe(true)
    await expect(page.locator("meta[name='robots']")).toHaveAttribute("content", "noindex")
    await expect(page.locator("[data-testid='explore-restart']")).toBeVisible()
  }
})

test("tag dictionary endpoint counts eligible playlists only", async ({ request }) => {
  const res = await request.get(`${WEB_ORIGIN}/api/v1/playlists/tags`)
  expect(res.status()).toBe(200)
  expect(res.headers()["cache-control"]).toContain("no-store")
  const body = (await res.json()) as { data: { tags: { tag: string; count: number }[] } }
  const tags = body.data.tags
  const e2edis = tags.find((row) => row.tag === "e2edis")
  // Six public e2edis fixtures (5 mains + needle); hidden ones never counted.
  expect(e2edis?.count).toBe(6)
  expect(tags.find((row) => row.tag === "e2ehidden")).toBeUndefined()
})
