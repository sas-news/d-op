import { execSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

// Task-16 public snapshot page (/p/:shareId) against the real built Worker
// preview (astro preview + platformProxy local D1). Runs on BOTH web-chromium
// and web-firefox via playwright.config.ts testMatch — do not edit that file.
//
// Seeding: direct local-D1 inserts via `wrangler d1 execute --local`, NOT the
// POST API — the create class is rate-limited at 5/min per actor and both
// browser projects share one preview + one actor, which would flake the suite.
// The page under test is a pure read of the same active rows the API serves,
// so a schema-valid seeded row is identical input.
//
// Covers: public render (8 clips, exact total duration, ranges, tags, author),
// canonical + branded text OGP, unlisted noindex + no-referrer, identical
// nonrevealing 404 for absent/pending/deleted/blocked/malformed, script-like
// metadata rendered inert, long Japanese metadata without horizontal
// overflow, save/install shell, copy + X affordances, CSP headers, and zero
// remote requests (offline-clean by construction).

const WEB_PORT = process.env["DOP_WEB_PORT"] ?? "4321"
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`
const WEB_CWD = join(__dirname, "..", "..", "apps", "web")
const PROD_ORIGIN = "https://d-op.sasnews.dev"

type SeedItem = {
  readonly partId: string
  readonly workId?: string
  readonly title: string
  readonly episodeTitle: string
  readonly episodeNumber?: string
  readonly range: { readonly start: number; readonly end: number; readonly name?: string }
}

type SeedPlaylist = {
  readonly title: string
  readonly description: string
  readonly author: string
  readonly tags: readonly string[]
  readonly visibility: "public" | "unlisted"
  readonly items: readonly SeedItem[]
  readonly blocked?: boolean
  readonly pending?: boolean
  readonly derivedFrom?: { readonly shareId: string; readonly revision: number }
}

const shareId = (): string => randomBytes(16).toString("base64url")
const hex64 = (): string => randomBytes(32).toString("hex")
const isoNow = (): string => new Date().toISOString()
const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`

function seedSql(shareIdValue: string, playlist: SeedPlaylist, out: string[]): string {
  const now = isoNow()
  const snapshot = {
    schemaVersion: 1,
    title: playlist.title,
    description: playlist.description,
    author: playlist.author,
    tags: playlist.tags,
    visibility: playlist.visibility,
    ...(playlist.derivedFrom === undefined ? {} : { derivedFrom: playlist.derivedFrom }),
    items: playlist.items,
  }
  const pending = playlist.pending === true
  const blocked = playlist.blocked === true
  const totalMs = playlist.items.reduce((t, i) => t + (i.range.end - i.range.start), 0)
  const expiresAt = pending ? new Date(Date.now() + 86_400_000).toISOString() : null
  const cols = `share_id, revision, state, secret_hash, snapshot_json, content_hash,
    title, description, author, search_text, visibility, tags_json, item_count,
    total_duration_ms, import_count, derived_from_share_id, derived_from_revision,
    blocked, created_at, first_published_at, updated_at, activation_expires_at`
  out.push(
    `INSERT INTO playlists (${cols}) VALUES (${sqlString(shareIdValue)}, ${
      pending ? 1 : 2
    }, '${pending ? "pending" : "active"}', ${sqlString(hex64())}, ${sqlString(
      JSON.stringify(snapshot),
    )}, ${sqlString(hex64())}, ${sqlString(playlist.title)}, ${sqlString(
      playlist.description,
    )}, ${sqlString(playlist.author)}, '', '${playlist.visibility}', ${sqlString(
      JSON.stringify(playlist.tags),
    )}, ${playlist.items.length}, ${totalMs}, 0, ${
      playlist.derivedFrom === undefined ? "NULL" : sqlString(playlist.derivedFrom.shareId)
    }, ${
      playlist.derivedFrom === undefined ? "NULL" : playlist.derivedFrom.revision
    }, ${blocked ? 1 : 0}, ${sqlString(now)}, ${
      pending ? "NULL" : sqlString(now)
    }, ${sqlString(now)}, ${expiresAt === null ? "NULL" : sqlString(expiresAt)})`,
  )
  return shareIdValue
}

function d1Execute(statements: readonly string[]): void {
  const dir = mkdtempSync(join(tmpdir(), "dop-share-seed-"))
  const file = join(dir, "seed.sql")
  writeFileSync(file, `${statements.join(";\n")};\n`, "utf8")
  execSync(`bunx wrangler d1 execute dop_share --local --file "${file}"`, {
    cwd: WEB_CWD,
    stdio: "pipe",
    env: { ...process.env, CI: "true" },
  })
}

// Parallel specs share one local-D1 file; concurrent wrangler processes can
// crash miniflare with a transient "internal error". Migrations are idempotent
// (wrangler tracks applied ids), so bounded retries are safe — unlike
// d1Execute, whose ON CONFLICT increments must never replay.
function d1Migrate(): void {
  const maxAttempts = 4
  for (let attempt = 0; ; attempt += 1) {
    try {
      execSync("bunx wrangler d1 migrations apply dop_share --local", {
        cwd: WEB_CWD,
        stdio: "pipe",
        env: { ...process.env, CI: "true" },
      })
      return
    } catch (error) {
      if (attempt + 1 >= maxAttempts) throw error
    }
  }
}

const item = (index: number, start: number, end: number, title = `作品${index}`): SeedItem => ({
  partId: `part_${index}`,
  workId: `work_${index}`,
  title,
  episodeTitle: `第${index + 1}話`,
  episodeNumber: `${index + 1}`,
  range: { start, end, name: "OP" },
})

const EIGHT_CLIPS: readonly SeedItem[] = [
  item(0, 0, 90_000),
  item(1, 10_000, 100_500),
  item(2, 0, 89_250),
  item(3, 5_000, 96_000),
  item(4, 0, 91_500),
  item(5, 12_000, 105_750),
  item(6, 0, 88_000),
  item(7, 7_500, 95_250),
]
// Exact sum(end-start) over the eight ranges above = 721750ms — "12分1.750秒".
const EIGHT_CLIP_TOTAL_LABEL = "12分1.750秒"

const LONG_TITLE = "長いタイトル".repeat(20) // 120 chars — SHARE_TITLE_MAX
const HOSTILE_TITLE = '<script>alert("xss")</script>'
const HOSTILE_AUTHOR = '<img src=x onerror="alert(1)">'

let publicId = ""
let unlistedId = ""
let longId = ""
let hostileId = ""
let pendingId = ""
let blockedId = ""
let deletedId = ""
const ABSENT_ID = "A".repeat(22)

test.beforeAll(() => {
  // Cold wrangler starts can take several seconds each; widen the hook budget.
  test.setTimeout(120_000)
  d1Migrate()
  const statements: string[] = []
  publicId = seedSql(
    shareId(),
    {
      title: "8クリップの共有リスト",
      description: "合計時間の正確な表示を検証するリスト",
      author: "検証者",
      tags: ["op", "検証"],
      visibility: "public",
      items: EIGHT_CLIPS,
    },
    statements,
  )
  unlistedId = seedSql(
    shareId(),
    {
      title: "限定公開リスト",
      description: "リンクを知っている人だけ",
      author: "検証者",
      tags: ["unlisted"],
      visibility: "unlisted",
      items: EIGHT_CLIPS.slice(0, 2),
    },
    statements,
  )
  longId = seedSql(
    shareId(),
    {
      title: LONG_TITLE,
      description: "説明".repeat(200),
      author: "あ".repeat(80),
      tags: ["たぐ".repeat(12).slice(0, 24)],
      visibility: "public",
      items: EIGHT_CLIPS.slice(0, 3),
    },
    statements,
  )
  hostileId = seedSql(
    shareId(),
    {
      title: HOSTILE_TITLE,
      description: '"><svg onload=alert(1)>',
      author: HOSTILE_AUTHOR,
      tags: ["<b>tag</b>"],
      visibility: "public",
      items: [
        {
          partId: "part_hostile",
          title: "<script>alert(1)</script>",
          episodeTitle: "<img src=x>",
          range: { start: 0, end: 90_000, name: "<svg>" },
        },
      ],
    },
    statements,
  )
  pendingId = seedSql(
    shareId(),
    {
      title: "未公開リスト",
      description: "",
      author: "検証者",
      tags: [],
      visibility: "public",
      items: EIGHT_CLIPS.slice(0, 1),
      pending: true,
    },
    statements,
  )
  blockedId = seedSql(
    shareId(),
    {
      title: "ブロック済みリスト",
      description: "",
      author: "検証者",
      tags: [],
      visibility: "public",
      items: EIGHT_CLIPS.slice(0, 1),
      blocked: true,
    },
    statements,
  )
  deletedId = seedSql(
    shareId(),
    {
      title: "削除されるリスト",
      description: "",
      author: "検証者",
      tags: [],
      visibility: "public",
      items: EIGHT_CLIPS.slice(0, 1),
    },
    statements,
  )
  // removed/deleted state: hard delete inside the same seed file — the row
  // exists and is gone before the suite starts (identical to the API path).
  statements.push(`DELETE FROM playlists WHERE share_id = ${sqlString(deletedId)}`)
  d1Execute(statements)
})

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  const overflow: boolean = await page.evaluate((): boolean => {
    const root: HTMLElement = document.documentElement
    return root.scrollWidth > root.clientWidth + 1
  })
  expect(overflow).toBe(false)
}

