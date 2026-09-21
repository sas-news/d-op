import fs from "node:fs"
import path from "node:path"
import { AxeBuilder } from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { d1Execute, d1Migrate, hex64, isoNow, shareId, sqlString, WEB_ORIGIN } from "./d1"

// Task-24 web accessibility + visual-fidelity acceptance against the real
// built Worker preview (astro preview + platformProxy local D1). Runs on BOTH
// web-chromium and web-firefox via playwright.config.ts testMatch.
//
// Covers: axe-core scans of landing / privacy / explore / share / 404 states,
// the landing gallery keyboard contract (tab roles, arrows, lightbox focus
// trap + restore, Escape), reduced-motion auto-advance opt-out, horizontal
// overflow bounds at 320px, and screenshot evidence at 320/768/1440 plus a
// 200%-scale pass.
const EVIDENCE_DIR = path.resolve(".omo/evidence/task-24-d-op-v2-share")

const LONG_TITLE = "長いタイトル".repeat(20) // 120 chars — SHARE_TITLE_MAX
const ABSENT_ID = "B".repeat(22)

function seedSql(shareIdValue: string, out: string[]): string {
  const now = isoNow()
  const snapshot = {
    schemaVersion: 1,
    title: "アクセシビリティ検証リスト",
    description: "探索・共有ページの表示確認用",
    author: "検証者",
    tags: ["op", "検証"],
    visibility: "public",
    items: [
      {
        partId: "part_a11y_1",
        workId: "work_a11y_1",
        title: "作品タイトルがかなり長いアニメーション作品のサンプルです",
        episodeTitle: "第1話",
        episodeNumber: "1",
        range: { start: 0, end: 90_000, name: "OP" },
      },
      {
        partId: "part_a11y_2",
        workId: "work_a11y_1",
        title: "作品タイトルがかなり長いアニメーション作品のサンプルです",
        episodeTitle: "第1話",
        episodeNumber: "1",
        range: { start: 91_000, end: 180_000, name: "ED" },
      },
    ],
  }
  out.push(
    `INSERT INTO playlists (
      share_id, revision, state, secret_hash, snapshot_json, content_hash,
      title, description, author, search_text, visibility, tags_json, item_count,
      total_duration_ms, import_count, derived_from_share_id, derived_from_revision,
      blocked, created_at, first_published_at, updated_at, activation_expires_at)
    VALUES (${sqlString(shareIdValue)}, 2, 'active', ${sqlString(hex64())}, ${sqlString(
      JSON.stringify(snapshot),
    )}, ${sqlString(hex64())}, 'アクセシビリティ検証リスト', '探索・共有ページの表示確認用',
    '検証者', 'アクセシビリティ検証リスト 検証者', 'public', '["op","検証"]', 2,
    180000, 3, NULL, NULL, 0, ${sqlString(now)}, ${sqlString(now)}, ${sqlString(now)}, NULL)`,
  )
  return shareIdValue
}

function seedTags(shareIdValue: string, out: string[]): void {
  for (const tag of ["op", "検証"]) {
    out.push(
      `INSERT INTO tags (tag) VALUES (${sqlString(tag)}) ON CONFLICT (tag) DO NOTHING`,
      `INSERT INTO playlist_tags (share_id, tag_id)
       SELECT ${sqlString(shareIdValue)}, tag_id FROM tags WHERE tag = ${sqlString(tag)}`,
    )
  }
}

let publicId = ""

test.beforeAll(() => {
  // Cold wrangler starts can take several seconds each; widen the hook budget.
  test.setTimeout(120_000)
  d1Migrate()
  const statements: string[] = []
  publicId = seedSql(shareId(), statements)
  seedTags(publicId, statements)
  const longId = shareId()
  const now = isoNow()
  const longSnapshot = {
    schemaVersion: 1,
    title: LONG_TITLE,
    description: "説明".repeat(200),
    author: "あ".repeat(80),
    tags: [],
    visibility: "public",
    items: [
      {
        partId: "part_long",
        title: LONG_TITLE,
        episodeTitle: LONG_TITLE,
        range: { start: 0, end: 90_000, name: "OP" },
      },
    ],
  }
  statements.push(
    `INSERT INTO playlists (
      share_id, revision, state, secret_hash, snapshot_json, content_hash,
      title, description, author, search_text, visibility, tags_json, item_count,
      total_duration_ms, import_count, derived_from_share_id, derived_from_revision,
      blocked, created_at, first_published_at, updated_at, activation_expires_at)
    VALUES (${sqlString(longId)}, 2, 'active', ${sqlString(hex64())}, ${sqlString(
      JSON.stringify(longSnapshot),
    )}, ${sqlString(hex64())}, ${sqlString(LONG_TITLE)}, ${sqlString("説明".repeat(200))},
    ${sqlString("あ".repeat(80))}, '', 'public', '[]', 1, 90000, 0, NULL, NULL, 0,
    ${sqlString(now)}, ${sqlString(now)}, ${sqlString(now)}, NULL)`,
  )
  d1Execute(statements)
})

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]

async function expectAxeClean(page: Page, label: string): Promise<void> {
  const scan = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  expect(
    scan.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    `${label} axe violations`,
  ).toEqual([])
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow: boolean = await page.evaluate(
    `document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`,
  )
  expect(overflow).toBe(false)
}

