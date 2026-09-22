import fs from "node:fs"
import path from "node:path"
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  type Route,
  type TestInfo,
  test,
  type Worker,
} from "@playwright/test"
import { browserLaunchTarget } from "./browser-target"
import { waitForContextPage } from "./context-pages"

// Task-22 privacy/consent acceptance on the real unpacked WXT build
// (chrome-mv3). Proves the consent contract end to end against the synthetic
// Share API (route interception; nothing real leaves the box):
//   * zero Share API traffic before any consent choice
//   * declined consent keeps every local feature and emits zero Share traffic
//   * granted consent allows publish/import with whitelisted payloads only
//   * revocation blocks future Share traffic but preserves remote+vault data
//   * foreign/non-options senders are forbidden regardless of consent
const EXTENSION_PATH = path.resolve("apps/extension/.output/chrome-mv3")
const SHARE_PAGE_JS = path.resolve("apps/web/public/share-page.js")
const ORIGIN = "https://d-op.sasnews.dev"
const SHARE_ID = "e2eConsentShareId00001" // ShareIdSchema: exactly 22 chars
const IMPORT_ID = "e2eConsentImport000001" // 22 chars
const MANAGE_SECRET = `e2eConsent${"0".repeat(33)}` // ManageSecretSchema: exactly 43 chars
const NOW = "2026-09-20T00:00:00.000Z"

test.setTimeout(90_000)

type SeedItem = {
  id: string
  partId: string
  title: string
  episodeTitle: string
  episodeNumber?: string
  url?: string
  range: { start: number; end: number; name?: string } | null
}

function item(id: string, partId: string, episode: string): SeedItem {
  return {
    id,
    partId,
    title: "Fixture Work",
    episodeTitle: `第${episode}話`,
    episodeNumber: episode,
    url: `https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=${partId}`,
    range: { start: 0, end: 90_000, name: "OP" },
  }
}

function v2State(
  consent: "granted" | "declined" | "absent",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    revision: 0,
    playlists: [
      { id: "pl-1", name: "E2E Consent", items: [item("a", "p1", "1"), item("b", "p2", "2")] },
    ],
    publications: [],
    pendingCreates: [],
    preferences: { windowMode: "tab", collapsedPlaylists: {} },
    appliedOperations: [],
    ...(consent === "absent" ? {} : { shareConsent: { choice: consent, decidedAt: NOW } }),
    ...extra,
  }
}

function detachedRecord(): Record<string, unknown> {
  return {
    shareId: SHARE_ID,
    localPlaylistId: null,
    manageSecret: MANAGE_SECRET,
    revision: 2,
    contentHash: "a".repeat(64),
    sentSnapshot: JSON.stringify({ sent: true }),
    acknowledgedHash: "b".repeat(64),
    visibility: "public",
    createdAt: NOW,
    updatedAt: NOW,
    state: "local-deleted",
  }
}

type ApiCall = {
  method: string
  path: string
  body: unknown
  auth: string | undefined
}

type FakeApi = {
  log: ApiCall[]
  /** shareId → contentHash of the snapshot the extension actually sent —
   *  the publish flow verifies the server echoes this exact hash. */
  hashes: Map<string, string>
}

/** Canonical JSON (sorted keys) — mirrors shared/src/share-canonical.ts. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
}

async function contentHashOf(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  )
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function apiJson(status: number, data: unknown) {
  return { status, contentType: "application/json", body: JSON.stringify({ data }) }
}

/** Minimal real-contract Share API: provisional create, activate PATCH,
 *  public GET, aggregate import notify — recording every call. */
