import { expect, test } from "@playwright/test"

// Task-5 harness: proves a real launched browser loads the synthetic
// test-only fixture origin and asserts deterministic DOM + network behavior.
// The fixture server is started by playwright.config.ts webServer; no
// production or external origin may appear in this spec.
const FIXTURE_ORIGIN = "http://127.0.0.1:8123"

type FixturePayload = {
  readonly status: string
  readonly value: number
}

function isFixturePayload(payload: unknown): payload is FixturePayload {
  if (typeof payload !== "object" || payload === null) {
    return false
  }
  const record = payload as { readonly status?: unknown; readonly value?: unknown }
  return record.status === "ok" && record.value === 42
}

test("harness fixture loads in a real browser with deterministic DOM and network", async ({
  page,
  request,
}) => {
  const seen: string[] = []
  page.on("request", (entry) => {
    seen.push(entry.url())
  })

  const response = await page.goto(`${FIXTURE_ORIGIN}/harness.html`)
  expect(response?.ok()).toBe(true)

  await expect(page.locator("[data-testid='harness-title']")).toHaveText("d-OP task-5 harness")
  await expect(page.locator("[data-testid='harness-status']")).toHaveText("fixture:ok")

  const api = await request.get(`${FIXTURE_ORIGIN}/api/fixture`)
  expect(api.ok()).toBe(true)
  const payload: unknown = await api.json()
  expect(isFixturePayload(payload)).toBe(true)
  if (isFixturePayload(payload)) {
    expect(payload.value).toBe(42)
  }

  expect(seen.length).toBeGreaterThan(0)
  for (const url of seen) {
    expect(url.startsWith(FIXTURE_ORIGIN)).toBe(true)
  }

  await page.screenshot({ path: test.info().outputPath("harness.png") })
})
