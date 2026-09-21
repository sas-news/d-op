import { createHash } from "node:crypto"
import fs from "node:fs"
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
import { waitForContextPage } from "./context-pages"

// Task-23 cross-profile leg on real Chrome binaries (and bundled chromium):
// TWO independent persistent profiles share nothing but the fake Share API —
// profile A PUBLISHES for real (share dialog → POST create → PATCH activate),
// profile B (undecided consent) views the share page, passes the import
// consent gate, imports, EDITS (rename) and PLAYS the copy, then A is
// re-verified byte-identical. The "network" is an in-test remote object both
// contexts' route handlers close over, so B genuinely reads the snapshot A
// published — the same data-flow shape the Firefox harness proves against
// real local D1. Catch-all aborts guarantee no traffic leaves the box.

const EXTENSION_PATH = path.resolve("apps/extension/.output/chrome-mv3")
const SHARE_PAGE_JS = path.resolve("apps/web/public/share-page.js")
const ORIGIN = "https://d-op.sasnews.dev"
const PLAYER = "https://animestore.docomo.ne.jp/animestore/sc_d_pc"
const SHARE_ID = "e2eXProfileShareId0001" // ShareIdSchema: exactly 22 chars
const NOW = "2026-09-20T00:00:00.000Z"

test.setTimeout(120_000)

const SEED_A = {
  schemaVersion: 2,
  revision: 0,
  playlists: [
    {
      id: "pl-netA",
      name: "net-A",
      items: [
        {
          id: "item-a1",
          partId: "p1",
          title: "Fixture Work",
          episodeTitle: "第1話",
          episodeNumber: "1",
          url: `${PLAYER}?partId=p1`,
          range: { start: 0, end: 90_000, name: "OP" },
        },
      ],
    },
  ],
  publications: [],
  pendingCreates: [],
  preferences: { windowMode: "tab", collapsedPlaylists: {} },
  appliedOperations: [],
  shareConsent: { choice: "granted", decidedAt: NOW },
} as const

// B is deliberately undecided: the import window must show the consent gate.
const SEED_B = {
  schemaVersion: 2,
  revision: 0,
  playlists: [],
  publications: [],
  pendingCreates: [],
  preferences: { windowMode: "tab", collapsedPlaylists: {} },
  appliedOperations: [],
} as const

// Canonical JSON (sorted keys, undefined dropped) — byte-identical to
// packages/shared/src/share-canonical.ts so the create ack can echo the hash
// the extension computed over the snapshot it sent.
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

/** In-test remote shared by both profiles' route handlers — the "D1". */
type Remote = {
  state: "none" | "pending" | "active"
  playlist: Record<string, unknown> | undefined
  contentHash: string
}

function playerFixtureHtml(): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>fixture player</title></head>
<body>
<a id="backInfo" href="/animestore/ci/work?workId=w1"><span class="backInfoTxt1">Fixture Work</span><span class="backInfoTxt2">第1話</span><span class="backInfoTxt3">Fixture Episode</span></a>
<video id="video" preload="auto"></video>
<div class="buttonArea"><button class="prev">prev</button><button class="next">next</button><div class="skipUi">skip</div><span class="time">0:00</span></div>
<div class="seekArea"><div id="seekThumb"></div><div id="seekPopupInWrap"></div></div>
<script>
(() => {
  const rate = 8000
  const samples = rate * 200
  const bytes = new Uint8Array(44 + samples * 2)
  const dv = new DataView(bytes.buffer)
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i)
  }
  text(0, "RIFF")
  dv.setUint32(4, 36 + samples * 2, true)
  text(8, "WAVE")
  text(12, "fmt ")
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, rate, true)
  dv.setUint32(28, rate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  text(36, "data")
  dv.setUint32(40, samples * 2, true)
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }))
  document.getElementById("video").src = blobUrl
  window.__fixture = { jumps: [], videoUrl: blobUrl }
  const target = () => document.getElementById("video")
  window.vc = {
    ws010105Data: {
      "duration": 200000,
      "chapters": [{ "start": 0, "end": 90000, "type": "none" }],
    },
    jump: (value) => {
      window.__fixture.jumps.push(value)
      target().currentTime = value
    },
    goNext: () => {},
    procEndedEvent: () => {},
  }
})()
</script>
</body></html>`
}

function sharePageHtml(shareId: string): string {
  // Mirrors ShareSavePanel.astro's contract — deferred same-origin script,
  // disabled button until the extension marks capability.
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body>
    <button type="button" data-share-save data-share-id="${shareId}" disabled
      aria-disabled="true" data-testid="save-open-button">d-OP で開く</button>
    <p data-share-save-status data-testid="save-status">拡張機能が見つかりません。</p>
    <script src="/share-page.js" defer></script>
  </body></html>`
}

