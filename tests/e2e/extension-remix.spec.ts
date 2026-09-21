import { createHash } from "node:crypto"
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

// Task-20 Remix provenance acceptance against the real unpacked WXT build
// (chrome-mv3). A synthetic Share API is served via route interception — the
// catch-all aborts everything else, so no production traffic ever leaves.
// The fake implements the real contract surface (per-share management
// secrets, provisional create, activate/replace PATCH, conditional DELETE,
// public GET with parent-visibility source projection). Flow under test:
// import a public share → edit the local copy → republish — which must mint
// a NEW shareId + NEW manageSecret and record derivedFrom {shareId,
// revision} of the imported snapshot. Ownership stays disjoint: the child's
// key cannot touch the source and no local key manages the source at all.

const EXTENSION_PATH = path.resolve("apps/extension/.output/chrome-mv3")
const SHARE_PAGE_JS = path.resolve("apps/web/public/share-page.js")
const ORIGIN = "https://d-op.sasnews.dev"
const NOW = "2026-09-20T00:00:00.000Z"
const PARENT_ID = "e2eRemixParent00000001" // ShareIdSchema: exactly 22 chars
const PARENT_SECRET = `e2eParent${"0".repeat(34)}` // ManageSecretSchema: 43 chars
const PARENT_TITLE = "e2eremix元リスト"
const PARENT_REVISION = 3

test.setTimeout(120_000)

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

type ApiCall = {
  method: string
  path: string
  auth: string | undefined
  body: Record<string, unknown> | undefined
}

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

/** Fresh capability pair per create — a republish is always a NEW share. */
let mintCounter = 0
function mintShare(): { shareId: string; secret: string } {
  mintCounter += 1
  return {
    shareId: `e2eRemixMint${String(mintCounter).padStart(10, "0")}`,
    secret: `e2eMint${String(mintCounter).padStart(36, "0")}`,
  }
}

/** Public GET payload with the task-20 read-time source projection. */
function publicPayload(remote: Remote, remotes: Map<string, Remote>) {
  const derived = remote.playlist["derivedFrom"] as
    | { shareId: string; revision: number }
    | undefined
  const parent = derived === undefined ? undefined : remotes.get(derived.shareId)
  const parentPublic =
    parent !== undefined && parent.state === "active" && parent.playlist["visibility"] === "public"
  const items = remote.playlist["items"] as { range: { start: number; end: number } }[]
  const playlist = { ...remote.playlist }
  if (!parentPublic) delete playlist["derivedFrom"]
  return {
    shareId: remote.shareId,
    revision: remote.revision,
    publishedAt: remote.publishedAt ?? NOW,
    updatedAt: remote.updatedAt,
    contentHash: remote.contentHash,
    playlist,
    itemCount: items.length,
    totalDurationMs: items.reduce((sum, entry) => sum + (entry.range.end - entry.range.start), 0),
    importCount: 0,
    source: parentPublic ? derived : null,
  }
}

