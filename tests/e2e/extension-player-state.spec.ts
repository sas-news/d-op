import path from "node:path"
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  type TestInfo,
  test,
  type Worker,
} from "@playwright/test"
import { browserLaunchTarget } from "./browser-target"

// Task-9 player orchestration acceptance: drives the REAL unpacked WXT build
// (chrome-mv3) against a synthetic player page. The page is served through
// Playwright route interception on the real d-Anime player origin so the
// unmodified manifest match rules apply — no fixture code enters production
// bundles and no authenticated d-Anime traffic is touched.
//
// Two interception realities shape this spec:
//  - Navigations on already-attached pages (page.goto, browser.tabs.update)
//    are intercepted and get the fixture.
//  - browser.tabs.create document requests fire before the target attaches
//    and bypass interception, so a created tab briefly loads the real site.
//    The catch-all route aborts every other http(s) request, which leaves
//    that document inert (no scripts, no self-close) until the window
//    manager reuses or the test closes it.
//
// The fixture uses a real seekable WAV blob: isolated-world content scripts
// share the underlying DOM element but NOT main-world property overrides, so
// a faked currentTime would be invisible to the orchestrator.
const EXTENSION_PATH = path.resolve("apps/extension/.output/chrome-mv3")
const PLAYER = "https://animestore.docomo.ne.jp/animestore/sc_d_pc"
const VIDEO_SECONDS = 100

// The playlist test waits out the real 5 s legacy playback-start cooldown and
// two full navigations; give every test headroom past the 30 s default.
test.setTimeout(60_000)

const LEGACY_LIBRARY = [
  {
    id: "pl-1",
    name: "E2E List",
    items: [
      {
        id: "item-a",
        partId: "p1",
        title: "Work",
        episodeTitle: "Ep1",
        url: `${PLAYER}?partId=p1`,
        range: { start: 10_000, end: 20_000, name: "OP" },
      },
      {
        id: "item-c",
        partId: "p1",
        title: "Work",
        episodeTitle: "Ep1",
        url: `${PLAYER}?partId=p1`,
        range: { start: 30_000, end: 40_000, name: "ED" },
      },
      {
        id: "item-b",
        partId: "p2",
        title: "Work",
        episodeTitle: "Ep2",
        url: `${PLAYER}?partId=p2`,
        range: { start: 50_000, end: 60_000, name: "OP" },
      },
    ],
  },
] as const

// Minimal sc_d_pc-shaped DOM: #video, .buttonArea .prev/.next, .skipUi and
// .seekArea > #seekThumb — the only nodes the renderer/adapter touch.
const PLAYER_FIXTURE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>fixture player</title></head>
<body>
<video id="video" preload="auto"></video>
<div class="buttonArea"><button class="prev">prev</button><button class="next">next</button><div class="skipUi">skip</div></div>
<div class="seekArea"><div id="seekThumb"></div></div>
<script>
(() => {
  const video = document.getElementById("video")
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
  video.src = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }))
  window.__fixture = { jumps: [], goNextCalls: 0 }
  const originalGoNext = () => {
    window.__fixture.goNextCalls += 1
  }
  window.vc = {
    ws010105Data: {
      duration: seconds * 1000,
      chapters: [
        { start: 10_000, end: 20_000, type: "none" },
        { start: 30_000, end: 40_000, type: "none" },
      ],
    },
    jump: (value) => {
      window.__fixture.jumps.push(value)
      video.currentTime = value
    },
    goNext: originalGoNext,
    procEndedEvent: () => {},
  }
  window.__dopBlocked = () => window.vc.goNext !== originalGoNext
  window.__dopSetTime = (value) => {
    video.currentTime = value
    video.dispatchEvent(new Event("timeupdate"))
  }
  window.__dopPause = () => video.pause()
  window.__dopEnded = () => video.dispatchEvent(new Event("ended"))
})()
</script>
</body></html>
`

type Launched = {
  readonly context: BrowserContext
  readonly worker: Worker
  readonly extensionId: string
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
  // Catch-all first: Playwright consults routes newest-first, so the player
  // document rule below still wins for sc_d_pc.
  await context.route("**/*", (route) => {
    const url = route.request().url()
    if (/^https?:\/\//.test(url)) return route.abort()
    return route.continue()
  })
  await context.route(/animestore\.docomo\.ne\.jp\/animestore\/sc_d_pc/, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: PLAYER_FIXTURE_HTML }),
  )
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 10_000 }))
  await worker.evaluate(`(async () => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set({
      dop_playlists: ${JSON.stringify(LEGACY_LIBRARY)},
      dop_window_mode: "tab"
    })
  })()`)
  const extensionId = new URL(worker.url()).hostname
  return { context, worker, extensionId }
}

async function extensionPage(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/manifest.json`)
  return page
}

async function waitForPanelMeta(page: Page, meta: string): Promise<void> {
  await expect
    .poll(async () => page.locator("#d-op-top-panel .d-op-top-meta").textContent(), {
      timeout: 15_000,
    })
    .toBe(meta)
}

