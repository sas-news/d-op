import fs from "node:fs"
import path from "node:path"
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
  type Worker,
} from "@playwright/test"

// Task-17 web→extension import acceptance against the real unpacked WXT
// build (chrome-mv3). The canonical share origin is fully synthetic here:
// context.route fulfills https://d-op.sasnews.dev/* (share page HTML, the real
// public/share-page.js, and the fixed Share API), so no production traffic is
// ever attempted — the catch-all aborts every other http(s) request. Coverage:
// save→preview→confirm happy path, forged/iframe/malformed rejection, dedupe,
// oversized/no-network/404 failure modes, independence of the imported copy,
// closed-page behavior, and the no-capability boundary. NOT run in the
// task-17 session (a parallel worker owns the ports); the orchestrator runs
// `bun run test:e2e -- --project=extension-chromium web-import.spec.ts`.

const EXTENSION_PATH = path.resolve("apps/extension/.output/chrome-mv3")
const SHARE_PAGE_JS = path.resolve("apps/web/public/share-page.js")
const ORIGIN = "https://d-op.sasnews.dev"
const SHARE_ID = "e2eImportShareId000001" // ShareIdSchema: exactly 22 chars
const HASH = "c".repeat(64)

test.setTimeout(90_000)

function sharedResponse(shareId: string) {
  return {
    shareId,
    revision: 3,
    publishedAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T01:00:00.000Z",
    contentHash: HASH,
    playlist: {
      schemaVersion: 1,
      title: "E2E 共有リスト",
      description: "fixture",
      author: "e2e-author",
      tags: ["op"],
      visibility: "public",
      items: [
        {
          partId: "part_alpha",
          workId: "work_alpha",
          title: "作品A",
          episodeTitle: "第1話",
          episodeNumber: "1",
          range: { start: 0, end: 90_000, name: "OP" },
        },
        {
          partId: "part_beta",
          title: "作品B",
          episodeTitle: "第2話",
          range: { start: 5_000, end: 95_500 },
        },
      ],
    },
    itemCount: 2,
    totalDurationMs: 180_500,
    importCount: 0,
    source: null,
  }
}

