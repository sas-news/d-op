import { expect, test } from "@playwright/test"

// Task-14 CSP verification against the real built Worker preview (web-chromium
// only — see playwright.config.ts testMatch). Asserts the strict policy header
// on the SSR shell, that an injected external script is refused by the policy,
// and that HTML-shaped playlist metadata renders as inert text.

const WEB_PORT = process.env["DOP_WEB_PORT"] ?? "4321"
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`
const SHELL_URL = `${WEB_ORIGIN}/`
const FIXTURE_URL = `${WEB_ORIGIN}/fixtures/shell`
const EVIL_SCRIPT_URL = "https://attacker.example/dop-evil.js"

test("SSR shell serves the strict CSP header", async ({ page }) => {
  const response = await page.goto(SHELL_URL)
  expect(response?.ok()).toBe(true)
  const csp = response?.headers()["content-security-policy"] ?? ""
  expect(csp).not.toBe("")
  for (const directive of [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ]) {
    expect(csp).toContain(directive)
  }
  expect(csp).not.toContain("unsafe-eval")
  expect(csp).not.toContain("unsafe-inline")
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer")
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff")
})

test("CSP refuses an injected external script", async ({ page }) => {
  // Serve attacker JS that would set a marker if it ever executed.
  await page.route(EVIL_SCRIPT_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "globalThis.__dopCspBreach = true;",
    })
  })
  const consoleErrors: string[] = []
  page.on("console", (entry) => {
    if (entry.type() === "error") consoleErrors.push(entry.text())
  })

  const response = await page.goto(SHELL_URL)
  expect(response?.ok()).toBe(true)

  await page.evaluate((url: string): void => {
    const script = document.createElement("script")
    script.src = url
    document.body.appendChild(script)
  }, EVIL_SCRIPT_URL)
  // Give the network stack a beat: if CSP were absent the route would fulfill.
  await page.waitForTimeout(500)

  const breached: boolean = await page.evaluate(
    (): boolean => (globalThis as { __dopCspBreach?: boolean }).__dopCspBreach === true,
  )
  expect(breached).toBe(false)
  expect(
    consoleErrors.some(
      (text) => text.includes("Content Security Policy") || text.includes("Refused to load"),
    ),
  ).toBe(true)
})

test("playlist metadata containing markup renders as text, never elements", async ({ page }) => {
  const response = await page.goto(FIXTURE_URL)
  expect(response?.ok()).toBe(true)

  // The fixture copy embeds an escaped <script> literal: it must surface as
  // visible text inside a <code> element, not as a parsed script node.
  const rendered: { text: string | null; tag: string | null } = await page.evaluate(() => {
    const code = Array.from(document.querySelectorAll("code")).find((node) =>
      node.textContent?.includes("<script>"),
    )
    return { text: code?.textContent ?? null, tag: code?.tagName ?? null }
  })
  expect(rendered.tag).toBe("CODE")
  expect(rendered.text).toContain('<script>alert("inert")</script>')

  // No script element ever carries that payload.
  const scriptCount: number = await page.evaluate(
    (): number =>
      Array.from(document.querySelectorAll("script")).filter((node) =>
        node.textContent?.includes("inert"),
      ).length,
  )
  expect(scriptCount).toBe(0)
})
