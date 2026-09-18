import { expect, test } from "@playwright/test"

const WEB_PORT = process.env["DOP_WEB_PORT"] ?? "4321"
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`
const SHELL_URL = `${WEB_ORIGIN}/`
const FIXTURE_URL = `${WEB_ORIGIN}/fixtures/shell`
const EVIDENCE_DIR = ".omo/evidence/task-4-d-op-v2-share"
const VIEWPORTS = [
  { width: 320, height: 900 },
  { width: 768, height: 900 },
  { width: 1440, height: 1000 },
] as const

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  const overflow: boolean = await page.evaluate((): boolean => {
    const root: HTMLElement = document.documentElement
    return root.scrollWidth > root.clientWidth + 1
  })
  expect(overflow).toBe(false)
}

test("shell home exposes skip link, landmarks and a unique h1", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error: Error) => {
    errors.push(error.message)
  })
  page.on("console", (entry) => {
    if (entry.type() === "error") {
      errors.push(entry.text())
    }
  })

  const response = await page.goto(SHELL_URL)
  expect(response?.ok()).toBe(true)

  await expect(page.locator("a[data-testid='skip-link']")).toHaveText("メインコンテンツへスキップ")
  await expect(page.locator("header[data-testid='site-header']")).toBeVisible()
  await expect(page.locator("main[data-testid='site-main']")).toBeVisible()
  await expect(page.locator("footer[data-testid='site-footer']")).toBeVisible()
  await expect(page.locator("nav[aria-label='サイト内メニュー']")).toBeVisible()
  await expect(page.locator("main h1")).toHaveCount(1)
  await expect(page.locator("main h1")).not.toBeEmpty()
  await expect(page.locator("a[data-testid='shell-fixture-link']")).toBeVisible()

  await expectNoHorizontalOverflow(page)
  expect(errors).toEqual([])
})

test("fixture states stay readable and operable without fake success", async ({ page }) => {
  const response = await page.goto(FIXTURE_URL)
  expect(response?.ok()).toBe(true)

  await expect(page.locator("[data-testid='fixture-loading']")).toContainText("読み込み中")
  await expect(page.locator("[data-testid='fixture-empty']")).toContainText("まだありません")
  await expect(page.locator("[data-testid='fixture-error']")).toContainText("読み込めませんでした")

  const longTitle: string =
    (await page.locator("[data-testid='fixture-long-title']").textContent()) ?? ""
  expect(longTitle.trim().length).toBeGreaterThan(40)

  const longDescription: string =
    (await page.locator("[data-testid='fixture-long-description']").textContent()) ?? ""
  expect(longDescription.trim().length).toBe(2000)

  await expect(page.locator("[data-testid='fixture-missing']")).toContainText("未登録")
  const disabledAction = page.locator("[data-testid='fixture-disabled-action']")
  await expect(disabledAction).toBeDisabled()
  await expect(disabledAction).toHaveAttribute("aria-disabled", "true")
  await expect(page.locator("[data-testid='fixture-dialog']")).toHaveAttribute(
    "aria-labelledby",
    /dialog-title-/,
  )

  await expectNoHorizontalOverflow(page)
})

test("keyboard tab order reaches the skip link first with visible focus", async ({ page }) => {
  await page.goto(SHELL_URL)

  await page.keyboard.press("Tab")
  const firstFocusedTestId: string | null = await page.evaluate((): string | null => {
    const active: Element | null = document.activeElement
    return active instanceof HTMLElement ? (active.getAttribute("data-testid") ?? null) : null
  })
  expect(firstFocusedTestId).toBe("skip-link")

  const focusRingVisible: boolean = await page.evaluate((): boolean => {
    const active: Element | null = document.activeElement
    if (!(active instanceof HTMLElement)) {
      return false
    }
    const outlineWidth: string = getComputedStyle(active).outlineWidth
    const outlineStyle: string = getComputedStyle(active).outlineStyle
    return outlineStyle !== "none" && outlineWidth !== "0px"
  })
  expect(focusRingVisible).toBe(true)

  await page.keyboard.press("Tab")
  const secondFocused: string = await page.evaluate((): string => {
    const active: Element | null = document.activeElement
    return active instanceof HTMLElement ? active.tagName : "NONE"
  })
  expect(secondFocused).not.toBe("BODY")
})

test("responsive shell never overflows at required viewport sizes", async ({ page }) => {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport)
    const response = await page.goto(SHELL_URL)
    expect(response?.ok()).toBe(true)
    await expect(page.locator("main h1")).toHaveCount(1)
    await expectNoHorizontalOverflow(page)
    await page.screenshot({
      path: `${EVIDENCE_DIR}/home-${viewport.width}x${viewport.height}.png`,
    })

    const fixtureResponse = await page.goto(FIXTURE_URL)
    expect(fixtureResponse?.ok()).toBe(true)
    await expectNoHorizontalOverflow(page)
    await page.screenshot({
      path: `${EVIDENCE_DIR}/fixture-${viewport.width}x${viewport.height}.png`,
      fullPage: true,
    })
  }
})

test("unknown route renders the accessible error shell", async ({ page }) => {
  const response = await page.goto(`${WEB_ORIGIN}/dop-missing-route-probe`)
  expect(response?.status()).toBe(404)
  await expect(page.locator("main h1")).toHaveCount(1)
  await expect(page.locator("[data-testid='error-notice']")).toContainText("見つかりませんでした")
  await expect(page.locator("a[data-testid='error-home-link']")).toBeVisible()
  await expectNoHorizontalOverflow(page)
})