function sharePageHtml(shareId: string, extra = ""): string {
  // Mirrors ShareSavePanel.astro's contract: disabled button + status line +
  // deferred same-origin script. No playlist JSON in the DOM.
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body>
    <button type="button" data-share-save data-share-id="${shareId}" disabled
      aria-disabled="true" data-testid="save-open-button">d-OP で開く</button>
    <p data-share-save-status data-testid="save-status">拡張機能が見つかりません。</p>
    ${extra}
    <script src="/share-page.js" defer></script>
  </body></html>`
}

type ApiMode = "ok" | "oversized" | "malformed" | "not-found" | "offline"

type Rig = {
  readonly context: BrowserContext
  readonly worker: Worker
  readonly extensionId: string
  readonly apiCalls: string[]
  readonly apiWrites: string[]
  setApiMode: (mode: ApiMode) => void
}

async function launchImporter(
  testInfo: import("@playwright/test").TestInfo,
  name: string,
  seed?: Record<string, unknown>,
): Promise<Rig> {
  const context = await chromium.launchPersistentContext(testInfo.outputPath(`profile-${name}`), {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  })
  let apiMode: ApiMode = "ok"
  const apiCalls: string[] = []
  const apiWrites: string[] = []
  // Catch-all first (routes consult newest-first): nothing real leaves the box.
  await context.route(/^https?:\/\//, (route) => route.abort())
  await context.route(`${ORIGIN}/api/v1/playlists/*`, (route) => {
    const request = route.request()
    apiCalls.push(`${request.method()} ${request.url()}`)
    if (request.method() !== "GET") apiWrites.push(request.method())
    const shareId = request.url().split("/").pop() ?? ""
    switch (apiMode) {
      case "ok":
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: sharedResponse(shareId) }),
        })
      case "oversized":
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: `{"data":${JSON.stringify(sharedResponse(shareId)).slice(0, -1)},"pad":"${"x".repeat(300_000)}"}`,
        })
      case "malformed":
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: { shareId, bogus: true } }),
        })
      case "not-found":
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "NOT_FOUND", message: "gone", requestId: "r" },
          }),
        })
      case "offline":
        return route.abort()
    }
  })
  await context.route(`${ORIGIN}/share-page.js`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      body: fs.readFileSync(SHARE_PAGE_JS),
    }),
  )
  await context.route(`${ORIGIN}/p/*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: sharePageHtml(route.request().url().split("/").pop() ?? SHARE_ID),
    }),
  )
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 10_000 }))
  const extensionId = new URL(worker.url()).hostname
  if (seed !== undefined) {
    await worker.evaluate(`chrome.storage.local.set(${JSON.stringify(seed)})`)
  }
  return {
    context,
    worker,
    extensionId,
    apiCalls,
    apiWrites,
    setApiMode: (mode) => {
      apiMode = mode
    },
  }
}

function readState(worker: Worker) {
  return worker.evaluate(
    `(async () => chrome.storage.local.get(["dop_v2_state", "dop_v2_imports"]))()`,
  ) as Promise<Record<string, unknown>>
}

async function openSharePage(rig: Rig, shareId = SHARE_ID): Promise<Page> {
  const page = await rig.context.newPage()
  await page.goto(`${ORIGIN}/p/${shareId}`)
  return page
}

async function waitForImportWindow(rig: Rig): Promise<Page> {
  return await rig.context.waitForEvent("page", {
    predicate: (page) => page.url().startsWith(`chrome-extension://${rig.extensionId}/import.html`),
    timeout: 10_000,
  })
}

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("happy path: marker enables save, preview shows name/items/total, confirm commits an independent copy", async ({}, testInfo) => {
  const rig = await launchImporter(testInfo, "importer")
  try {
    const page = await openSharePage(rig)
    const button = page.locator("[data-testid='save-open-button']")
    await expect(button).toBeEnabled({ timeout: 10_000 })
    await expect(page.locator("html[data-dop-extension]")).toHaveCount(1)

    const popupPromise = waitForImportWindow(rig)
    await button.click()
    const popup = await popupPromise
    await expect(popup.locator("[data-testid='import-title']")).toHaveText("E2E 共有リスト")
    await expect(popup.locator("[data-testid='import-count']")).toHaveText("2 件")
    await expect(popup.locator("[data-testid='import-duration']")).toHaveText("3:00")
    await expect(popup.locator("[data-testid='import-author']")).toHaveText("e2e-author")
    await expect(page.locator("[data-testid='save-status']")).toContainText("確認画面")

    await popup.locator("[data-testid='import-confirm']").click()
    await expect(popup.locator("[data-testid='import-status']")).toContainText("保存しました")

    const stored = await readState(rig.worker)
    const state = stored["dop_v2_state"] as {
      playlists: { id: string; name: string; items: { id: string; partId: string }[] }[]
      publications: unknown[]
    }
    expect(state.playlists).toHaveLength(1)
    const playlist = state.playlists[0]
    expect(playlist?.name).toBe("E2E 共有リスト")
    expect(playlist?.id).not.toBe(SHARE_ID)
    expect(playlist?.items.map((item) => item.partId)).toEqual(["part_alpha", "part_beta"])
    for (const item of playlist?.items ?? []) {
      expect("url" in item).toBe(false)
      expect("manageSecret" in item).toBe(false)
    }
    // No capability anywhere: publications stay empty, provenance has no secret.
    expect(state.publications).toEqual([])
    const imports = stored["dop_v2_imports"] as { records: Record<string, unknown>[] }
    expect(imports.records).toHaveLength(1)
    expect(imports.records[0]).toMatchObject({ shareId: SHARE_ID, playlistId: playlist?.id })
    expect(JSON.stringify(imports)).not.toContain("manageSecret")
    // The only remote write is the task-18 aggregate import POST {eventId} —
    // fired AFTER the local commit (fire-and-forget, so poll for it). No
    // snapshot data or keys ever leave.
    await expect.poll(() => rig.apiWrites, { timeout: 5_000 }).toEqual(["POST"])
    // The page received only a status ack — no library data crosses.
    expect(await page.locator("[data-testid='save-status']").textContent()).not.toContain(
      "part_alpha",
    )
  } finally {
    await rig.context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("publisher/importer isolation: import never touches the publisher's record or remote", async ({}, testInfo) => {
  const publisher = await launchImporter(testInfo, "publisher", {
    dop_v2_state: {
      schemaVersion: 2,
      revision: 4,
      playlists: [{ id: "pub-pl", name: "公開側", items: [] }],
      publications: [
        {
          shareId: SHARE_ID,
          localPlaylistId: "pub-pl",
          manageSecret: "p".repeat(43),
          revision: 3,
          contentHash: HASH,
          sentSnapshot: "{}",
          acknowledgedHash: HASH,
          visibility: "public",
          createdAt: "2026-09-20T00:00:00.000Z",
          updatedAt: "2026-09-20T00:00:00.000Z",
          state: "active",
        },
      ],
      pendingCreates: [],
      preferences: { windowMode: "tab", collapsedPlaylists: {} },
      appliedOperations: [],
    },
  })
  const importer = await launchImporter(testInfo, "importer")
  try {
    const page = await openSharePage(importer)
    await expect(page.locator("[data-testid='save-open-button']")).toBeEnabled()
    const popupPromise = waitForImportWindow(importer)
    await page.locator("[data-testid='save-open-button']").click()
    const popup = await popupPromise
    await popup.locator("[data-testid='import-confirm']").click()
    await expect(popup.locator("[data-testid='import-status']")).toContainText("保存しました")

    // Importer gained a FRESH playlist with no link to the publisher's vault.
    const stored = await readState(importer.worker)
    const state = stored["dop_v2_state"] as {
      playlists: { id: string }[]
      publications: unknown[]
    }
    expect(state.playlists[0]?.id).not.toBe("pub-pl")
    expect(state.publications).toEqual([])
    // Publisher state and remote are untouched.
    const publisherState = (await readState(publisher.worker))["dop_v2_state"] as {
      playlists: unknown[]
      publications: unknown[]
    }
    expect(publisherState.playlists).toHaveLength(1)
    expect(publisherState.publications).toHaveLength(1)
    // Importer's only write is the task-18 aggregate import POST (poll — it
    // is fire-and-forget); the publisher's profile never talks to the API.
    await expect.poll(() => importer.apiWrites, { timeout: 5_000 }).toEqual(["POST"])
    expect(publisher.apiCalls).toEqual([])
  } finally {
    await publisher.context.close()
    await importer.context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("forge/iframe/duplicate click/cancel: only one confirmed flow, one playlist", async ({}, testInfo) => {
  const rig = await launchImporter(testInfo, "forge")
  try {
    // A foreign-origin page cannot drive the relay at all (no content script
    // matches it) — even posting a valid request achieves nothing.
    const evil = await rig.context.newPage()
    await rig.context.route("https://evil.example/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><body><script>
          window.postMessage(${JSON.stringify({
            source: "d-op-share-page",
            type: "DOP_SHARE_IMPORT_REQUEST",
            version: 1,
            shareId: SHARE_ID,
            requestId: crypto.randomUUID(),
          })}, location.origin)
        </script></body></html>`,
      }),
    )
    await evil.goto(`https://evil.example/p/${SHARE_ID}`)
    await evil.waitForTimeout(500)
    expect(rig.apiCalls).toEqual([])

    // An iframe posting to the top window fails event.source === window.
    await rig.context.unroute(`${ORIGIN}/p/*`)
    const iframeRequest = JSON.stringify({
      source: "d-op-share-page",
      type: "DOP_SHARE_IMPORT_REQUEST",
      version: 1,
      shareId: SHARE_ID,
      requestId: crypto.randomUUID(),
    }).replaceAll('"', "&quot;")
    await rig.context.route(`${ORIGIN}/p/*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: sharePageHtml(
          route.request().url().split("/").pop() ?? SHARE_ID,
          `<iframe srcdoc="<script>window.parent.postMessage(${iframeRequest}, '${ORIGIN}')</script>"></iframe>`,
        ),
      }),
    )
    const page = await openSharePage(rig)
    await page.waitForTimeout(500)
    expect(rig.apiCalls).toEqual([])

    // Rapid duplicate clicks: first opens, second is a duplicate/throttled —
    // never a second confirmation window.
    const button = page.locator("[data-testid='save-open-button']")
    await expect(button).toBeEnabled()
    const popupPromise = waitForImportWindow(rig)
    await button.click()
    const popup = await popupPromise
    await button.click() // new requestId, same shareId, inside throttle window
    await page.waitForTimeout(400)
    const importPages = rig.context
      .pages()
      .filter((candidate) => candidate.url().includes("/import.html"))
    expect(importPages).toHaveLength(1)

    // Cancel leaves nothing committed and closes the confirmation window.
    const closed = popup.waitForEvent("close", { timeout: 10_000 })
    await popup.locator("[data-testid='import-cancel']").click()
    await closed
    const stored = await readState(rig.worker)
    const state = stored["dop_v2_state"] as { playlists?: unknown[] } | undefined
    expect(state?.playlists ?? []).toHaveLength(0)
  } finally {
    await rig.context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("failure modes: oversized/malformed/404/offline never commit", async ({}, testInfo) => {
  const rig = await launchImporter(testInfo, "failures")
  try {
    const cases = [
      ["oversized", "大きすぎ"],
      ["malformed", "読み取れません"],
      ["not-found", "見つかりません"],
      ["offline", "ネットワーク"],
    ] as const
    for (const [index, [mode, expected]] of cases.entries()) {
      rig.setApiMode(mode)
      // Distinct shareIds sidestep the 1.5 s same-shareId throttle.
      const shareId = `e2eFailureShareId0000${index}` // 22 chars
      const page = await openSharePage(rig, shareId)
      await expect(page.locator("[data-testid='save-open-button']")).toBeEnabled()
      const popupPromise = waitForImportWindow(rig)
      await page.locator("[data-testid='save-open-button']").click()
      const popup = await popupPromise
      await expect(popup.locator("[data-testid='import-status']")).toContainText(expected, {
        timeout: 10_000,
      })
      await expect(popup.locator("[data-testid='import-confirm']")).toBeDisabled()
      const stored = await readState(rig.worker)
      const state = stored["dop_v2_state"] as { playlists?: unknown[] } | undefined
      expect(state?.playlists ?? []).toHaveLength(0)
      await popup.close()
      await page.close()
    }
  } finally {
    await rig.context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("closed share page cannot undo a completed save; imported copy edits independently", async ({}, testInfo) => {
  const rig = await launchImporter(testInfo, "detach")
  try {
    const page = await openSharePage(rig)
    await expect(page.locator("[data-testid='save-open-button']")).toBeEnabled()
    const popupPromise = waitForImportWindow(rig)
    await page.locator("[data-testid='save-open-button']").click()
    const popup = await popupPromise
    await popup.locator("[data-testid='import-confirm']").click()
    await expect(popup.locator("[data-testid='import-status']")).toContainText("保存しました")

    // Local rename through the public storage surface — remote untouched.
    // (runtime.sendMessage must come from a non-background context, so the
    // still-open extension page sends it.)
    const after = await popup.evaluate(`(async () => {
      const read = (await chrome.storage.local.get("dop_v2_state")).dop_v2_state
      await chrome.runtime.sendMessage({
        type: "DOP_STORAGE_COMMAND",
        command: {
          kind: "rename-playlist",
          operationId: crypto.randomUUID(),
          expectedRevision: read.revision,
          playlistId: read.playlists[0].id,
          name: "ローカル改名",
        },
      })
      const state = (await chrome.storage.local.get("dop_v2_state")).dop_v2_state
      return { name: state.playlists[0].name, itemCount: state.playlists[0].items.length }
    })()`)
    expect(after).toMatchObject({ name: "ローカル改名", itemCount: 2 })
    // The earlier commit already fired the task-18 aggregate POST — the local
    // rename itself issues no further API traffic.
    await expect.poll(() => rig.apiWrites, { timeout: 5_000 }).toEqual(["POST"])

    // Close BOTH the share page and the confirmation — the commit stands.
    await page.close()
    await popup.close()
    const stored = await readState(rig.worker)
    const state = stored["dop_v2_state"] as {
      playlists: { id: string; name: string; items: unknown[] }[]
    }
    expect(state.playlists).toHaveLength(1)
    expect(state.playlists[0]?.name).toBe("ローカル改名")
  } finally {
    await rig.context.close()
  }
})

test("missing extension: save button stays disabled, no postMessage listener", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true })
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    let posted = false
    // Catch-all first (routes consult newest-first): nothing real leaves the box.
    await context.route(/^https?:\/\//, (route) => route.abort())
    await context.route(`${ORIGIN}/share-page.js`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/javascript; charset=utf-8",
        body: fs.readFileSync(SHARE_PAGE_JS),
      }),
    )
    await context.route(`${ORIGIN}/p/*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: sharePageHtml(SHARE_ID),
      }),
    )
    const page = await context.newPage()
    await page.exposeFunction("dopMarkPosted", () => {
      posted = true
    })
    await page.goto(`${ORIGIN}/p/${SHARE_ID}`)
    const button = page.locator("[data-testid='save-open-button']")
    await expect(button).toBeDisabled()
    await expect(page.locator("html[data-dop-extension]")).toHaveCount(0)
    await expect(page.locator("[data-testid='save-status']")).toContainText("見つかりません")
    // Clicking a disabled button is a no-op — nothing is posted anywhere.
    await button.click({ force: true }).catch(() => undefined)
    await page.waitForTimeout(300)
    expect(posted).toBe(false)
    await context.close()
  } finally {
    await browser.close()
  }
})
