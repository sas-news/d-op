import { createHash } from "node:crypto"
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

// Task-15 publication management acceptance against the real unpacked WXT
// build (chrome-mv3). Modelled on extension-portable.spec.ts: a synthetic
// Share API is served via route interception (registered AFTER the catch-all
// abort so it wins — Playwright consults newest routes first), the service
// worker owns every Share API call, and the options page drives the dialog.
// No live server — the fake implements the real contract (provisional create,
// activate/replace PATCH with Bearer + Idempotency-Key, conditional DELETE,
// public GET) and records the request log for ordering/zero-traffic proofs.
const EXTENSION_PATH = path.resolve("apps/extension/.output/chrome-mv3")
const SHARE_ID = "e2eShareManage00000001" // ShareIdSchema: exactly 22 chars
const MANAGE_SECRET = `e2eManage${"0".repeat(34)}` // ManageSecretSchema: exactly 43 chars
const SHARE_ORIGIN = "https://d-op.sasnews.dev"
const PLAYER = "https://animestore.docomo.ne.jp/animestore/sc_d_pc"
const NOW = "2026-09-20T00:00:00.000Z"

test.setTimeout(90_000)

// Canonical JSON (sorted keys, undefined dropped) — mirrors
// packages/shared/src/share-canonical.ts so the fake can sign contentHash.
function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
  }
  throw new Error("non-canonical value")
}

const hashOf = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")

type SeedItem = {
  id: string
  partId: string
  title: string
  episodeTitle: string
  episodeNumber?: string
  url?: string
  range: { start: number; end: number; name?: string } | null
}

function item(id: string, partId: string, episodeNumber: string): SeedItem {
  return {
    id,
    partId,
    title: "Fixture Work",
    episodeTitle: `第${episodeNumber}話`,
    episodeNumber,
    url: `${PLAYER}?partId=${partId}`,
    range: { start: 0, end: 90_000, name: "OP" },
  }
}

function v2State(seed: {
  playlists: { id: string; name: string; items: SeedItem[] }[]
  publications?: unknown[]
}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    revision: 0,
    playlists: seed.playlists,
    publications: seed.publications ?? [],
    pendingCreates: [],
    preferences: { windowMode: "tab", collapsedPlaylists: {} },
    appliedOperations: [],
    // Task 22: these specs exercise the Share flows — seed the explicit
    // consent grant the management/import gates now require.
    shareConsent: { choice: "granted", decidedAt: NOW },
  }
}

function detachedRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  }
}

type Remote = {
  shareId: string
  secret: string
  revision: number
  state: "pending" | "active"
  playlist: Record<string, unknown>
  contentHash: string
  createdAt: string
  updatedAt: string
  publishedAt?: string
}

type ApiCall = { method: string; path: string; key: string | undefined }

function apiJson(status: number, data: unknown) {
  return { status, contentType: "application/json", body: JSON.stringify({ data }) }
}

function apiError(status: number, code: string, details?: { revision: number }) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify({
      error: {
        code,
        message: `e2e ${code}`,
        requestId: "req-e2e",
        ...(details ? { details } : {}),
      },
    }),
  }
}