function trackExternalRequests(page: import("@playwright/test").Page): string[] {
  const external: string[] = []
  page.on("request", (request) => {
    const url = request.url()
    if (!url.startsWith(WEB_ORIGIN) && !url.startsWith("data:") && !url.startsWith("about:")) {
      external.push(url)
    }
  })
  return external
}

test("public share page renders metadata, 8 clips and exact total duration", async ({ page }) => {
  const external = trackExternalRequests(page)
  const response = await page.goto(`${WEB_ORIGIN}/p/${publicId}`)
  expect(response?.ok()).toBe(true)

  await expect(page.locator("[data-testid='share-title']")).toHaveText("8クリップの共有リスト")
  await expect(page.locator("[data-testid='share-author']")).toContainText("検証者")
  await expect(page.locator("[data-testid='share-description']")).toContainText("合計時間")
  await expect(page.locator("[data-testid='share-visibility']")).toContainText("公開プレイリスト")
  await expect(page.locator("[data-testid='share-clip-count']")).toHaveText("8")
  await expect(page.locator("[data-testid='share-total-duration']")).toHaveText(
    EIGHT_CLIP_TOTAL_LABEL,
  )
  await expect(page.locator("[data-testid='share-item']")).toHaveCount(8)
  await expect(page.locator("[data-testid='share-item']").nth(1)).toContainText("0:10")
  await expect(page.locator("[data-testid='share-item']").nth(1)).toContainText("1:40.500")
  await expect(page.locator("[data-testid='share-tags'] .share-tag")).toHaveCount(2)

  // Canonical + OGP head metadata (escaped attribute reads, not raw HTML).
  await expect(page.locator("link[rel='canonical']")).toHaveAttribute(
    "href",
    `${PROD_ORIGIN}/p/${publicId}`,
  )
  await expect(page.locator("meta[property='og:url']")).toHaveAttribute(
    "content",
    `${PROD_ORIGIN}/p/${publicId}`,
  )
  await expect(page.locator("meta[property='og:type']")).toHaveAttribute("content", "website")
  await expect(page.locator("meta[property='og:title']")).toHaveAttribute(
    "content",
    "8クリップの共有リスト",
  )
  const ogDescription =
    (await page.locator("meta[property='og:description']").getAttribute("content")) ?? ""
  expect(ogDescription).toContain("8クリップ")
  expect(ogDescription).toContain(EIGHT_CLIP_TOTAL_LABEL)
  await expect(page.locator("meta[property='og:image']")).toHaveAttribute(
    "content",
    `${PROD_ORIGIN}/og-share.svg`,
  )

  // The page must not be a noindex target and must carry no secrets.
  expect(await page.locator("meta[name='robots']").count()).toBe(0)
  const html = await page.content()
  expect(html).not.toContain("manageSecret")
  expect(html).not.toContain("secret_hash")

  // Fully rendered without remote requests — no artwork/metadata fetches.
  expect(external).toEqual([])
  await expectNoHorizontalOverflow(page)
})