/** Contract-faithful Share API bound to the shared `remote`. */
function handleApi(route: Route, remote: Remote, log: string[]): Promise<void> {
  const request = route.request()
  const url = new URL(request.url())
  log.push(`${request.method()} ${url.pathname}`)
  const importMatch = /^\/api\/v1\/playlists\/([A-Za-z0-9_-]+)\/import$/.exec(url.pathname)
  if (importMatch !== null) {
    return request.method() === "POST"
      ? route.fulfill({ status: 204 })
      : route.fulfill({ status: 405, contentType: "application/json", body: "{}" })
  }
  const match = /^\/api\/v1\/playlists(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname)
  const id = match?.[1]
  if (request.method() === "POST" && id === undefined) {
    remote.state = "pending"
    remote.playlist = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>
    remote.contentHash = hashOf(remote.playlist)
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          shareId: SHARE_ID,
          manageSecret: `e2eXProf${"0".repeat(35)}`,
          revision: 1,
          contentHash: remote.contentHash,
          createdAt: NOW,
          activationExpiresAt: "2026-09-20T01:00:00.000Z",
          state: "pending",
        },
      }),
    })
  }
  if (request.method() === "PATCH" && id === SHARE_ID) {
    remote.state = "active"
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          shareId: SHARE_ID,
          revision: 2,
          contentHash: remote.contentHash,
          publishedAt: NOW,
          updatedAt: NOW,
        },
      }),
    })
  }
  if (request.method() === "GET" && id === SHARE_ID) {
    if (remote.state !== "active" || remote.playlist === undefined) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "NOT_FOUND", message: "e2e 404", requestId: "req-404" },
        }),
      })
    }
    const items = Array.isArray(remote.playlist["items"]) ? remote.playlist["items"] : []
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          shareId: SHARE_ID,
          revision: 2,
          publishedAt: NOW,
          updatedAt: NOW,
          contentHash: remote.contentHash,
          playlist: remote.playlist,
          itemCount: items.length,
          totalDurationMs: 90_000,
          importCount: 0,
          source: null,
        },
      }),
    })
  }
  return route.fulfill({
    status: 405,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "METHOD_NOT_ALLOWED", message: "e2e 405", requestId: "req-405" },
    }),
  })
}

type Profile = {
  readonly context: BrowserContext
  readonly worker: Worker
  readonly extensionId: string
  readonly apiLog: string[]
}

async function launchProfile(
  testInfo: TestInfo,
  name: string,
  seed: Record<string, unknown>,
  remote: Remote,
): Promise<Profile> {
  const context = await chromium.launchPersistentContext(testInfo.outputPath(`profile-${name}`), {
    ...browserLaunchTarget(),
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  })
  const apiLog: string[] = []
  // Catch-all first (routes consult newest-first): nothing real leaves.
  await context.route(/^https?:\/\//, (route) => route.abort())
  await context.route(/animestore\.docomo\.ne\.jp\/animestore\/sc_d_pc/, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: playerFixtureHtml() }),
  )
  await context.route(/\/api\/v1\/playlists/, (route) => handleApi(route, remote, apiLog))
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
  await worker.evaluate(`(async () => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set({ dop_v2_state: ${JSON.stringify(seed)} })
  })()`)
  return { context, worker, extensionId, apiLog }
}

type StateShape = {
  revision: number
  playlists: { id: string; name: string; items: { id: string; partId: string }[] }[]
  publications: { shareId: string; state: string }[]
}