function handleShareApi(route: Route, remotes: Map<string, Remote>, log: ApiCall[]): Promise<void> {
  const request = route.request()
  const url = new URL(request.url())
  const match = /^\/api\/v1\/playlists(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname)
  const id = match?.[1]
  const headers = request.headers()
  log.push({ method: request.method(), path: url.pathname, key: headers["idempotency-key"] })
  const postBody = (): Record<string, unknown> =>
    JSON.parse(request.postData() ?? "{}") as Record<string, unknown>

  if (request.method() === "POST" && id === undefined) {
    const playlist = postBody() as unknown as Remote["playlist"]
    const remote: Remote = {
      shareId: SHARE_ID,
      secret: MANAGE_SECRET,
      revision: 1,
      state: "pending",
      playlist,
      contentHash: hashOf(playlist),
      createdAt: NOW,
      updatedAt: NOW,
    }
    remotes.set(SHARE_ID, remote)
    return route.fulfill(
      apiJson(201, {
        shareId: SHARE_ID,
        manageSecret: MANAGE_SECRET,
        revision: 1,
        contentHash: remote.contentHash,
        createdAt: NOW,
        activationExpiresAt: "2026-09-20T01:00:00.000Z",
        state: "pending",
      }),
    )
  }
  const remote = id === undefined ? undefined : remotes.get(id)
  if (request.method() === "GET" && id !== undefined) {
    if (remote === undefined || remote.state !== "active") {
      return route.fulfill(apiError(404, "NOT_FOUND"))
    }
    const items = remote.playlist["items"] as { range: { start: number; end: number } }[]
    return route.fulfill(
      apiJson(200, {
        shareId: remote.shareId,
        revision: remote.revision,
        publishedAt: remote.publishedAt ?? NOW,
        updatedAt: remote.updatedAt,
        contentHash: remote.contentHash,
        playlist: remote.playlist,
        itemCount: items.length,
        totalDurationMs: items.reduce(
          (sum, entry) => sum + (entry.range.end - entry.range.start),
          0,
        ),
        importCount: 0,
        source: null,
      }),
    )
  }
  if (remote === undefined) return route.fulfill(apiError(404, "NOT_FOUND"))
  const auth = headers["authorization"]
  if (auth !== `Bearer ${remote.secret}`) return route.fulfill(apiError(401, "UNAUTHORIZED"))
  if (request.method() === "PATCH") {
    const body = postBody()
    if (body["operation"] === "activate") {
      if (remote.state === "active" && remote.revision === 2) {
        return route.fulfill(
          apiJson(200, {
            shareId: remote.shareId,
            revision: remote.revision,
            contentHash: remote.contentHash,
            publishedAt: remote.publishedAt ?? NOW,
            updatedAt: remote.updatedAt,
          }),
        )
      }
      if (remote.state !== "pending" || body["expectedRevision"] !== 1) {
        return route.fulfill(apiError(409, "REVISION_CONFLICT", { revision: remote.revision }))
      }
      remote.state = "active"
      remote.revision = 2
      remote.publishedAt = NOW
      return route.fulfill(
        apiJson(200, {
          shareId: remote.shareId,
          revision: 2,
          contentHash: remote.contentHash,
          publishedAt: NOW,
          updatedAt: NOW,
        }),
      )
    }
    if (body["operation"] === "replace") {
      if (body["expectedRevision"] !== remote.revision) {
        return route.fulfill(apiError(409, "REVISION_CONFLICT", { revision: remote.revision }))
      }
      remote.revision += 1
      remote.playlist = body["playlist"] as Remote["playlist"]
      remote.contentHash = hashOf(remote.playlist)
      remote.updatedAt = "2026-09-20T02:00:00.000Z"
      return route.fulfill(
        apiJson(200, {
          shareId: remote.shareId,
          revision: remote.revision,
          contentHash: remote.contentHash,
          publishedAt: remote.publishedAt ?? NOW,
          updatedAt: remote.updatedAt,
        }),
      )
    }
    return route.fulfill(apiError(422, "SCHEMA_INVALID"))
  }
  if (request.method() === "DELETE") {
    const body = postBody()
    if (body["expectedRevision"] !== remote.revision) {
      return route.fulfill(apiError(409, "REVISION_CONFLICT", { revision: remote.revision }))
    }
    remotes.delete(remote.shareId)
    return route.fulfill({ status: 204 })
  }
  return route.fulfill(apiError(405, "METHOD_NOT_ALLOWED"))
}

type Launched = {
  readonly context: BrowserContext
  readonly worker: Worker
  readonly extensionId: string
  readonly apiLog: ApiCall[]
  readonly remotes: Map<string, Remote>
}

async function launchExtension(
  testInfo: TestInfo,
  seed: Parameters<typeof v2State>[0],
): Promise<Launched> {
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
  const apiLog: ApiCall[] = []
  const remotes = new Map<string, Remote>()
  // Catch-all abort registered FIRST — every external http(s) request dies
  // unless a newer specific route wins (Playwright checks newest first).
  await context.route(/^https?:\/\//, (route) => route.abort())
  // Specific Share API route registered LAST so it wins over the catch-all.
  await context.route(/\/api\/v1\/playlists/, (route) => handleShareApi(route, remotes, apiLog))
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 10_000 }))
  await worker.evaluate(`(async () => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set({ dop_v2_state: ${JSON.stringify(v2State(seed))} })
  })()`)
  const extensionId = new URL(worker.url()).hostname
  return { context, worker, extensionId, apiLog, remotes }
}