function evidence(name: string): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  return path.join(EVIDENCE_DIR, name)
}

test("axe scans are clean on landing, privacy, explore, share and 404", async ({ page }) => {
  for (const [pathName, label] of [
    ["/", "landing"],
    ["/privacy", "privacy"],
    ["/explore", "explore"],
    [`/p/${publicId}`, "share page"],
    [`/p/${ABSENT_ID}`, "share 404"],
  ] as const) {
    const response = await page.goto(`${WEB_ORIGIN}${pathName}`)
    expect(response !== null && response.status() < 500, `${label} loads`).toBe(true)
    await page.waitForLoadState("domcontentloaded")
    await expectAxeClean(page, label)
  }
})

test("gallery tabs expose tab semantics and the lightbox traps + restores focus", async ({
  page,
}) => {
  const response = await page.goto(`${WEB_ORIGIN}/`)
  expect(response?.ok()).toBe(true)

  // Thumbnail strip: tablist > tab roles with aria-selected state.
  const thumbs = page.locator("[data-gallery-thumb]")
  await expect(thumbs).toHaveCount(3)
  await expect(thumbs.first()).toHaveAttribute("role", "tab")
  await expect(thumbs.first()).toHaveAttribute("aria-selected", "true")
  await expect(thumbs.nth(1)).toHaveAttribute("aria-selected", "false")

  // Arrow keys anywhere in the gallery switch slides + selection state.
  await thumbs.first().focus()
  await page.keyboard.press("ArrowRight")
  await expect(thumbs.nth(1)).toHaveAttribute("aria-selected", "true")
  await expect(page.locator("[data-slide][data-index='1']")).toHaveClass(/is-active/)

  // Lightbox: opens with dialog semantics, focus lands inside, Tab cycles.
  const trigger = page.locator("[data-lightbox-trigger][data-index='1']")
  await trigger.click()
  const lightbox = page.locator(".lightbox")
  await expect(lightbox).toBeVisible()
  await expect(lightbox).toHaveAttribute("role", "dialog")
  await expect(lightbox).toHaveAttribute("aria-modal", "true")
  await expect
    .poll(() =>
      page.evaluate(`document.querySelector(".lightbox").contains(document.activeElement)`),
    )
    .toBe(true)
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press("Tab")
    expect(
      await page.evaluate(`document.querySelector(".lightbox").contains(document.activeElement)`),
    ).toBe(true)
  }

  // Escape closes and focus returns to the trigger that opened it.
  await page.keyboard.press("Escape")
  await expect(page.locator(".lightbox")).toHaveCount(0)
  expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true)
})

test("prefers-reduced-motion disables the gallery auto-advance", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  const response = await page.goto(`${WEB_ORIGIN}/`)
  expect(response?.ok()).toBe(true)
  const activeIndex = (): Promise<number> =>
    page.evaluate(
      `Number(document.querySelector("[data-slide].is-active")?.getAttribute("data-index") ?? -1)`,
    )
  const before = await activeIndex()
  // GALLERY_INTERVAL_MS is 4000 — under reduce the interval is never armed.
  await page.waitForTimeout(4_400)
  expect(await activeIndex()).toBe(before)
})

test("public pages keep no horizontal overflow at 320px with long CJK metadata", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 })
  for (const pathName of ["/", "/explore", `/p/${publicId}`]) {
    const response = await page.goto(`${WEB_ORIGIN}${pathName}`)
    expect(response?.ok()).toBe(true)
    await expectNoHorizontalOverflow(page)
  }
})

test("visual evidence: landing/explore/share at 320, 768, 1440 and 200% scale", async ({
  page,
  browser,
}) => {
  const shots: [string, number][] = [
    ["/", 320],
    ["/", 1440],
    ["/explore", 320],
    ["/explore", 768],
    ["/explore", 1440],
    [`/p/${publicId}`, 320],
    [`/p/${publicId}`, 1440],
  ]
  for (const [pathName, width] of shots) {
    await page.setViewportSize({ width, height: 1000 })
    const response = await page.goto(`${WEB_ORIGIN}${pathName}`)
    expect(response?.ok()).toBe(true)
    await page.waitForLoadState("domcontentloaded")
    const slug = pathName === "/" ? "landing" : pathName.startsWith("/p/") ? "share" : "explore"
    await page.screenshot({ path: evidence(`${slug}-${width}.png`), fullPage: true })
  }

  // 200% zoom equivalent: a 2x device-scale context halves the CSS viewport.
  const zoomed = await browser.newContext({
    viewport: { width: 720, height: 900 },
    deviceScaleFactor: 2,
  })
  try {
    const zoomPage = await zoomed.newPage()
    for (const [pathName, slug] of [
      ["/", "landing"],
      ["/explore", "explore"],
      [`/p/${publicId}`, "share"],
    ] as const) {
      const response = await zoomPage.goto(`${WEB_ORIGIN}${pathName}`)
      expect(response?.ok()).toBe(true)
      await expectNoHorizontalOverflow(zoomPage)
      await zoomPage.screenshot({ path: evidence(`${slug}-zoom2x.png`), fullPage: true })
    }
  } finally {
    await zoomed.close()
  }
})