/** Record a windowId into the transient envelope so the window manager's
 *  adoption path can reuse an already-attached (interceptable) tab. */
async function seedPlayerWindow(worker: Worker, urlIncludes: string): Promise<void> {
  const tab = await worker.evaluate(
    `chrome.tabs.query({ url: "https://animestore.docomo.ne.jp/*" })
      .then((tabs) => tabs.find((entry) => entry.url?.includes(${JSON.stringify(urlIncludes)})))`,
  )
  if (tab === undefined || tab === null) throw new Error("player tab not found for seeding")
  const windowId = (tab as { windowId: number }).windowId
  await worker.evaluate(`(async () => {
    const result = await chrome.storage.local.get("dop_v2_transient")
    const transient = result.dop_v2_transient ?? { schemaVersion: 2, generation: 1 }
    transient.playerWindow = {
      windowId: ${windowId},
      ownerToken: crypto.randomUUID(),
      ownerGeneration: 1
    }
    await chrome.storage.local.set({ dop_v2_transient: transient })
  })()`)
}

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("playlist mode: native controls hidden, seek retarget, cross-episode nav, end menu, stop", async ({}, testInfo) => {
  const { context, worker } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.goto(`${PLAYER}?partId=p1&dopPlaylistId=pl-1&dopIndex=0`)

    // Playlist starts at item a: panel, mode classes and the start seek.
    await expect(page.locator("#d-op-top-panel")).toBeVisible({ timeout: 15_000 })
    await waitForPanelMeta(page, "1 / 3")
    await expect(page.locator("body")).toHaveClass(/d-op-playlist-active/)
    await expect(page.locator("body")).toHaveClass(/d-op-skip-hidden/)
    expect(
      await page.locator(".buttonArea .prev").evaluate((el) => getComputedStyle(el).display),
    ).toBe("none")
    expect(
      await page.locator(".buttonArea .next").evaluate((el) => getComputedStyle(el).display),
    ).toBe("none")
    // vc.jump(10) proves the SEEK command crossed the real page bridge.
    await expect.poll(async () => page.evaluate("window.__fixture.jumps")).toContain(10)
    // dop* params were stripped via history.replaceState before acting.
    expect(new URL(page.url()).searchParams.get("dopPlaylistId")).toBeNull()
    // Auto-advance hook is wrapped while a playlist owns the page.
    expect(await page.evaluate("window.__dopBlocked()")).toBe(true)
    // Transient playback persisted with this tab's owner (order position 0).
    await expect
      .poll(async () =>
        worker.evaluate(
          `chrome.storage.local.get("dop_v2_transient").then((r) => r.dop_v2_transient?.playback?.index)`,
        ),
      )
      .toBe(0)

    // Freeze playback drift, wait out the 5 s playlist-start cooldown, then
    // user-seek into item c's range: the item retargets in place with no
    // extra SEEK command (trySwitchToOtherRange parity).
    await page.evaluate("window.__dopPause()")
    await page.waitForTimeout(5_200)
    const jumpsBefore = (await page.evaluate("window.__fixture.jumps")) as readonly number[]
    await page.evaluate("window.__dopSetTime(35)")
    await waitForPanelMeta(page, "2 / 3")
    expect(await page.evaluate("window.__fixture.jumps")).toHaveLength(jumpsBefore.length)
    // Wait for the retarget's persist write to land so the seeded windowId
    // cannot be clobbered by an in-flight transient mutation.
    await expect
      .poll(async () =>
        worker.evaluate(
          `chrome.storage.local.get("dop_v2_transient").then((r) => r.dop_v2_transient?.playback?.index)`,
        ),
      )
      .toBe(1)

    // Cross-episode advance goes through the background window manager.
    // Seeding playerWindow to this tab's window makes the manager adopt and
    // reuse it — the same Page object navigates to partId=p2.
    await seedPlayerWindow(worker, "partId=p1")
    await page.locator("#d-op-playlist-next button").click()
    await page.waitForURL(/partId=p2/, { timeout: 15_000 })
    await waitForPanelMeta(page, "3 / 3")
    await expect.poll(async () => page.evaluate("window.__fixture.jumps")).toContain(50)
    expect(new URL(page.url()).searchParams.get("dopIndex")).toBeNull()

    // End boundary: `ended` at the last item opens the custom end menu —
    // never a native dialog — and "continue" dismisses it without wrapping.
    // (The next button is correctly disabled at the boundary, so the test
    // drives the real `ended` event instead of forcing a click.)
    await page.evaluate("window.__dopEnded()")
    await expect(page.locator("#d-op-modal")).toBeVisible({ timeout: 10_000 })
    await expect(page.locator("#d-op-modal .d-op-modal-footer button")).toHaveCount(3)
    await page.locator("#d-op-modal .d-op-modal-footer button", { hasText: "継続" }).click()
    await expect(page.locator("#d-op-modal")).toHaveCount(0)

    // Stop restores the page: mode classes cleared, cookie restored,
    // auto-advance hook returned, owned playback dropped.
    await page.locator("#d-op-top-panel button").click()
    await expect(page.locator("body")).not.toHaveClass(/d-op-playlist-active/)
    await expect(page.locator("#d-op-top-panel")).toHaveCount(0)
    expect(await page.evaluate("window.__dopBlocked()")).toBe(false)
    expect(await page.evaluate("document.cookie")).toContain("op_skip=1")
    await expect
      .poll(async () =>
        worker.evaluate(
          `chrome.storage.local.get("dop_v2_transient").then((r) => r.dop_v2_transient?.playback)`,
        ),
      )
      .toBeUndefined()
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("op-ed mode keeps native controls and seeks near the duration end", async ({}, testInfo) => {
  const { context } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.goto(`${PLAYER}?partId=p1&dopRangeIndex=0`)

    // OP/ED mode: panel shows OP/ED, own prev/next hidden, native ones stay.
    await expect(page.locator("#d-op-top-panel .d-op-top-mode")).toHaveText("OP/ED", {
      timeout: 15_000,
    })
    await expect(page.locator("body")).toHaveClass(/d-op-skip-hidden/)
    await expect(page.locator("body")).not.toHaveClass(/d-op-playlist-active/)
    expect(
      await page.locator(".buttonArea .next").evaluate((el) => getComputedStyle(el).display),
    ).not.toBe("none")
    await expect.poll(async () => page.evaluate("window.__fixture.jumps")).toContain(10)

    // Past the enforced range end + tail, op-ed seeks near the duration end
    // instead of advancing (content.js:501-505 parity).
    await page.waitForTimeout(1_200) // legacy 800 ms post-seeked cooldown + slack
    await page.evaluate("window.__dopSetTime(95)")
    await expect
      .poll(async () => page.evaluate("window.__fixture.jumps.at(-1)"), { timeout: 10_000 })
      .toBe(VIDEO_SECONDS - 0.5)
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("window lifecycle: REQUEST_PLAYER creates, reuses, and close clears transient", async ({}, testInfo) => {
  const { context, worker, extensionId } = await launchExtension(testInfo)
  try {
    const host = await extensionPage(context, extensionId)
    const newTab = context.waitForEvent("page", { timeout: 15_000 })
    const created = await host.evaluate(
      `chrome.runtime.sendMessage(${JSON.stringify({
        kind: "REQUEST_PLAYER",
        url: `${PLAYER}?partId=p1&dopPlaylistId=pl-1&dopIndex=0`,
      })})`,
    )
    expect(created).toBe("created")
    const playerPage = await newTab
    // The document load bypassed interception (pre-attach) and hit the real
    // origin — its scripts are aborted, so the tab stays inert. The
    // singleton is still recorded in the transient envelope.
    await expect
      .poll(async () =>
        worker.evaluate(
          `chrome.storage.local.get("dop_v2_transient").then((r) => r.dop_v2_transient?.playerWindow?.windowId)`,
        ),
      )
      .not.toBeUndefined()

    // The created tab's document request bypassed interception and was
    // aborted; until the failed navigation settles, chrome.tabs.get reports
    // a blank/pending URL and validate() would reject the singleton. Wait
    // for the committed tab URL to match what validate() requires before
    // the second request — otherwise it races and returns "created".
    await expect
      .poll(async () =>
        host.evaluate(
          `chrome.tabs.query({}).then((tabs) => tabs.some((t) => (t.url ?? "").includes("dopPlaylistId=pl-1&dopIndex=0")))`,
        ),
      )
      .toBe(true)

    // A second REQUEST_PLAYER reuses the same tab: now attached, its
    // navigation IS intercepted — the fixture loads and the playlist resumes
    // at order position 1.
    const reused = await host.evaluate(
      `chrome.runtime.sendMessage(${JSON.stringify({
        kind: "REQUEST_PLAYER",
        url: `${PLAYER}?partId=p1&dopPlaylistId=pl-1&dopIndex=1`,
      })})`,
    )
    expect(reused).toBe("reused")
    await waitForPanelMeta(playerPage, "2 / 3")
    await expect.poll(async () => playerPage.evaluate("window.__fixture.jumps")).toContain(30)

    // Closing the player tab clears the owned transient session; the manager
    // falls back to creating a fresh surface on the next request.
    await playerPage.close()
    await expect
      .poll(async () =>
        worker.evaluate(
          `chrome.storage.local.get("dop_v2_transient").then((r) => {
            const t = r.dop_v2_transient ?? {}
            return t.playerWindow === undefined && t.playback === undefined
          })`,
        ),
      )
      .toBe(true)
    const released = await host.evaluate(
      `chrome.runtime.sendMessage(${JSON.stringify({ kind: "RELEASE_PLAYER" })})`,
    )
    expect(released).toEqual({ kind: "released" })
    await host.close()
  } finally {
    await context.close()
  }
})