async function handleShareApi(route: Route, api: FakeApi): Promise<void> {
  const request = route.request()
  const url = new URL(request.url())
  const pathName = url.pathname
  const postBody = (): unknown =>
    request.postData() === null ? undefined : JSON.parse(request.postData() ?? "null")
  api.log.push({
    method: request.method(),
    path: pathName,
    body: request.method() === "GET" || request.method() === "DELETE" ? undefined : postBody(),
    auth: request.headers()["authorization"],
  })
  const importMatch = /^\/api\/v1\/playlists\/([A-Za-z0-9_-]+)\/import$/.exec(pathName)
  if (importMatch !== null && request.method() === "POST") {
    return route.fulfill({ status: 204 })
  }
  const match = /^\/api\/v1\/playlists(?:\/([A-Za-z0-9_-]+))?$/.exec(pathName)
  const id = match?.[1]
  if (request.method() === "POST" && id === undefined) {
    // The real server stores the posted snapshot and echoes its canonical
    // hash — publish verifies the echo, so the fake must compute it.
    const hash = await contentHashOf(postBody())
    api.hashes.set(SHARE_ID, hash)
    return route.fulfill(
      apiJson(201, {
        shareId: SHARE_ID,
        manageSecret: MANAGE_SECRET,
        revision: 1,
        contentHash: hash,
        createdAt: NOW,
        activationExpiresAt: "2026-09-20T01:00:00.000Z",
        state: "pending",
      }),
    )
  }
  if (request.method() === "PATCH" && id === SHARE_ID) {
    return route.fulfill(
      apiJson(200, {
        shareId: SHARE_ID,
        revision: 2,
        contentHash: api.hashes.get(SHARE_ID) ?? "c".repeat(64),
        publishedAt: NOW,
        updatedAt: NOW,
      }),
    )
  }
  if (request.method() === "GET" && id !== undefined) {
    return route.fulfill(
      apiJson(200, {
        shareId: id,
        revision: 2,
        publishedAt: NOW,
        updatedAt: NOW,
        contentHash: "c".repeat(64),
        playlist: {
          schemaVersion: 1,
          title: "E2E 外部共有",
          description: "",
          author: "remote-author",
          tags: [],
          visibility: "public",
          items: [
            {
              partId: "ext_part",
              title: "外部作品",
              episodeTitle: "第1話",
              range: { start: 0, end: 90_000, name: "OP" },
            },
          ],
        },
        itemCount: 1,
        totalDurationMs: 90_000,
        importCount: 0,
        source: null,
      }),
    )
  }
  return route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "NOT_FOUND", message: "e2e", requestId: "r" } }),
  })
}

function sharePageHtml(shareId: string): string {
  // Mirrors the /p/ page contract: SSR-disabled button + status line +
  // deferred same-origin script. No playlist JSON in the DOM.
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body>
    <button type="button" data-share-save data-share-id="${shareId}" disabled
      aria-disabled="true" data-testid="save-open-button">d-OP で開く</button>
    <p data-share-save-status data-testid="save-status">拡張機能が見つかりません。</p>
    <script src="/share-page.js" defer></script>
  </body></html>`
}

type Rig = {
  readonly context: BrowserContext
  readonly worker: Worker
  readonly extensionId: string
  readonly apiLog: ApiCall[]
}

async function launchExtension(testInfo: TestInfo, seed: Record<string, unknown>): Promise<Rig> {
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
  const api: FakeApi = { log: [], hashes: new Map() }
  // Catch-all abort FIRST — every external http(s) request dies unless a
  // newer specific route wins (Playwright consults newest first).
  await context.route(/^https?:\/\//, (route) => route.abort())
  await context.route(/\/api\/v1\/playlists/, (route) => handleShareApi(route, api))
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
  await worker.evaluate(`(async () => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set({ dop_v2_state: ${JSON.stringify(seed)} })
  })()`)
  const extensionId = new URL(worker.url()).hostname
  return { context, worker, extensionId, apiLog: api.log }
}

function readState(worker: Worker) {
  return worker.evaluate(
    `chrome.storage.local.get("dop_v2_state").then((r) => r.dop_v2_state)`,
  ) as Promise<{
    revision: number
    playlists: { id: string; name: string; items: unknown[] }[]
    publications: { shareId: string; state: string }[]
    shareConsent?: { choice: string; decidedAt: string }
  }>
}

async function openOptions(rig: Rig): Promise<Page> {
  const page = await rig.context.newPage()
  await page.goto(`chrome-extension://${rig.extensionId}/options.html`)
  await expect(page.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })
  return page
}

