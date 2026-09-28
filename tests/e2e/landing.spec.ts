import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

// Task-21 landing/port verification against the real built Worker preview
// (astro preview + platformProxy). Runs on BOTH web-chromium and web-firefox
// via playwright.config.ts testMatch — do not edit that file.
//
// Covers: official CWS/AMO/support/developer links, root/privacy/explore/share
// navigation, legacy section anchors (#top/#gallery/#download/#support/
// #developer/#privacy/#share), canonical + OGP + JSON-LD metadata with the
// current product version, a same-origin asset-404 audit that crawls every
// local href/src on the public pages, gallery carousel/lightbox interaction,
// and zero remote requests (offline-clean by construction).

const WEB_PORT = process.env["DOP_WEB_PORT"] ?? "4321"
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`
const PROD_ORIGIN = "https://d-op.sasnews.dev"

// JSON-LD softwareVersion mirrors apps/web/package.json via SITE_VERSION.
const WEB_PKG_VERSION = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "apps", "web", "package.json"), "utf8"),
).version as string

const CWS_URL = "https://chromewebstore.google.com/detail/d-op/mcjkaoagedekadnimbcbkhdkgpbnnodc"
const AMO_URL = "https://addons.mozilla.org/ja/firefox/addon/d-op/"

const PUBLIC_PAGES = ["/", "/privacy", "/explore"] as const

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  const overflow: boolean = await page.evaluate((): boolean => {
    const root: HTMLElement = document.documentElement
    return root.scrollWidth > root.clientWidth + 1
  })
  expect(overflow).toBe(false)
}

test("landing exposes official store, support and developer links", async ({ page }) => {
  const response = await page.goto(`${WEB_ORIGIN}/`)
  expect(response?.ok()).toBe(true)

  await expect(page.locator("[data-testid='chrome-store-link']")).toHaveAttribute("href", CWS_URL)
  await expect(page.locator("[data-testid='firefox-store-link']")).toHaveAttribute("href", AMO_URL)

  await expect(page.locator("[data-testid='support-marshmallow-link']")).toHaveAttribute(
    "href",
    "https://marshmallow-qa.com/blp4p7r8sz8lt2a",
  )
  await expect(page.locator("[data-testid='support-issues-link']")).toHaveAttribute(
    "href",
    "https://github.com/sas-news/d-op/issues",
  )
  await expect(page.locator("[data-testid='support-mail-link']")).toHaveAttribute(
    "href",
    "mailto:contact@sasnews.dev",
  )
  await expect(page.locator("[data-testid='dev-x-link']")).toHaveAttribute(
    "href",
    "https://x.com/i/user/1666355162167021568",
  )
  await expect(page.locator("[data-testid='dev-site-link']")).toHaveAttribute(
    "href",
    "https://sasnews.dev",
  )
})

test("root/privacy/explore/share navigation resolves on header and footer", async ({
  page,
  request,
}) => {
  const response = await page.goto(`${WEB_ORIGIN}/`)
  expect(response?.ok()).toBe(true)

  const nav = page.locator("header nav")
  await expect(nav.locator("a[href='/#gallery']")).toBeVisible()
  await expect(nav.locator("a[href='/#download']")).toBeVisible()
  await expect(nav.locator("a[href='/#support']")).toBeVisible()
  await expect(nav.locator("a[href='/explore']")).toBeVisible()
  await expect(nav.locator("a[href='/privacy']")).toBeVisible()
  await expect(page.locator(".brand")).toHaveAttribute("href", "/")

  const footer = page.locator("footer[data-testid='site-footer']")
  await expect(footer.locator("a[href='/']")).toBeVisible()
  await expect(footer.locator("a[href='/explore']")).toBeVisible()
  await expect(footer.locator("a[href='/privacy']")).toBeVisible()
  await expect(footer.locator("a[href='/#share']")).toBeVisible()
  await expect(footer.locator("a[href='https://github.com/sas-news/d-op']")).toBeVisible()

  const privacyResponse = await page.goto(`${WEB_ORIGIN}/privacy`)
  expect(privacyResponse?.ok()).toBe(true)
  await expect(page.locator("main h1")).toHaveText("プライバシーポリシー")
  await expect(page.locator("main")).toContainText("お問い合わせ窓口")

  const exploreResponse = await page.goto(`${WEB_ORIGIN}/explore`)
  expect(exploreResponse?.ok()).toBe(true)
  await expect(page.locator("main h1")).toHaveText("共有プレイリストを探す")
  // The explore page renders either the results list or the honest empty state.
  await expect(
    page.locator("[data-testid='explore-list'], [data-testid='explore-empty']").first(),
  ).toBeVisible()

  // Legacy footer linked the raw /PRIVACY.md file — it must not 404.
  const legacyPrivacy = await request.get(`${WEB_ORIGIN}/PRIVACY.md`, {
    maxRedirects: 0,
  })
  expect(legacyPrivacy.status()).toBe(301)
  expect(legacyPrivacy.headers()["location"]).toBe("/privacy")
})

test("legacy section anchors survive on the landing page", async ({ page }) => {
  const response = await page.goto(`${WEB_ORIGIN}/`)
  expect(response?.ok()).toBe(true)
  for (const anchor of [
    "#top",
    "#gallery",
    "#download",
    "#support",
    "#developer",
    "#privacy",
    "#share",
  ]) {
    await expect(page.locator(anchor)).toHaveCount(1)
  }
})

test("canonical, OGP and JSON-LD reflect the current product truth", async ({ page }) => {
  const response = await page.goto(`${WEB_ORIGIN}/`)
  expect(response?.ok()).toBe(true)

  await expect(page.locator("link[rel='canonical']")).toHaveAttribute("href", `${PROD_ORIGIN}/`)
  await expect(page.locator("meta[property='og:url']")).toHaveAttribute(
    "content",
    `${PROD_ORIGIN}/`,
  )
  await expect(page.locator("meta[property='og:image']")).toHaveAttribute(
    "content",
    `${PROD_ORIGIN}/assets/ogp.png`,
  )
  await expect(page.locator("meta[name='twitter:card']")).toHaveAttribute(
    "content",
    "summary_large_image",
  )

  const jsonLd = page.locator("script[type='application/ld+json']")
  await expect(jsonLd).toHaveCount(1)
  const parsed: unknown = JSON.parse((await jsonLd.textContent()) ?? "")
  expect(parsed).toMatchObject({
    "@type": "SoftwareApplication",
    name: "d-OP",
    url: `${PROD_ORIGIN}/`,
    downloadUrl: CWS_URL,
    softwareVersion: WEB_PKG_VERSION,
  })

  const xHref = (await page.locator("[data-testid='share-x-link']").getAttribute("href")) ?? ""
  expect(xHref).toContain("https://x.com/intent/post")
  expect(xHref).toContain(encodeURIComponent(`${PROD_ORIGIN}/`))
})

test("gallery slides switch and the lightbox opens and closes", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error: Error) => pageErrors.push(error.message))

  const response = await page.goto(`${WEB_ORIGIN}/`)
  expect(response?.ok()).toBe(true)

  await expect(page.locator("[data-slide]")).toHaveCount(3)
  await expect(page.locator("[data-slide].is-active")).toHaveCount(1)

  await page.locator("[data-gallery-thumb][data-index='1']").click()
  await expect(page.locator("[data-slide][data-index='1']")).toHaveClass(/is-active/)

  await page.locator("[data-lightbox-trigger][data-index='1']").click()
  const lightbox = page.locator(".lightbox")
  await expect(lightbox).toBeVisible()
  await expect(lightbox.locator(".lightbox-counter")).toHaveText("2 / 3")
  await expect(lightbox.locator(".lightbox-img")).toHaveAttribute(
    "src",
    /\/assets\/store-image2\.png$/,
  )

  await lightbox.locator(".lightbox-next").click()
  await expect(lightbox.locator(".lightbox-counter")).toHaveText("3 / 3")

  await page.keyboard.press("Escape")
  await expect(page.locator(".lightbox")).toHaveCount(0)
  expect(pageErrors).toEqual([])
})

test("every local href and src on public pages resolves without a 404", async ({
  page,
  request,
}) => {
  const localRefs = new Set<string>()
  for (const path of PUBLIC_PAGES) {
    const response = await page.goto(`${WEB_ORIGIN}${path}`)
    expect(response?.ok()).toBe(true)
    const refs: string[] = await page.evaluate((): string[] =>
      Array.from(document.querySelectorAll("[href], [src]"))
        .map((el) => el.getAttribute("href") ?? el.getAttribute("src") ?? "")
        .filter((value) => value !== ""),
    )
    for (const ref of refs) {
      const url = new URL(ref, WEB_ORIGIN)
      if (url.origin === WEB_ORIGIN) {
        localRefs.add(`${url.pathname}${url.search}`)
      }
    }
  }
  expect(localRefs.size).toBeGreaterThan(0)

  const failures: string[] = []
  for (const ref of localRefs) {
    const response = await request.get(`${WEB_ORIGIN}${ref}`)
    if (!response.ok()) failures.push(`${ref} -> ${response.status()}`)
  }
  expect(failures).toEqual([])
})

test("public pages stay responsive and remote-request free", async ({ page }) => {
  const external: string[] = []
  page.on("request", (request) => {
    const url = request.url()
    if (!url.startsWith(WEB_ORIGIN) && !url.startsWith("data:") && !url.startsWith("about:")) {
      external.push(url)
    }
  })
  const pageErrors: string[] = []
  page.on("pageerror", (error: Error) => pageErrors.push(error.message))

  for (const viewport of [
    { width: 320, height: 900 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(viewport)
    const response = await page.goto(`${WEB_ORIGIN}/`)
    expect(response?.ok()).toBe(true)
    await expectNoHorizontalOverflow(page)
    const privacyResponse = await page.goto(`${WEB_ORIGIN}/privacy`)
    expect(privacyResponse?.ok()).toBe(true)
    await expectNoHorizontalOverflow(page)
  }

  expect(external).toEqual([])
  expect(pageErrors).toEqual([])
})