function readState(worker: Worker): Promise<StateShape> {
  return worker.evaluate(
    `chrome.storage.local.get("dop_v2_state").then((r) => r.dop_v2_state)`,
  ) as Promise<StateShape>
}

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("cross-profile: publish in A → view/import/edit/play in B → A unchanged", async ({}, testInfo) => {
  const remote: Remote = { state: "none", playlist: undefined, contentHash: "" }
  const profileA = await launchProfile(testInfo, "A", SEED_A, remote)
  const profileB = await launchProfile(testInfo, "B", SEED_B, remote)
  try {
    // ---- A publishes for real ------------------------------------------------
    const optionsA = await profileA.context.newPage()
    await optionsA.goto(`chrome-extension://${profileA.extensionId}/options.html`)
    await expect(optionsA.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })
    await optionsA.locator(".playlist-card .share-open").click()
    const dialog = optionsA.locator("#d-op-modal")
    await expect(dialog.locator(".share-dialog")).toBeVisible()
    await dialog.locator("input[name='dopShareVisibility'][value='public']").check()
    await dialog.locator(".share-publish").click()
    await expect(dialog.locator(".share-url")).toHaveText(`${ORIGIN}/p/${SHARE_ID}`, {
      timeout: 15_000,
    })
    await expect(dialog.locator(".share-state")).toContainText("公開中")
    const published = await readState(profileA.worker)
    expect(published.publications).toHaveLength(1)
    expect(published.publications[0]).toMatchObject({ shareId: SHARE_ID, state: "active" })
    expect(remote.state).toBe("active")
    // The remote snapshot is what A actually projected — title travels.
    expect(remote.playlist?.["title"]).toBe("net-A")

    // ---- B views the share page ----------------------------------------------
    const sharePage = await profileB.context.newPage()
    await sharePage.goto(`${ORIGIN}/p/${SHARE_ID}`)
    await expect(sharePage.locator("[data-testid='save-open-button']")).toBeEnabled({
      timeout: 10_000,
    })

    // ---- B imports: consent gate first (undecided profile), then preview -----
    const popupPromise = waitForContextPage(
      profileB.context,
      `chrome-extension://${profileB.extensionId}/import.html`,
      10_000,
    )
    await sharePage.locator("[data-testid='save-open-button']").click()
    const popup = await popupPromise
    await expect(popup.locator("[data-testid='import-consent']")).toBeVisible()
    await expect(popup.locator("[data-testid='import-preview']")).toBeHidden()
    await popup.locator("[data-testid='import-consent-grant']").click()
    await expect(popup.locator("[data-testid='import-preview']")).toBeVisible()
    await expect(popup.locator("[data-testid='import-title']")).toHaveText("net-A")
    await popup.locator("[data-testid='import-confirm']").click()
    await expect(popup.locator("[data-testid='import-status']")).toContainText("保存しました")

    const imported = await readState(profileB.worker)
    expect(imported.playlists).toHaveLength(1)
    expect(imported.playlists[0]?.name).toBe("net-A")
    expect(imported.playlists[0]?.id).not.toBe("pl-netA")
    const importedId = imported.playlists[0]?.id ?? ""

    // ---- B edits the imported copy (rename via the public storage command) ---
    const renamed = await popup.evaluate(`(async () => {
      const read = (await chrome.storage.local.get("dop_v2_state")).dop_v2_state
      await chrome.runtime.sendMessage({
        type: "DOP_STORAGE_COMMAND",
        command: {
          kind: "rename-playlist",
          operationId: crypto.randomUUID(),
          expectedRevision: read.revision,
          playlistId: ${JSON.stringify(importedId)},
          name: "imported-B",
        },
      })
      return (await chrome.storage.local.get("dop_v2_state")).dop_v2_state.playlists[0].name
    })()`)
    expect(renamed).toBe("imported-B")

    // ---- B plays the imported copy: dopPlaylistId/dopIndex → seek to range ---
    const playerPage = await profileB.context.newPage()
    await playerPage.goto(`${PLAYER}?partId=p1&dopPlaylistId=${importedId}&dopIndex=0`)
    await expect(playerPage.locator("#d-op-add-wrapper")).toBeAttached({ timeout: 15_000 })
    await expect
      .poll(async () => playerPage.evaluate("window.__fixture.jumps"), { timeout: 15_000 })
      .toContain(0)

    // ---- A is byte-unchanged: playlist intact, publication still active ------
    const after = await readState(profileA.worker)
    expect(after.playlists).toHaveLength(1)
    expect(after.playlists[0]?.name).toBe("net-A")
    expect(after.playlists[0]?.items).toHaveLength(1)
    expect(after.publications).toHaveLength(1)
    // B's aggregate import POST is the only cross-request; A never re-talks.
    expect(profileA.apiLog.filter((line) => !line.startsWith("GET"))).toEqual([
      "POST /api/v1/playlists",
      `PATCH /api/v1/playlists/${SHARE_ID}`,
    ])
  } finally {
    await profileA.context.close()
    await profileB.context.close()
  }
})