test("public page serves the strict security headers", async ({ page }) => {
  const response = await page.goto(`${WEB_ORIGIN}/p/${publicId}`)
  const csp = response?.headers()["content-security-policy"] ?? ""
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain("style-src 'self'")
  expect(csp).not.toContain("unsafe-inline")
  expect(csp).not.toContain("unsafe-eval")
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer")
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff")
})

test("unlisted page renders with noindex and no-referrer", async ({ page }) => {
  const response = await page.goto(`${WEB_ORIGIN}/p/${unlistedId}`)
  expect(response?.ok()).toBe(true)
  await expect(page.locator("[data-testid='share-title']")).toHaveText("限定公開リスト")
  await expect(page.locator("[data-testid='share-visibility']")).toContainText("限定公開")
  await expect(page.locator("meta[name='robots']")).toHaveAttribute("content", "noindex")
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer")
  // Canonical stays correct even though indexing is refused.
  await expect(page.locator("link[rel='canonical']")).toHaveAttribute(
    "href",
    `${PROD_ORIGIN}/p/${unlistedId}`,
  )
})

test("copy button copies or degrades visibly; X intent link is correct", async ({ page }) => {
  await page.goto(`${WEB_ORIGIN}/p/${publicId}`)

  const xLink = page.locator("[data-testid='share-x-link']")
  const xHref = (await xLink.getAttribute("href")) ?? ""
  expect(xHref).toContain("https://x.com/intent/post")
  expect(xHref).toContain(encodeURIComponent(`${PROD_ORIGIN}/p/${publicId}`))
  await expect(xLink).toHaveAttribute("target", "_blank")
  await expect(xLink).toHaveAttribute("rel", /noopener/)

  await page.locator("[data-testid='copy-url-button']").click()
  // Either the clipboard write succeeded or the fallback message shows the URL —
  // the action must never be silent-dead.
  const status = page.locator("[data-testid='copy-status']")
  await expect(status).not.toBeEmpty()
  const statusText = (await status.textContent()) ?? ""
  expect(statusText === "URLをコピーしました。" || statusText.includes(`${PROD_ORIGIN}/p/`)).toBe(
    true,
  )
})

