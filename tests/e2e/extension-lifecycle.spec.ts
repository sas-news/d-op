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
import { browserLaunchTarget } from "./browser-target"

// Task-23 lifecycle/failure legs on the real unpacked build (chrome-mv3; under
// DOP_BROWSER_EXECUTABLE this same file runs on a real Chrome/Chrome-for-
// Testing binary — see tests/browser/chrome-harness.mjs). Covers what the
// happy-path specs deliberately skip:
//   * service-worker kill → wake-on-demand with intact storage (sleep/restart)
//   * chrome://extensions disable→enable → stale-context invalidation without
//     corruption (extension update invalidation; chrome.runtime.reload()
//     permanently unloads --load-extension builds under Playwright, so the
//     real UI toggle is the honest update-equivalent on Chromium)
//   * Share API 503 → bounded error, no partial publication, retry succeeds
//   * delayed/absent player adapter → bounded recovery, no orphan UI
//   * browser close → persistent profile keeps every playlist byte
const EXTENSION_PATH = path.resolve("apps/extension/.output/chrome-mv3")
const EVIDENCE_DIR = path.resolve(".omo/evidence/task-23-d-op-v2-share")
const PLAYER = "https://animestore.docomo.ne.jp/animestore/sc_d_pc"
const VIDEO_SECONDS = 200

test.setTimeout(90_000)