async function readVault(worker: Worker): Promise<{
  publications: {
    shareId: string
    localPlaylistId: string | null
    manageSecret: string
    revision: number
    state: string
  }[]
  pendingCreates: unknown[]
}> {
  return worker.evaluate(
    `chrome.storage.local.get("dop_v2_state").then((r) => r.dop_v2_state)`,
  ) as Promise<never>
}

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("share management: zero-traffic local ops, publish, dirty, update, conflict, delete", async ({}, testInfo) => {
  const { context, worker, extensionId, apiLog, remotes } = await launchExtension(testInfo, {
    playlists: [
      { id: "pl-1", name: "E2E Share", items: [item("a", "p1", "1"), item("b", "p2", "2")] },
    ],
  })
  try {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/options.html`)
    await expect(page.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })

    // --- Zero Share API traffic during ordinary local edits/playback -------
    const nameInput = page.locator(".playlist-name-input")
    await nameInput.fill("E2E Renamed")
    await nameInput.press("Tab") // blur commits the change listener
    await expect(nameInput).toHaveValue("E2E Renamed", { timeout: 10_000 })
    await page.locator(".playlist-card .btn-text", { hasText: "再生" }).click()
    // A transient write + REQUEST_PLAYER happen locally; the aborted player
    // navigation proves nothing share-related was attempted.
    await page.waitForTimeout(500)
    expect(apiLog).toEqual([])

    // --- Publish: explicit visibility required ------------------------------
    await page.locator(".playlist-card .share-open").click()
    const dialog = page.locator("#d-op-modal")
    await expect(dialog.locator(".share-dialog")).toBeVisible()
    const publishButton = dialog.locator(".share-publish")
    await expect(publishButton).toBeDisabled()
    await dialog.locator("input[name='dopShareVisibility'][value='public']").check()
    await expect(publishButton).toBeEnabled()
    await publishButton.click()
    await expect(dialog.locator(".share-url")).toHaveText(`${SHARE_ORIGIN}/p/${SHARE_ID}`, {
      timeout: 15_000,
    })
    await expect(dialog.locator(".share-state")).toContainText("公開中")
    // Request order: POST create (no auth) → PATCH activate (Bearer).
    expect(apiLog.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/v1/playlists",
      `PATCH /api/v1/playlists/${SHARE_ID}`,
    ])
    // The vault record persisted the key BEFORE activate and is now active.
    const vault = await readVault(worker)
    expect(vault.publications).toHaveLength(1)
    expect(vault.publications[0]).toMatchObject({
      shareId: SHARE_ID,
      localPlaylistId: "pl-1",
      manageSecret: MANAGE_SECRET,
      revision: 2,
      state: "active",
    })
    expect(vault.pendingCreates).toEqual([])
    // The page HTML never contains the secret.
    expect(await page.content()).not.toContain(MANAGE_SECRET)
    await dialog.locator("button", { hasText: "閉じる" }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator(".share-open")).toHaveText("共有中")

    // --- Dirty transition: a local rename flips the badge -------------------
    await nameInput.fill("E2E Renamed Again")
    await nameInput.press("Tab")
    await expect(page.locator(".share-open")).toHaveText("共有 (変更あり)", { timeout: 10_000 })
    expect(apiLog.filter((call) => call.method !== "GET")).toHaveLength(2) // still only POST+PATCH

    // --- Update: revision-guarded replace -----------------------------------
    await page.locator(".share-open").click()
    await expect(dialog.locator(".share-dirty")).toContainText("未公開の変更があります")
    // Opening reconciles remote state once (explicit open = the only GET).
    await expect(dialog.locator(".share-remote")).toContainText("公開中")
    await dialog.locator(".share-update").click()
    await expect(dialog.locator(".share-result")).toContainText("公開版を更新しました")
    expect(apiLog.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/v1/playlists",
      `PATCH /api/v1/playlists/${SHARE_ID}`,
      `GET /api/v1/playlists/${SHARE_ID}`,
      `PATCH /api/v1/playlists/${SHARE_ID}`,
    ])

    // --- Conflict: remote moved ahead → guarded retry overwrites ------------
    await dialog.locator("button", { hasText: "閉じる" }).click()
    await expect(dialog).toHaveCount(0)
    const conflictRemote = remotes.get(SHARE_ID)
    if (conflictRemote === undefined) throw new Error("remote not seeded")
    conflictRemote.revision = 9
    await nameInput.fill("E2E Conflict")
    await nameInput.press("Tab")
    await expect(page.locator(".share-open")).toHaveText("共有 (変更あり)", { timeout: 10_000 })
    await page.locator(".share-open").click()
    await expect(dialog.locator(".share-remote")).toContainText("公開中") // inspect: remote still active
    await dialog.locator(".share-update").click()
    await expect(dialog.locator(".share-result")).toContainText(
      "リモートの公開版が変更されています",
    )
    await dialog.locator(".share-update").click() // explicit overwrite retry
    await expect(dialog.locator(".share-result")).toContainText("公開版を更新しました")
    expect(remotes.get(SHARE_ID)?.revision).toBe(10)

    // --- Delete: inline confirmation → remote delete → key retired ----------
    await dialog.locator(".share-delete").click()
    await expect(dialog.locator(".share-confirm-delete")).toBeVisible()
    await dialog.locator(".share-confirm-delete").click()
    await expect(dialog).toHaveCount(0, { timeout: 10_000 })
    expect(apiLog.at(-1)?.method).toBe("DELETE")
    const after = await readVault(worker)
    expect(after.publications).toEqual([])
    // The local playlist survives remote deletion.
    await expect(page.locator(".playlist-card")).toHaveCount(1)
    expect(remotes.has(SHARE_ID)).toBe(false)
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("detached records stay manageable: remote inspect + remote delete", async ({}, testInfo) => {
  const { context, worker, extensionId, apiLog, remotes } = await launchExtension(testInfo, {
    playlists: [{ id: "pl-2", name: "Untouched", items: [item("x", "p9", "3")] }],
    publications: [detachedRecord()],
  })
  // The remote copy still exists even though the local playlist is gone.
  remotes.set(SHARE_ID, {
    shareId: SHARE_ID,
    secret: MANAGE_SECRET,
    revision: 2,
    state: "active",
    playlist: {
      schemaVersion: 1,
      title: "Detached",
      description: "",
      author: "",
      tags: [],
      visibility: "public",
      items: [
        {
          partId: "p1",
          title: "Work",
          episodeTitle: "Ep",
          range: { start: 0, end: 90_000, name: "OP" },
        },
      ],
    },
    contentHash: "b".repeat(64),
    createdAt: NOW,
    updatedAt: NOW,
  })
  try {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/options.html`)
    const row = page.locator("#managementList .management-row")
    await expect(row).toHaveCount(1, { timeout: 15_000 })
    await expect(row.locator(".management-id")).toHaveText(SHARE_ID)

    // Remote inspect reconciles status on demand.
    await row.locator(".management-inspect").click()
    await expect(row.locator(".management-remote")).toContainText("公開中", { timeout: 10_000 })
    expect(apiLog.map((call) => call.method)).toEqual(["GET"])

    // Remote delete needs the modal confirmation, then retires the record.
    await row.locator(".management-delete-remote").click()
    const modal = page.locator("#d-op-modal")
    await expect(modal).toBeVisible()
    await modal.locator("button", { hasText: "公開版を削除" }).click()
    await expect(row).toHaveCount(0, { timeout: 10_000 })
    expect(apiLog.map((call) => call.method)).toEqual(["GET", "DELETE"])
    expect((await readVault(worker)).publications).toEqual([])
    expect(remotes.has(SHARE_ID)).toBe(false)
  } finally {
    await context.close()
  }
})