test("save/install shell offers a safe disabled state plus store links", async ({ page }) => {
  await page.goto(`${WEB_ORIGIN}/p/${publicId}`)
  const panel = page.locator("[data-testid='save-panel']")
  await expect(panel).toBeVisible()
  const openButton = page.locator("[data-testid='save-open-button']")
  await expect(openButton).toBeDisabled()
  await expect(openButton).toHaveAttribute("aria-disabled", "true")
  await expect(page.locator("[data-testid='save-status']")).toContainText("拡張機能")
  await expect(page.locator("[data-testid='save-chrome-link']")).toHaveAttribute(
    "href",
    /chromewebstore\.google\.com/,
  )
  await expect(page.locator("[data-testid='save-firefox-link']")).toHaveAttribute(
    "href",
    /addons\.mozilla\.org/,
  )
})

test("long Japanese metadata wraps without horizontal overflow", async ({ page }) => {
  const response = await page.goto(`${WEB_ORIGIN}/p/${longId}`)
  expect(response?.ok()).toBe(true)
  await expect(page.locator("[data-testid='share-title']")).toHaveText(LONG_TITLE)
  await expect(page.locator("[data-testid='share-author']")).toContainText("あ")
  await expectNoHorizontalOverflow(page)
})

test("script-like metadata renders as inert escaped text", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error: Error) => pageErrors.push(error.message))
  const dialogs: string[] = []
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })

  const response = await page.goto(`${WEB_ORIGIN}/p/${hostileId}`)
  expect(response?.ok()).toBe(true)
  await expect(page.locator("[data-testid='share-title']")).toHaveText(HOSTILE_TITLE)
  await expect(page.locator("[data-testid='share-author']")).toContainText(HOSTILE_AUTHOR)
  await expect(page.locator("[data-testid='share-item']")).toContainText(
    "<script>alert(1)</script>",
  )
  // Only the same-origin enhancement script may exist — never author markup.
  await expect(page.locator("script")).toHaveCount(1)
  await expect(page.locator("script")).toHaveAttribute("src", "/share-page.js")
  expect(dialogs).toEqual([])
  expect(pageErrors).toEqual([])
})

test.describe("nonrevealing 404", () => {
  const NOT_FOUND_CASES: ReadonlyArray<{ name: string; id: () => string }> = [
    { name: "absent", id: () => ABSENT_ID },
    { name: "pending", id: () => pendingId },
    { name: "blocked", id: () => blockedId },
    { name: "deleted", id: () => deletedId },
    { name: "malformed", id: () => "not-a-share-id" },
  ]

  for (const { name, id } of NOT_FOUND_CASES) {
    test(`${name} id renders the identical 404 view`, async ({ page }) => {
      const response = await page.goto(`${WEB_ORIGIN}/p/${id()}`)
      expect(response?.status()).toBe(404)
      await expect(page.locator("[data-testid='error-notice']")).toContainText(
        "共有プレイリストが見つかりません",
      )
      await expect(page.locator("meta[name='robots']")).toHaveAttribute("content", "noindex")
    })
  }

  test("absent and pending bodies are byte-identical", async ({ request }) => {
    const a = await (await request.get(`${WEB_ORIGIN}/p/${ABSENT_ID}`)).text()
    const b = await (await request.get(`${WEB_ORIGIN}/p/${pendingId}`)).text()
    expect(a).toBe(b)
  })
})