const SEED_STATE = {
  schemaVersion: 2,
  revision: 0,
  playlists: [
    {
      id: "pl-life",
      name: "Lifecycle List",
      items: [
        {
          id: "item-1",
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
  // Task 22: publish legs need explicit Share consent seeded (undecided
  // blocks every management call with consent-required).
  shareConsent: { choice: "granted", decidedAt: "2026-09-20T00:00:00.000Z" },
} as const

// Same sc_d_pc shape as extension-parity.spec.ts; `?vcDelay=<ms>` defers the
// window.vc contract to prove the adapter's bounded polling recovers when the
// page's player object is blocked/late (R5 500 ms × 30).
function playerFixtureHtml(vcDelayMs = 0): string {
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
  const seconds = ${VIDEO_SECONDS}
  const samples = rate * seconds
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
  const installVc = () => {
    window.vc = {
      ws010105Data: {
        "duration": ${VIDEO_SECONDS * 1000},
        "chapters": [{ "start": 0, "end": 90000, "type": "none" }],
      },
      jump: (value) => {
        window.__fixture.jumps.push(value)
        target().currentTime = value
      },
      goNext: () => {},
      procEndedEvent: () => {},
    }
  }
  const delay = ${vcDelayMs}
  if (delay > 0) setTimeout(installVc, delay)
  else installVc()
})()
</script>
</body></html>`
}

type Launched = {
  readonly context: BrowserContext
  readonly worker: Worker
  readonly extensionId: string
  readonly setApi503: (fail: boolean) => void
}

const SHARE_ID = "e2eLifecycleShareId001" // ShareIdSchema: exactly 22 chars
const NOW = "2026-09-20T00:00:00.000Z"

// Canonical JSON (sorted keys, undefined dropped) — mirrors
// packages/shared/src/share-canonical.ts so the fake can sign contentHash;
// the extension rejects an ack whose hash does not match the sent snapshot.
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

/** Minimal real-contract Share API: create → pending 201, activate PATCH →
 * active revision 2, public GET → snapshot. 503 mode short-circuits first so
 * the publish leg can flip availability mid-test. */
function handleContractApi(
  route: Route,
  remote: { state: "pending" | "active"; contentHash: string },
): Promise<void> {
  const request = route.request()
  const url = new URL(request.url())
  const match = /^\/api\/v1\/playlists(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname)
  const id = match?.[1]
  if (request.method() === "POST" && id === undefined) {
    remote.state = "pending"
    // The ack must echo the hash of the snapshot the extension actually sent.
    remote.contentHash = hashOf(JSON.parse(request.postData() ?? "{}"))
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          shareId: SHARE_ID,
          manageSecret: `e2eLife${"0".repeat(36)}`,
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
    if (remote.state !== "active") {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "NOT_FOUND", message: "e2e 404", requestId: "req-404" },
        }),
      })
    }
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
          playlist: {
            schemaVersion: 1,
            title: "Lifecycle List",
            description: "",
            author: "",
            tags: [],
            visibility: "public",
            items: [
              {
                partId: "p1",
                title: "Fixture Work",
                episodeTitle: "第1話",
                episodeNumber: "1",
                range: { start: 0, end: 90_000, name: "OP" },
              },
            ],
          },
          itemCount: 1,
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

async function launchExtension(testInfo: TestInfo): Promise<Launched> {
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
  let api503 = false
  await context.route(/^https?:\/\//, (route) => route.abort())
  await context.route(/animestore\.docomo\.ne\.jp\/animestore\/sc_d_pc/, (route) => {
    const vcDelay = Number(new URL(route.request().url()).searchParams.get("vcDelay") ?? "0")
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: playerFixtureHtml(Number.isFinite(vcDelay) ? vcDelay : 0),
    })
  })
  // Share API: 503 switchblade first, then the real contract.
  const remote = { state: "pending" as "pending" | "active", contentHash: "" }
  await context.route(/\/api\/v1\/playlists/, (route) => {
    if (api503) {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNAVAILABLE", message: "e2e 503", requestId: "req-503" },
        }),
      })
    }
    return handleContractApi(route, remote)
  })
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 10_000 }))
  await worker.evaluate(`(async () => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set({ dop_v2_state: ${JSON.stringify(SEED_STATE)} })
  })()`)
  const extensionId = new URL(worker.url()).hostname
  return {
    context,
    worker,
    extensionId,
    setApi503: (fail) => {
      api503 = fail
    },
  }
}

function readState(worker: Worker) {
  return worker.evaluate(
    `chrome.storage.local.get("dop_v2_state").then((r) => r.dop_v2_state)`,
  ) as Promise<{
    revision: number
    playlists: { id: string; name: string; items: unknown[] }[]
    publications: unknown[]
  }>
}

type StateShape = {
  revision: number
  playlists: { id: string; name: string; items: unknown[] }[]
  publications: unknown[]
}

/** Extension pages share chrome.storage.local with the background — usable
 *  where a Worker handle is unreliable (post-kill/respawn on real Chrome). */
function readStateViaPage(page: Page) {
  return page.evaluate(
    `chrome.storage.local.get("dop_v2_state").then((r) => r.dop_v2_state)`,
  ) as Promise<StateShape>
}

function evidence(name: string): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  return path.join(EVIDENCE_DIR, name)
}

/** Kills the extension's service_worker target via real CDP — the abrupt
 * equivalent of Chrome's 30 s idle suspension. Returns the target id. */
async function killExtensionServiceWorker(
  context: BrowserContext,
  pageUrl: string,
): Promise<string> {
  const page = context.pages().find((p) => p.url() === pageUrl) ?? (await context.newPage())
  const cdp = await context.newCDPSession(page)
  const targets = new Map<string, { targetId: string; type: string; url: string }>()
  cdp.on("Target.targetCreated", ({ targetInfo }) => targets.set(targetInfo.targetId, targetInfo))
  cdp.on("Target.targetInfoChanged", ({ targetInfo }) =>
    targets.set(targetInfo.targetId, targetInfo),
  )
  cdp.on("Target.targetDestroyed", ({ targetId }) => targets.delete(targetId))
  await cdp.send("Target.setDiscoverTargets", { discover: true })
  const sw = [...targets.values()].find(
    (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"),
  )
  if (sw === undefined) throw new Error("extension service_worker target not found")
  await cdp.send("Target.closeTarget", { targetId: sw.targetId })
  return sw.targetId
}

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("service-worker kill: next command wakes a fresh worker, storage intact", async ({}, testInfo) => {
  const { context, worker, extensionId } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/options.html`)
    await expect(page.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })

    // Abrupt SW termination (≈ idle sleep, but deterministic).
    await killExtensionServiceWorker(context, page.url())

    // The old Playwright worker handle is dead: evaluate never resolves.
    const stale = await Promise.race([
      worker.evaluate("1+1").then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 4000)),
    ])
    expect(stale).not.toBe("resolved")

    // The next real command wakes a fresh worker: rename through the exact
    // same storage-command path the UI uses. On real Chrome binaries
    // Playwright neither re-emits "serviceworker" for the respawned worker
    // nor lists it in serviceWorkers() — the committed reply plus a storage
    // read through an extension page are the honest cross-browser proof.
    const reply = await page.evaluate(`(async () => {
      const state = (await chrome.storage.local.get("dop_v2_state")).dop_v2_state
      return chrome.runtime.sendMessage({
        type: "DOP_STORAGE_COMMAND",
        command: {
          kind: "rename-playlist",
          operationId: crypto.randomUUID(),
          expectedRevision: state.revision,
          playlistId: "pl-life",
          name: "After Kill",
        },
      })
    })()`)
    expect(reply).toMatchObject({ kind: "committed" })
    const state = await readStateViaPage(page)
    expect(state.playlists[0]?.name).toBe("After Kill")
    expect(state.revision).toBe(1)
    await page.screenshot({ path: evidence("sw-kill-recovery.png") })
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("extension update (disable→enable): stale contexts invalidate cleanly, fresh contexts work", async ({}, testInfo) => {
  const { context, extensionId } = await launchExtension(testInfo)
  try {
    const optionsPage = await context.newPage()
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`)
    await expect(optionsPage.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })

    const playerPage = await context.newPage()
    await playerPage.goto(`${PLAYER}?partId=p1`)
    await expect(playerPage.locator("#d-op-add-wrapper")).toBeAttached({ timeout: 15_000 })

    // Update invalidation. chrome.runtime.reload() permanently unloads
    // --load-extension builds under Playwright's persistent context (the
    // unpacked reload never re-registers — probed on bundled chromium AND
    // headed); the disable→enable toggle on chrome://extensions runs the
    // same unload→load machinery a real update does: the worker dies,
    // every injected/extension page context is invalidated, storage is
    // preserved, and the extension re-registers with the same id.
    const extPage = await context.newPage()
    await extPage.goto("chrome://extensions")
    // extensions-item's id attribute IS the extension id; its only
    // cr-toggle is the enable/disable switch (stable across WebUI
    // generations — verified 152/153-class builds).
    const toggle = extPage.locator(`extensions-item[id='${extensionId}'] cr-toggle`)
    await expect(toggle).toHaveCount(1, { timeout: 10_000 })
    await toggle.click() // disable — unloads the extension entirely
    await expect.poll(() => context.serviceWorkers().length, { timeout: 10_000 }).toBe(0)
    // While disabled the whole extension surface is gone.
    const probePage = await context.newPage()
    const blocked = await probePage
      .goto(`chrome-extension://${extensionId}/options.html`, { timeout: 5_000 })
      .then(
        () => "reachable",
        () => "blocked",
      )
    expect(blocked).toBe("blocked")
    await probePage.close().catch(() => undefined)

    // Re-enable: the load path an updated extension takes. The respawned
    // worker IS observable through serviceWorkers() here (the toggle path
    // re-registers properly, unlike runtime.reload), but the fresh page
    // load is the honest behavioural proof regardless.
    await toggle.click()
    const freshOptions = await context.newPage()
    let navigated = false
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await freshOptions.goto(`chrome-extension://${extensionId}/options.html`, {
          timeout: 5_000,
        })
        navigated = true
        break
      } catch {
        await freshOptions.waitForTimeout(250)
      }
    }
    if (!navigated) throw new Error("options page never became reachable after re-enable")
    await expect(freshOptions.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })

    // Stale player page: its content-script runtime is invalidated, so any
    // storage-dispatching UI action silently fails — never a partial commit.
    await playerPage.locator("#d-op-add-wrapper").hover()
    const popupItem = playerPage.locator(".d-op-popup-item").first()
    if ((await popupItem.count()) > 0) {
      await popupItem.click()
      const confirm = playerPage.locator("#d-op-modal .d-op-modal-footer button.primary")
      if ((await confirm.count()) > 0 && (await confirm.isEnabled())) {
        await confirm.click().catch(() => undefined)
      }
    }
    const unchanged = await readStateViaPage(freshOptions)
    expect(unchanged.playlists[0]?.items.length).toBe(1)

    // Fresh navigation re-injects a live content script; state is untouched.
    await playerPage.reload()
    await expect(playerPage.locator("#d-op-add-wrapper")).toBeAttached({ timeout: 15_000 })
    const state = await readStateViaPage(freshOptions)
    expect(state.playlists).toHaveLength(1)
    expect(state.playlists[0]?.name).toBe("Lifecycle List")
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("share API 503: publish reports a bounded error, nothing committed, retry succeeds", async ({}, testInfo) => {
  const { context, extensionId, setApi503 } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/options.html`)
    await expect(page.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })

    setApi503(true)
    await page.locator(".playlist-card .share-open").click()
    const dialog = page.locator("#d-op-modal")
    await expect(dialog.locator(".share-dialog")).toBeVisible()
    await dialog.locator("input[name='dopShareVisibility'][value='public']").check()
    await dialog.locator(".share-publish").click()
    // Bounded error surfaced; no publication record persisted.
    await expect(dialog.locator(".share-result")).not.toBeEmpty({ timeout: 15_000 })
    const worker = context.serviceWorkers()[0]
    if (worker === undefined) throw new Error("service worker missing")
    const failed = await readState(worker)
    expect(failed.publications).toHaveLength(0)
    expect(failed.playlists[0]?.name).toBe("Lifecycle List")
    await page.screenshot({ path: evidence("api-503-publish.png") })

    // Recovery: the same explicit operation succeeds once the API is back —
    // pending create resumed with the same key, then activated.
    setApi503(false)
    await dialog.locator(".share-publish").click()
    await expect(dialog.locator(".share-url")).toHaveText(
      `https://d-op.sasnews.dev/p/${SHARE_ID}`,
      { timeout: 15_000 },
    )
    await expect(dialog.locator(".share-state")).toContainText("公開中")
    const after = await readState(worker)
    expect(after.playlists).toHaveLength(1)
    expect(after.publications).toHaveLength(1)
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("blocked adapter: delayed window.vc still reaches ready + chapters via bounded poll", async ({}, testInfo) => {
  const { context } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    // Adapter blocked for 1.4 s — inside the 500 ms × 30 readiness budget.
    await page.goto(`${PLAYER}?partId=p1&vcDelay=1400`)
    await expect(page.locator("#d-op-add-wrapper")).toBeAttached({ timeout: 15_000 })
    // Chapters arrive AFTER the delayed vc install → markers paint.
    await expect(page.locator("#d-op-seek-markers .d-op-seek-marker")).toHaveCount(1, {
      timeout: 15_000,
    })
    // Ready-seek path still works: op-ed mode seeks to the chapter start.
    await page.goto(`${PLAYER}?partId=p1&dopRangeIndex=0&vcDelay=1400`)
    await expect
      .poll(async () => page.evaluate("window.__fixture.jumps"), {
        timeout: 15_000,
      })
      .toContain(0)
    await page.screenshot({ path: evidence("blocked-adapter-recovery.png") })
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("browser close: persistent profile survives a full browser restart", async ({}, testInfo) => {
  const profileDir = testInfo.outputPath("restart-profile")
  const first = await chromium.launchPersistentContext(profileDir, {
    ...browserLaunchTarget(),
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  })
  try {
    const worker =
      first.serviceWorkers()[0] ?? (await first.waitForEvent("serviceworker", { timeout: 10_000 }))
    await worker.evaluate(`(async () => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set({ dop_v2_state: ${JSON.stringify(SEED_STATE)} })
    })()`)
  } finally {
    await first.close()
  }
  // Full process restart on the SAME profile directory.
  const second = await chromium.launchPersistentContext(profileDir, {
    ...browserLaunchTarget(),
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  })
  try {
    const worker =
      second.serviceWorkers()[0] ??
      (await second.waitForEvent("serviceworker", { timeout: 10_000 }))
    const state = await readState(worker)
    expect(state.playlists.map((p) => p.name)).toEqual(["Lifecycle List"])
  } finally {
    await second.close()
  }
})