async function openSharePage(rig: Rig, shareId: string): Promise<Page> {
  const page = await rig.context.newPage()
  await page.goto(`${ORIGIN}/p/${shareId}`)
  await expect(page.locator("[data-testid='save-open-button']")).toBeEnabled({ timeout: 10_000 })
  return page
}

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("undecided: zero Share API traffic until an explicit choice", async ({}, testInfo) => {
  const rig = await launchExtension(testInfo, v2State("absent"))
  try {
    const page = await openOptions(rig)

    // Consent section shows the undecided state with both explicit choices.
    await expect(page.locator("[data-testid='share-consent-status']")).toContainText("未設定")
    await expect(page.locator("[data-testid='share-consent-grant']")).toBeVisible()
    await expect(page.locator("[data-testid='share-consent-decline']")).toBeVisible()

    // Ordinary local edits stay fully local — zero Share API traffic.
    const nameInput = page.locator(".playlist-name-input")
    await nameInput.fill("Undecided Rename")
    await nameInput.press("Tab")
    await expect(nameInput).toHaveValue("Undecided Rename")

    // The share dialog gates behind the consent panel — no publish actions.
    await page.locator(".playlist-card .share-open").click()
    const dialog = page.locator("#d-op-modal")
    await expect(dialog.locator(".share-consent-text")).toBeVisible()
    await expect(dialog.locator(".share-consent-grant")).toBeVisible()
    await expect(dialog.locator(".share-publish")).toHaveCount(0)
    await expect(dialog.locator(".share-inspect")).toHaveCount(0)
    await dialog.locator("button", { hasText: "閉じる" }).click()

    // Web→ext import: the relay is accepted (a token is minted + the window
    // opens) but the confirmation page lands on the consent prompt — the
    // background never prefetches the snapshot before an explicit grant.
    const sharePage = await openSharePage(rig, SHARE_ID)
    const popupPromise = waitForContextPage(
      rig.context,
      `chrome-extension://${rig.extensionId}/import.html`,
      10_000,
    )
    await sharePage.locator("[data-testid='save-open-button']").click()
    const popup = await popupPromise
    await expect(popup.locator("[data-testid='import-consent']")).toBeVisible()
    await expect(popup.locator("[data-testid='import-preview']")).toBeHidden()
    await popup.close()

    expect(rig.apiLog).toEqual([])
    const state = await readState(rig.worker)
    expect(state.shareConsent).toBeUndefined()
  } finally {
    await rig.context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("declined: every local feature works and Share emits zero traffic", async ({}, testInfo) => {
  const rig = await launchExtension(
    testInfo,
    v2State("declined", { publications: [detachedRecord()] }),
  )
  try {
    const page = await openOptions(rig)

    // Consent section shows declined + offers re-enable.
    await expect(page.locator("[data-testid='share-consent-status']")).toContainText("無効")
    await expect(page.locator("[data-testid='share-consent-grant']")).toBeVisible()

    // Local features all work: create, rename, and the detached-management
    // list still renders (key material never shown).
    await page.locator("#newPlaylistName").fill("Local Only")
    await page.locator("#createPlaylistBtn").click()
    await expect(page.locator(".playlist-card")).toHaveCount(2, { timeout: 10_000 })
    const nameInput = page.locator(".playlist-name-input").first()
    await nameInput.fill("Still Local")
    await nameInput.press("Tab")
    const row = page.locator("#managementList .management-row")
    await expect(row).toHaveCount(1)

    // Detached-row inspect is gated by the background — no API call.
    await row.locator(".management-inspect").click()
    await expect(row.locator(".management-remote")).toContainText("無効", { timeout: 10_000 })

    // Share dialog shows the consent panel, never the publish form.
    await page.locator(".playlist-card .share-open").first().click()
    const dialog = page.locator("#d-op-modal")
    await expect(dialog.locator(".share-consent-text")).toBeVisible()
    await expect(dialog.locator(".share-publish")).toHaveCount(0)
    await dialog.locator("button", { hasText: "閉じる" }).click()

    // The relayed import request is rejected outright — no window, no GET.
    const sharePage = await openSharePage(rig, SHARE_ID)
    await sharePage.locator("[data-testid='save-open-button']").click()
    await expect(sharePage.locator("[data-testid='save-status']")).toContainText(
      "受け付けられません",
      { timeout: 10_000 },
    )
    await sharePage.waitForTimeout(500)
    const importPages = rig.context
      .pages()
      .filter((candidate) => candidate.url().includes("/import.html"))
    expect(importPages).toHaveLength(0)

    expect(rig.apiLog).toEqual([])
  } finally {
    await rig.context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("granted: publish/import run with whitelisted payloads only", async ({}, testInfo) => {
  const rig = await launchExtension(testInfo, v2State("absent"))
  try {
    const page = await openOptions(rig)

    // Explicit grant through the options consent section.
    await page.locator("[data-testid='share-consent-grant']").click()
    await expect(page.locator("[data-testid='share-consent-status']")).toContainText("有効", {
      timeout: 10_000,
    })
    expect((await readState(rig.worker)).shareConsent?.choice).toBe("granted")

    // Publish through the dialog — explicit visibility required.
    await page.locator(".playlist-card .share-open").click()
    const dialog = page.locator("#d-op-modal")
    await dialog.locator("input[name='dopShareVisibility'][value='unlisted']").check()
    await dialog.locator(".share-publish").click()
    await expect(dialog.locator(".share-url")).toHaveText(`${ORIGIN}/p/${SHARE_ID}`, {
      timeout: 15_000,
    })
    await dialog.locator("button", { hasText: "閉じる" }).click()

    // Import a foreign share: relay → window → confirm → commit + notify.
    const sharePage = await openSharePage(rig, IMPORT_ID)
    const popupPromise = waitForContextPage(
      rig.context,
      `chrome-extension://${rig.extensionId}/import.html`,
      10_000,
    )
    await sharePage.locator("[data-testid='save-open-button']").click()
    const popup = await popupPromise
    await expect(popup.locator("[data-testid='import-title']")).toHaveText("E2E 外部共有", {
      timeout: 10_000,
    })
    await popup.locator("[data-testid='import-confirm']").click()
    await expect(popup.locator("[data-testid='import-status']")).toContainText("保存しました")

    // Whitelist proof: every observed call is a Share API call and every
    // body contains ONLY contract fields — no local ids, no secrets, no
    // credentials travel in bodies or URLs.
    const calls = rig.apiLog.map((call) => `${call.method} ${call.path}`)
    expect(calls).toEqual([
      "POST /api/v1/playlists",
      `PATCH /api/v1/playlists/${SHARE_ID}`,
      `GET /api/v1/playlists/${IMPORT_ID}`,
      `POST /api/v1/playlists/${IMPORT_ID}/import`,
    ])
    // POST create body IS the SharedPlaylist projection — exactly the
    // publish whitelist, nothing else.
    const createBody = rig.apiLog[0]?.body as Record<string, unknown>
    expect(Object.keys(createBody).sort()).toEqual([
      "author",
      "description",
      "items",
      "schemaVersion",
      "tags",
      "title",
      "visibility",
    ])
    expect(createBody["visibility"]).toBe("unlisted")
    const items = createBody["items"] as Record<string, unknown>[]
    expect(items).toHaveLength(2)
    for (const entry of items) {
      // Item whitelist: partId/workId/title/episodeTitle/episodeNumber/range
      // — never local item ids or page URLs.
      for (const key of Object.keys(entry)) {
        expect(["partId", "workId", "title", "episodeTitle", "episodeNumber", "range"]).toContain(
          key,
        )
      }
      expect(entry).not.toHaveProperty("id")
      expect(entry).not.toHaveProperty("url")
    }
    // The management key never travels in a body — only the Bearer header on
    // the mutation it authorizes; the provisional create carries no auth.
    expect(rig.apiLog[0]?.auth).toBeUndefined()
    expect(rig.apiLog[1]?.auth).toBe(`Bearer ${MANAGE_SECRET}`)
    const patchBody = rig.apiLog[1]?.body as Record<string, unknown>
    expect(patchBody["operation"]).toBe("activate")
    expect(patchBody["expectedRevision"]).toBe(1)
    expect(Object.keys(patchBody).sort()).toEqual(["expectedRevision", "operation"])
    // Import notification body is exactly {eventId} — nothing else.
    const notifyBody = rig.apiLog[3]?.body as Record<string, unknown>
    expect(Object.keys(notifyBody)).toEqual(["eventId"])
    // No request body or URL may contain the secret or local playlist ids.
    for (const call of rig.apiLog) {
      expect(JSON.stringify(call.body ?? {})).not.toContain(MANAGE_SECRET)
      expect(call.path).not.toContain(MANAGE_SECRET)
      expect(JSON.stringify(call.body ?? {})).not.toContain("pl-1")
    }
    // The imported copy is independent — fresh local id, no vault record.
    const state = await readState(rig.worker)
    const imported = state.playlists.find((entry) => entry.name === "E2E 外部共有")
    expect(imported).toBeDefined()
    expect(imported?.id).not.toBe(IMPORT_ID)
    expect(state.publications).toHaveLength(1) // only the publish record
    expect(state.publications[0]?.shareId).toBe(SHARE_ID)
  } finally {
    await rig.context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("revoked: future Share traffic blocked, remote publication preserved", async ({}, testInfo) => {
  const rig = await launchExtension(
    testInfo,
    v2State("granted", { publications: [detachedRecord()] }),
  )
  try {
    const page = await openOptions(rig)

    // Detached row inspect works while granted — one GET, remote active.
    const row = page.locator("#managementList .management-row")
    await expect(row).toHaveCount(1)
    await row.locator(".management-inspect").click()
    await expect(row.locator(".management-remote")).toContainText("公開中", { timeout: 10_000 })
    expect(rig.apiLog.map((call) => call.method)).toEqual(["GET"])

    // Revoke via the consent section — the local record becomes declined.
    await page.locator("[data-testid='share-consent-revoke']").click()
    await expect(page.locator("[data-testid='share-consent-status']")).toContainText("無効", {
      timeout: 10_000,
    })
    const state = await readState(rig.worker)
    expect(state.shareConsent?.choice).toBe("declined")
    // The publication record (and its remote counterpart) is NOT deleted.
    expect(state.publications).toHaveLength(1)

    // Future Share traffic is blocked: row inspect, share dialog, and the
    // relayed import request all stop at the background gate.
    await row.locator(".management-inspect").click()
    await expect(row.locator(".management-remote")).toContainText("無効", { timeout: 10_000 })
    await page.locator(".playlist-card .share-open").click()
    const dialog = page.locator("#d-op-modal")
    await expect(dialog.locator(".share-consent-text")).toBeVisible()
    await dialog.locator("button", { hasText: "閉じる" }).click()
    const sharePage = await openSharePage(rig, SHARE_ID)
    await sharePage.locator("[data-testid='save-open-button']").click()
    await expect(sharePage.locator("[data-testid='save-status']")).toContainText(
      "受け付けられません",
      { timeout: 10_000 },
    )
    expect(rig.apiLog.map((call) => call.method)).toEqual(["GET"]) // still just the pre-revoke GET
  } finally {
    await rig.context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("foreign senders: management is forbidden regardless of consent", async ({}, testInfo) => {
  const rig = await launchExtension(testInfo, v2State("granted"))
  try {
    // A non-options extension surface (the import page) sending a management
    // message gets `forbidden` — even with consent granted.
    const page = await rig.context.newPage()
    const token = crypto.randomUUID()
    await page.goto(`chrome-extension://${rig.extensionId}/import.html?t=${token}`)
    const reply = await page.evaluate(`chrome.runtime.sendMessage({
      kind: "share-manage-inspect",
      shareId: "${SHARE_ID}",
    })`)
    expect(reply).toEqual({ kind: "share-manage-result", status: "forbidden" })

    // The popup surface is equally unauthorized.
    const popup = await rig.context.newPage()
    await popup.goto(`chrome-extension://${rig.extensionId}/popup.html`)
    const popupReply = await popup.evaluate(`chrome.runtime.sendMessage({
      kind: "share-manage-publish",
      operationId: "${crypto.randomUUID()}",
      playlistId: "pl-1",
      metadata: { visibility: "public" },
    })`)
    expect(popupReply).toEqual({ kind: "share-manage-result", status: "forbidden" })

    // Consent-declined profile: still forbidden, never consent-required for
    // foreign senders (authorization precedes the consent gate).
    expect(rig.apiLog).toEqual([])
  } finally {
    await rig.context.close()
  }

  const declined = await launchExtension(testInfo, v2State("declined"))
  try {
    const page = await declined.context.newPage()
    await page.goto(
      `chrome-extension://${declined.extensionId}/import.html?t=${crypto.randomUUID()}`,
    )
    const reply = await page.evaluate(`chrome.runtime.sendMessage({
      kind: "share-manage-inspect",
      shareId: "${SHARE_ID}",
    })`)
    expect(reply).toEqual({ kind: "share-manage-result", status: "forbidden" })
    expect(declined.apiLog).toEqual([])
  } finally {
    await declined.context.close()
  }
})