function handleShareApi(route: Route, remotes: Map<string, Remote>, log: ApiCall[]): Promise<void> {
  const request = route.request()
  const url = new URL(request.url())
  const match = /^\/api\/v1\/playlists(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname)
  const id = match?.[1]
  const headers = request.headers()
  const body =
    request.method() === "POST" || request.method() === "PATCH" || request.method() === "DELETE"
      ? (JSON.parse(request.postData() ?? "{}") as Record<string, unknown>)
      : undefined
  log.push({
    method: request.method(),
    path: url.pathname,
    auth: headers["authorization"],
    body,
  })

  if (request.method() === "POST" && url.pathname.endsWith("/import")) {
    return route.fulfill({ status: 204 })
  }
  if (request.method() === "POST" && id === undefined) {
    const minted = mintShare()
    const remote: Remote = {
      shareId: minted.shareId,
      secret: minted.secret,
      revision: 1,
      state: "pending",
      playlist: body as unknown as Remote["playlist"],
      contentHash: hashOf(body),
      createdAt: NOW,
      updatedAt: NOW,
    }
    remotes.set(minted.shareId, remote)
    return route.fulfill(
      apiJson(201, {
        shareId: minted.shareId,
        manageSecret: minted.secret,
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
    return route.fulfill(apiJson(200, publicPayload(remote, remotes)))
  }
  if (remote === undefined) return route.fulfill(apiError(404, "NOT_FOUND"))
  const bearer = headers["authorization"]?.startsWith("Bearer ")
    ? headers["authorization"].slice(7)
    : undefined
  if (bearer !== remote.secret) return route.fulfill(apiError(401, "UNAUTHORIZED"))
  if (request.method() === "PATCH") {
    if (body?.["operation"] === "activate") {
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
    if (body?.["operation"] === "replace") {
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
    if (body?.["expectedRevision"] !== remote.revision) {
      return route.fulfill(apiError(409, "REVISION_CONFLICT", { revision: remote.revision }))
    }
    remotes.delete(remote.shareId)
    return route.fulfill({ status: 204 })
  }
  return route.fulfill(apiError(405, "METHOD_NOT_ALLOWED"))
}

function sharePageHtml(shareId: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body>
    <button type="button" data-share-save data-share-id="${shareId}" disabled
      aria-disabled="true" data-testid="save-open-button">d-OP で開く</button>
    <p data-share-save-status data-testid="save-status">拡張機能が見つかりません。</p>
    <script src="/share-page.js" defer></script>
  </body></html>`
}

function v2State(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    revision: 0,
    playlists: [],
    publications: [],
    pendingCreates: [],
    preferences: { windowMode: "tab", collapsedPlaylists: {} },
    appliedOperations: [],
  }
}

type Rig = {
  readonly context: BrowserContext
  readonly worker: Worker
  readonly extensionId: string
}

/**
 * One extension installation. `remotes`/`apiLog` are shared across rigs so a
 * second context can pose as the SOURCE OWNER's separate client against the
 * same fake server — the ownership-disjointness check needs exactly that.
 */
async function launch(
  testInfo: TestInfo,
  name: string,
  seed: Record<string, unknown>,
  remotes: Map<string, Remote>,
  apiLog: ApiCall[],
): Promise<Rig> {
  const context = await chromium.launchPersistentContext(testInfo.outputPath(`profile-${name}`), {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  })
  // Catch-all abort FIRST — nothing real leaves the box.
  await context.route(/^https?:\/\//, (route) => route.abort())
  await context.route(/\/api\/v1\/playlists/, (route) => handleShareApi(route, remotes, apiLog))
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
      body: sharePageHtml(route.request().url().split("/").pop() ?? PARENT_ID),
    }),
  )
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 10_000 }))
  // The repository caches the migrated state on first read — seed storage
  // BEFORE any page opens so the vault starts from exactly this document.
  await worker.evaluate(
    `(async () => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set(${JSON.stringify(seed)})
    })()`,
  )
  const extensionId = new URL(worker.url()).hostname
  return { context, worker, extensionId }
}

function seededParentRemote(): Remote {
  return {
    shareId: PARENT_ID,
    secret: PARENT_SECRET,
    revision: PARENT_REVISION,
    state: "active",
    playlist: {
      schemaVersion: 1,
      title: PARENT_TITLE,
      description: "e2e remix source",
      author: "e2e-source",
      tags: ["e2eremix"],
      visibility: "public",
      items: [
        {
          partId: "part_src_a",
          title: "元作品A",
          episodeTitle: "第1話",
          episodeNumber: "1",
          range: { start: 0, end: 90_000, name: "OP" },
        },
        {
          partId: "part_src_b",
          title: "元作品B",
          episodeTitle: "第2話",
          range: { start: 5_000, end: 95_000, name: "ED" },
        },
      ],
    },
    contentHash: "a".repeat(64),
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: NOW,
  }
}

function readState(worker: Worker) {
  return worker.evaluate(
    `(async () => chrome.storage.local.get(["dop_v2_state", "dop_v2_imports"]))()`,
  ) as Promise<Record<string, unknown>>
}

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("import → edit → republish mints a fresh share+key and links the source revision", async ({}, testInfo) => {
  const remotes = new Map<string, Remote>()
  // The parent is already published — the extension never learns its secret.
  remotes.set(PARENT_ID, seededParentRemote())
  const apiLog: ApiCall[] = []
  const rig = await launch(testInfo, "primary", { dop_v2_state: v2State() }, remotes, apiLog)
  try {
    // --- Import the public parent via the share page + confirm popup -------
    const sharePage = await rig.context.newPage()
    await sharePage.goto(`${ORIGIN}/p/${PARENT_ID}`)
    const saveButton = sharePage.locator("[data-testid='save-open-button']")
    await expect(saveButton).toBeEnabled({ timeout: 15_000 })
    const popupPromise = rig.context.waitForEvent("page", {
      predicate: (page: Page) =>
        page.url().startsWith(`chrome-extension://${rig.extensionId}/import.html`),
      timeout: 15_000,
    })
    await saveButton.click()
    const popup = await popupPromise
    await expect(popup.locator("[data-testid='import-title']")).toHaveText(PARENT_TITLE)
    await popup.locator("[data-testid='import-confirm']").click()
    await expect(popup.locator("[data-testid='import-status']")).toContainText("保存しました")

    let stored = await readState(rig.worker)
    let state = stored["dop_v2_state"] as {
      playlists: { id: string; name: string }[]
      publications: unknown[]
    }
    expect(state.playlists).toHaveLength(1)
    expect(state.publications).toEqual([])
    const playlistId = state.playlists[0]?.id ?? ""
    const imports = stored["dop_v2_imports"] as {
      records: { playlistId: string; shareId: string; revision: number }[]
    }
    expect(imports.records).toHaveLength(1)
    // Private provenance: the EXACT imported revision, decoupled from any key.
    expect(imports.records[0]).toMatchObject({
      playlistId,
      shareId: PARENT_ID,
      revision: PARENT_REVISION,
    })
    expect(JSON.stringify(imports)).not.toContain(PARENT_SECRET)

    // --- Edit the imported copy locally, then republish --------------------
    const options = await rig.context.newPage()
    await options.goto(`chrome-extension://${rig.extensionId}/options.html`)
    await expect(options.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })
    const nameInput = options.locator(".playlist-name-input")
    await nameInput.fill("e2eremix 改変版")
    await nameInput.press("Tab")

    await options.locator(".playlist-card .share-open").click()
    const dialog = options.locator("#d-op-modal")
    await expect(dialog.locator(".share-dialog")).toBeVisible()
    // The first-publish dialog honestly previews the provenance link.
    await expect(dialog.locator(".share-source-line")).toContainText("リンクが記録されます", {
      timeout: 10_000,
    })
    await dialog.locator("input[name='dopShareVisibility'][value='public']").check()
    await dialog.locator(".share-publish").click()
    await expect(dialog.locator(".share-result")).toContainText("リンクを記録しました", {
      timeout: 15_000,
    })

    // Request order: GET parent (visibility check) → POST create → PATCH activate.
    // The import flow and dialog preview also GET the parent — lastIndexOf
    // picks the authoritative publish-time check directly before create.
    const calls = apiLog.map((entry) => `${entry.method} ${entry.path}`)
    const importNotify = calls.indexOf(`POST /api/v1/playlists/${PARENT_ID}/import`)
    const parentCheck = calls.lastIndexOf(`GET /api/v1/playlists/${PARENT_ID}`)
    const createIndex = calls.indexOf("POST /api/v1/playlists")
    expect(parentCheck).toBeGreaterThan(importNotify)
    expect(createIndex).toBeGreaterThan(parentCheck)
    const createCall = apiLog[createIndex]
    expect(createCall?.auth).toBeUndefined()
    // The public payload carries the exact imported source revision.
    const sentPlaylist = createCall?.body as Record<string, unknown>
    expect(sentPlaylist["derivedFrom"]).toEqual({ shareId: PARENT_ID, revision: PARENT_REVISION })
    expect(sentPlaylist["title"]).toBe("e2eremix 改変版")

    // Republish = NEW shareId + NEW manageSecret, never the parent's.
    const child = [...remotes.values()].find((remote) => remote.shareId !== PARENT_ID)
    if (child === undefined) throw new Error("child remote was not created")
    expect(child.shareId).not.toBe(PARENT_ID)
    expect(child.secret).not.toBe(PARENT_SECRET)
    expect(child.state).toBe("active")
    const activateCall = apiLog.find(
      (entry) => entry.method === "PATCH" && entry.path === `/api/v1/playlists/${child.shareId}`,
    )
    expect(activateCall?.auth).toBe(`Bearer ${child.secret}`)

    stored = await readState(rig.worker)
    state = stored["dop_v2_state"] as {
      playlists: { id: string; name: string }[]
      publications: {
        shareId: string
        localPlaylistId: string | null
        manageSecret: string
        revision: number
        state: string
      }[]
    }
    expect(state.publications).toHaveLength(1)
    expect(state.publications[0]).toMatchObject({
      shareId: child.shareId,
      localPlaylistId: playlistId,
      manageSecret: child.secret,
      revision: 2,
      state: "active",
    })
    // The imported playlist survives untouched; provenance is still private.
    expect(state.playlists[0]?.name).toBe("e2eremix 改変版")
    expect((stored["dop_v2_imports"] as { records: unknown[] }).records).toHaveLength(1)

    // --- Disjoint ownership ------------------------------------------------
    // The child owner holds NO capability for the source: a management call
    // against the parent answers not-found without any remote request.
    const before = apiLog.length
    const noKey = await options.evaluate(
      `(async () => chrome.runtime.sendMessage(${JSON.stringify({
        kind: "share-manage-delete",
        shareId: PARENT_ID,
        operationId: crypto.randomUUID(),
      })}))()`,
    )
    expect(noKey).toMatchObject({ kind: "share-manage-result", status: "not-found" })
    expect(apiLog.length).toBe(before) // no network call was made
    const html = await options.content()
    expect(html).not.toContain(PARENT_SECRET)
  } finally {
    await rig.context.close()
  }

  // The source owner's key cannot manage the child: a SECOND installation
  // (the source owner's client) holds a vault record armed with the PARENT
  // secret for the child shareId. A real delete through the full stack is
  // rejected by the server and the child remote survives.
  const childRemote = [...remotes.values()].find((remote) => remote.shareId !== PARENT_ID)
  if (childRemote === undefined) throw new Error("child remote was not created")
  const forgedState = {
    ...v2State(),
    publications: [
      {
        shareId: childRemote.shareId,
        localPlaylistId: null,
        manageSecret: PARENT_SECRET,
        revision: 2,
        contentHash: "b".repeat(64),
        sentSnapshot: "{}",
        acknowledgedHash: "b".repeat(64),
        visibility: "public",
        createdAt: NOW,
        updatedAt: NOW,
        state: "local-deleted",
      },
    ],
  }
  const sourceOwner = await launch(
    testInfo,
    "source-owner",
    { dop_v2_state: forgedState },
    remotes,
    apiLog,
  )
  try {
    const page = await sourceOwner.context.newPage()
    await page.goto(`chrome-extension://${sourceOwner.extensionId}/options.html`)
    const denied = await page.evaluate(
      `(async () => chrome.runtime.sendMessage(${JSON.stringify({
        kind: "share-manage-delete",
        shareId: childRemote.shareId,
        operationId: crypto.randomUUID(),
      })}))()`,
    )
    expect(denied).toMatchObject({ kind: "share-manage-result", status: "failed" })
    // The child remote still exists — the parent's key managed nothing.
    expect(remotes.has(childRemote.shareId)).toBe(true)
    expect(remotes.get(PARENT_ID)?.state).toBe("active")
  } finally {
    await sourceOwner.context.close()
  }
})
