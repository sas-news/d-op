import path from "node:path"
import {
  type BrowserContext,
  chromium,
  expect,
  type Route,
  type TestInfo,
  test,
  type Worker,
} from "@playwright/test"
import { browserLaunchTarget } from "./browser-target"

// Tag-suggestion acceptance against the real unpacked WXT build (chrome-mv3).
// The dialog's タグ候補を取得 button goes through the background service worker
// to POST /api/v1/tag-suggestions — here served by a route-mock (registered
// AFTER the catch-all abort so it wins, same convention as
// extension-share-management.spec.ts). Asserts the whitelisted {works} body,
// the canonical merged fill, the unmatched line, and that an upstream failure
// degrades to a non-fatal note while publish still works.
const EXTENSION_PATH = path.resolve("apps/extension/.output/chrome-mv3")
const NOW = "2026-09-20T00:00:00.000Z"

test.setTimeout(90_000)

type SeedItem = {
  id: string
  partId: string
  workId?: string
  title: string
  episodeTitle: string
  url: string
  range: { start: number; end: number; name?: string } | null
}

function item(id: string, partId: string, workId?: string, rangeName?: string): SeedItem {
  return {
    id,
    partId,
    ...(workId === undefined ? {} : { workId }),
    title: "Fixture Work",
    episodeTitle: `第${id}話`,
    url: `https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=${partId}`,
    range: { start: 0, end: 90_000, ...(rangeName === undefined ? {} : { name: rangeName }) },
  }
}

function v2State(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    revision: 0,
    playlists: [
      {
        id: "pl-1",
        name: "E2E Tag OP集",
        items: [
          item("a", "p1", "work-a", "My OP (LiSA)"),
          item("b", "p2", "work-a", "My OP (LiSA)"),
          item("c", "p3", undefined, "OP (Aimer)"),
        ],
      },
    ],
    publications: [],
    pendingCreates: [],
    preferences: { windowMode: "tab", collapsedPlaylists: {} },
    appliedOperations: [],
    shareConsent: { choice: "granted", decidedAt: NOW },
  }
}

type SuggestCall = { body: Record<string, unknown> }

function handleSuggestApi(route: Route, calls: SuggestCall[], mode: "ok" | "down"): Promise<void> {
  const request = route.request()
  calls.push({ body: JSON.parse(request.postData() ?? "{}") as Record<string, unknown> })
  if (mode === "down") {
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "e2e", requestId: "r" } }),
    })
  }
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: {
        tags: ["2006年", "少年"],
        unmatched: ["Missing Work"],
        perWork: [
          { title: "Fixture Work", matched: true, tags: ["2006年", "少年"] },
          { title: "Missing Work", matched: false, tags: [] },
        ],
      },
    }),
  })
}

async function launchExtension(
  testInfo: TestInfo,
  mode: "ok" | "down",
): Promise<{ context: BrowserContext; worker: Worker; extensionId: string; calls: SuggestCall[] }> {
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    ...browserLaunchTarget(),
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  })
  const calls: SuggestCall[] = []
  await context.route(/^https?:\/\//, (route) => route.abort())
  await context.route(/\/api\/v1\/tag-suggestions$/, (route) =>
    handleSuggestApi(route, calls, mode),
  )
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 10_000 }))
  await worker.evaluate(`(async () => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set({ dop_v2_state: ${JSON.stringify(v2State())} })
  })()`)
  const extensionId = new URL(worker.url()).hostname
  return { context, worker, extensionId, calls }
}

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("tag suggestions: 候補 button posts {works} and merges api + local + typed tags", async ({}, testInfo) => {
  const { context, extensionId, calls } = await launchExtension(testInfo, "ok")
  try {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/options.html`)
    await expect(page.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })

    await page.locator(".playlist-card .share-open").click()
    const dialog = page.locator("#d-op-modal")
    await expect(dialog.locator(".share-dialog")).toBeVisible()

    // Type one tag first — the merge must keep user-typed tags.
    const tagsInput = dialog.locator(".share-tags")
    await tagsInput.fill("マイタグ")

    await dialog.locator(".share-tags-suggest").click()

    // {works} body: deduped by workId ?? title, titles + workIds only.
    await expect(() => expect(calls).toHaveLength(1)).toPass({ timeout: 15_000 })
    expect(calls[0]?.body).toEqual({
      works: [{ title: "Fixture Work", workId: "work-a" }, { title: "Fixture Work" }],
    })

    // Candidates render as pick-one chips (api + local: kind "op" from the
    // OP title, artists "LiSA"/"Aimer" from range.name parens) — the typed
    // tag is NOT clobbered and nothing is auto-filled.
    await expect(dialog.locator(".share-tag-chip")).toHaveCount(5, { timeout: 15_000 })
    await expect(tagsInput).toHaveValue("マイタグ")

    // Picking a chip union-merges just that tag (folded + sorted).
    await dialog.locator(".share-tag-chip", { hasText: "aimer" }).click()
    await expect(tagsInput).toHaveValue("aimer マイタグ")
    await expect(dialog.locator(".share-tag-chip.added")).toHaveText("aimer")
    await expect(dialog.locator(".share-tag-chip.added")).toBeDisabled()

    // Picking a second chip merges on top.
    await dialog.locator(".share-tag-chip", { hasText: "少年" }).click()
    await expect(tagsInput).toHaveValue("aimer マイタグ 少年")

    // The unmatched line reports works the API could not match.
    await expect(dialog.locator(".share-tags-note")).toContainText("1作品が見つかりませんでした")
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("tag suggestions: upstream failure is a non-fatal note, publish still works", async ({}, testInfo) => {
  const { context, extensionId, calls } = await launchExtension(testInfo, "down")
  try {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/options.html`)
    await expect(page.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })

    await page.locator(".playlist-card .share-open").click()
    const dialog = page.locator("#d-op-modal")
    await expect(dialog.locator(".share-dialog")).toBeVisible()

    await dialog.locator(".share-tags-suggest").click()
    await expect(() => expect(calls).toHaveLength(1)).toPass({ timeout: 15_000 })
    const note = dialog.locator(".share-tags-note")
    await expect(note).toContainText("候補を取得できませんでした", { timeout: 15_000 })
    // Publish stays usable: pick a visibility and the button enables.
    await dialog.locator("input[name='dopShareVisibility'][value='public']").check()
    await expect(dialog.locator(".share-publish")).toBeEnabled()
  } finally {
    await context.close()
  }
})
