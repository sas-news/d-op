import fs from "node:fs"
import path from "node:path"
import {
  type BrowserContext,
  chromium,
  expect,
  type TestInfo,
  test,
  type Worker,
} from "@playwright/test"
import { browserLaunchTarget } from "./browser-target"

// Task-10 extension/UI parity acceptance: the real unpacked WXT build
// (chrome-mv3) against synthetic player/work fixtures served through route
// interception on the real d-Anime origins — the manifest match rules apply
// unmodified and no fixture code ships. No live d-Anime account exists: every
// assertion runs on these fixtures (see DoneClaim.md).
//
// Coverage: popup list/controls, options CRUD/copy/reorder/collapse, player
// ♪ add-menu multi-add + custom bar + seek markers + modal Escape, work-page
// OP/ED menu + first-range fallback, and the resilience budget (1000
// mutations, video replacement, no orphan UI/duplicate listeners).
const EXTENSION_PATH = path.resolve("apps/extension/.output/chrome-mv3")
const EVIDENCE_DIR = path.resolve(".omo/evidence/task-10-d-op-v2-share")
const PLAYER = "https://animestore.docomo.ne.jp/animestore/sc_d_pc"
const WORK = "https://animestore.docomo.ne.jp/animestore/ci/work?workId=w1"
const VIDEO_SECONDS = 200

test.setTimeout(90_000)

const LIBRARY = [
  {
    id: "pl-1",
    name: "E2E Alpha",
    items: [
      {
        id: "item-a",
        partId: "p1",
        title: "Work",
        episodeTitle: "Ep1",
        url: `${PLAYER}?partId=p1`,
        range: { start: 0, end: 90_000, name: "OP" },
      },
      {
        id: "item-c",
        partId: "p1",
        title: "Work",
        episodeTitle: "Ep1",
        url: `${PLAYER}?partId=p1`,
        range: { start: 110_000, end: 200_000, name: "ED" },
      },
      {
        id: "item-b",
        partId: "p2",
        title: "Work",
        episodeTitle: "Ep2",
        url: `${PLAYER}?partId=p2`,
        range: { start: 0, end: 90_000, name: "OP" },
      },
    ],
  },
  {
    id: "pl-2",
    name: "E2E Beta",
    items: [
      {
        id: "item-z",
        partId: "p9",
        title: "Other",
        episodeTitle: "Ep9",
        url: `${PLAYER}?partId=p9`,
        range: { start: 5_000, end: 60_000, name: "挿入歌" },
      },
    ],
  },
] as const

// sc_d_pc-shaped fixture: #video (real seekable WAV), .buttonArea with
// prev/next/.skipUi/.time (the ♪ anchor), .seekArea with #seekThumb +
// #seekPopupInWrap, #backInfo metadata, and a window.vc whose helpers resolve
// the CURRENT #video element so a replaced video still receives jumps.
const PLAYER_FIXTURE_HTML = `<!doctype html>
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
  // Dynamic #video lookup: a replaced element still receives seeks.
  const target = () => document.getElementById("video")
  window.vc = {
    ws010105Data: {
      "duration": ${VIDEO_SECONDS * 1000},
      "chapters": [
        { "start": 0, "end": 90000, "type": "none" },
        { "start": 110000, "end": 200000, "type": "none" }
      ],
    },
    jump: (value) => {
      window.__fixture.jumps.push(value)
      target().currentTime = value
    },
    goNext: () => {},
    procEndedEvent: () => {},
  }
  window.__dopSetTime = (value) => {
    const v = target()
    v.currentTime = value
    v.dispatchEvent(new Event("timeupdate"))
  }
  window.__dopReplaceVideo = () => {
    const old = document.getElementById("video")
    const v = document.createElement("video")
    v.id = "video"
    v.preload = "auto"
    v.src = window.__fixture.videoUrl
    old.replaceWith(v)
    return true
  }
})()
</script>
</body></html>
`

const WORK_FIXTURE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>fixture work</title></head>
<body>
<h1>Fixture Work Title</h1>
<div class="itemModule"><a href="/animestore/sc_d_pc?partId=p1">第1話</a><h3>第1話 サブタイ</h3></div>
<div class="itemModule"><a href="/animestore/sc_d_pc?partId=p2">第2話</a><h3>第2話 サブタイ</h3></div>
</body></html>
`

type Launched = {
  readonly context: BrowserContext
  readonly worker: Worker
  readonly extensionId: string
  readonly setFailChapterFetch: (fail: boolean) => void
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
  let failChapterFetch = false
  // Catch-all first (routes consult newest-first): nothing real leaves the box.
  await context.route("**/*", (route) => {
    const url = route.request().url()
    if (/^https?:\/\//.test(url)) return route.abort()
    return route.continue()
  })
  await context.route(/animestore\.docomo\.ne\.jp\/animestore\/sc_d_pc/, (route) => {
    // Work-page chapter fetch uses fetch(); navigations use 'document'. The
    // fallback test fails only the fetch half.
    if (failChapterFetch && route.request().resourceType() === "fetch") return route.abort()
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: PLAYER_FIXTURE_HTML,
    })
  })
  await context.route(/animestore\.docomo\.ne\.jp\/animestore\/(?!sc_d_pc)/, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: WORK_FIXTURE_HTML }),
  )
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 10_000 }))
  await worker.evaluate(`(async () => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set({
      dop_playlists: ${JSON.stringify(LIBRARY)},
      dop_window_mode: "tab"
    })
  })()`)
  const extensionId = new URL(worker.url()).hostname
  return {
    context,
    worker,
    extensionId,
    setFailChapterFetch: (fail) => {
      failChapterFetch = fail
    },
  }
}

function evidence(name: string): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  return path.join(EVIDENCE_DIR, name)
}

async function readPublicState(worker: Worker): Promise<{
  playlists: { id: string; name: string; items: { id: string; partId: string; range: unknown }[] }[]
  preferences: { collapsedPlaylists?: Record<string, boolean> }
}> {
  return worker.evaluate(
    `chrome.storage.local.get("dop_v2_state").then((r) => r.dop_v2_state)`,
  ) as Promise<never>
}

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("options page: list, collapse persistence, create/rename/delete, edit, copy, drag reorder", async ({}, testInfo) => {
  const { context, worker, extensionId } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/options.html`)
    await expect(page.locator(".playlist-card")).toHaveCount(2, { timeout: 15_000 })
    await expect(page.locator("#optionsVersion")).toHaveText(/d-OP v/)

    // Collapsed by default; clicking the toggle expands AND persists. (The
    // header's center is the name input — guarded against collapse toggles.)
    const firstCard = page.locator(".playlist-card").first()
    await expect(firstCard).toHaveClass(/collapsed/)
    await firstCard.locator(".playlist-toggle").click()
    await expect(firstCard).not.toHaveClass(/collapsed/)
    await expect
      .poll(async () => (await readPublicState(worker)).preferences.collapsedPlaylists?.["pl-1"])
      .toBe(false)

    // Create.
    await page.locator("#newPlaylistName").fill("E2E作成リスト")
    await page.locator("#createPlaylistBtn").click()
    await expect(page.locator(".playlist-card")).toHaveCount(3)
    await expect
      .poll(async () => (await readPublicState(worker)).playlists.map((p) => p.name))
      .toContain("E2E作成リスト")

    // Rename via the name input's change event.
    const nameInput = firstCard.locator(".playlist-name-input")
    await nameInput.fill("E2E Renamed")
    await nameInput.dispatchEvent("change")
    await expect
      .poll(
        async () => (await readPublicState(worker)).playlists.find((p) => p.id === "pl-1")?.name,
      )
      .toBe("E2E Renamed")

    // Edit item 'a': open the edit row, change times, save → replace-library.
    const rowA = page.locator(".item-row[data-item-id='item-a']")
    await rowA.locator("button", { hasText: "編集" }).click()
    const timeInputs = rowA.locator(".item-edit-row .item-time-input")
    await timeInputs.nth(0).fill("0:05")
    await timeInputs.nth(1).fill("1:35")
    await rowA.locator(".item-edit-row .btn-primary").click()
    await expect
      .poll(async () => {
        const p1 = (await readPublicState(worker)).playlists.find((p) => p.id === "pl-1")
        return p1?.items.find((i) => i.id === "item-a")?.range
      })
      .toEqual({ start: 5_000, end: 95_000, name: "OP" })

    // Copy item 'a' into pl-2 via the custom picker modal.
    await rowA.locator("button", { hasText: "コピー" }).click()
    const copyRows = page.locator(".d-op-modal-playlist-item")
    await expect(copyRows).toHaveCount(2) // pl-2 + the created list (pl-1 excluded)
    await copyRows.filter({ hasText: "E2E Beta" }).click()
    await expect
      .poll(async () => {
        const p2 = (await readPublicState(worker)).playlists.find((p) => p.id === "pl-2")
        return p2?.items.length
      })
      .toBe(2)

    // Drag reorder: move row 'item-c' above 'item-a' with the real mouse.
    const list = firstCard.locator(".items-list")
    const grip = page.locator(".item-row[data-item-id='item-c'] .drag-grip")
    const target = page.locator(".item-row[data-item-id='item-a']")
    const gripBox = await grip.boundingBox()
    const targetBox = await target.boundingBox()
    if (gripBox === null || targetBox === null) throw new Error("drag boxes missing")
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(targetBox.x + 4, targetBox.y + 2, { steps: 5 })
    await page.mouse.up()
    await expect
      .poll(async () => {
        const p1 = (await readPublicState(worker)).playlists.find((p) => p.id === "pl-1")
        return p1?.items.map((i) => i.id).join(",")
      })
      .toBe("item-c,item-a,item-b")
    void list

    // Delete item 'b' through the custom confirm modal (no native dialog).
    await page.locator(".item-row[data-item-id='item-b'] button", { hasText: "削除" }).click()
    await page.locator("#d-op-modal .d-op-modal-footer button.primary").click()
    await expect
      .poll(async () => {
        const p1 = (await readPublicState(worker)).playlists.find((p) => p.id === "pl-1")
        return p1?.items.map((i) => i.id)
      })
      .toEqual(["item-c", "item-a"])

    await page.screenshot({ path: evidence("options.png"), fullPage: true })
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("popup: constrained width, playlist picker, item start, now-playing controls", async ({}, testInfo) => {
  const { context, extensionId } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/popup.html`)

    // Picker view: two cards, version stamp, constrained 340px width.
    await expect(page.locator(".playlist-card")).toHaveCount(2, { timeout: 15_000 })
    await expect(page.locator("#popupVersion")).toHaveText("d-OP v0.1.0")
    const width = await page
      .locator(".container")
      .evaluate((el) => el.getBoundingClientRect().width)
    expect(width).toBeLessThanOrEqual(360)
    await page.screenshot({ path: evidence("popup.png") })

    // Expand the first card and click the second item: transient playback +
    // REQUEST_PLAYER open (a real tab is created — its document load bypasses
    // interception and stays inert under the catch-all abort). Keep it open:
    // the window manager owns it now, and closing it would clear playback.
    // The transient read goes through the still-open popup page: on real
    // Chrome binaries the service worker can be suspended mid-test, leaving
    // the Playwright worker handle stale — a page-context read is immune.
    await page.locator(".playlist-card-header").first().click()
    const opened = context.waitForEvent("page", { timeout: 15_000 })
    await page.locator(".playlist-card-item").nth(1).click()
    const playerTab = await opened
    await expect.poll(() => playerTab.url()).toContain("dopPlaylistId=pl-1")
    await expect.poll(() => playerTab.url()).toContain("dopIndex=1")
    await expect
      .poll(
        async () =>
          page.evaluate(
            `chrome.storage.local.get("dop_v2_transient").then((r) => r.dop_v2_transient?.playback?.index)`,
          ),
        { timeout: 15_000 },
      )
      .toBe(1)

    // Now-playing view with the transient state just written.
    await page.reload()
    await expect(page.locator("#playback")).toBeVisible({ timeout: 15_000 })
    await expect(page.locator("#playlistName")).toHaveText("E2E Alpha")
    await expect(page.locator("#trackProgress")).toHaveText("2 / 3")
    await expect(page.locator(".playlist-item")).toHaveCount(3)
    await page.screenshot({ path: evidence("popup-nowplaying.png") })

    // Prev/next forward commands; stop releases the player (and its tab).
    await page.locator("#prevBtn").click()
    await page.locator("#nextBtn").click()
    await page.locator("#stopBtn").click()
    await expect
      .poll(
        async () =>
          page.evaluate(
            `chrome.storage.local.get("dop_v2_transient").then((r) => r.dop_v2_transient?.playback)`,
          ),
        { timeout: 15_000 },
      )
      .toBeUndefined()
    await expect.poll(() => playerTab.isClosed()).toBe(true)
    await expect(page.locator("#playback")).toHaveClass(/hidden/)
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("player: ♪ add menu multi-add, custom range bar, markers, modal Escape, mutation storm", async ({}, testInfo) => {
  // Longest UI flow in the suite; real Chrome binaries under parallel load
  // need headroom past the file-level 90 s (observed 90 s timeout on CfT 152
  // at 6-way parallelism — same steps pass in ~3 s isolated).
  test.setTimeout(180_000)
  const { context, worker } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.goto(`${PLAYER}?partId=p1`)

    // ♪ wrapper anchored right after the native .time on the 50px bar;
    // chapter markers render but stay UNCOLORED in idle (canSeekColor=false).
    await expect(page.locator("#d-op-add-wrapper")).toBeAttached({ timeout: 15_000 })
    await expect(page.locator("#d-op-seek-markers .d-op-seek-marker")).toHaveCount(2)
    expect(await page.locator("#d-op-seek-markers .d-op-seek-marker.op").count()).toBe(0)
    const anchored = await page.evaluate(
      `document.querySelector(".buttonArea .time")?.nextElementSibling?.id`,
    )
    expect(anchored).toBe("d-op-add-wrapper")

    // Hover opens the popup: two chapter rows + カスタム範囲.
    await page.locator("#d-op-add-wrapper").hover()
    const popupItems = page.locator(".d-op-popup-item")
    await expect(popupItems).toHaveCount(3)
    await expect(popupItems.nth(0)).toContainText("OP")
    await expect(popupItems.nth(1)).toContainText("ED")
    await expect(popupItems.nth(2)).toHaveText("カスタム範囲")
    await page.screenshot({ path: evidence("player-addmenu.png") })

    // Multi-add: select BOTH playlists + create a new one in a single commit.
    await popupItems.nth(0).click()
    const pickerRows = page.locator(".d-op-modal-playlist-item")
    await expect(pickerRows).toHaveCount(2)
    await pickerRows.nth(0).click()
    await pickerRows.nth(1).click()
    await page.locator(".d-op-modal-new-row input").first().fill("E2E新規")
    const addButton = page.locator("#d-op-modal .d-op-modal-footer button.primary")
    await expect(addButton).toBeEnabled()
    await page.screenshot({ path: evidence("player-picker.png") })
    await addButton.click()
    await page.locator("#d-op-modal .d-op-modal-footer button.primary").click() // 追加完了 OK
    await expect
      .poll(async () => {
        const state = await readPublicState(worker)
        const p1 = state.playlists.find((p) => p.id === "pl-1")
        const p2 = state.playlists.find((p) => p.id === "pl-2")
        const created = state.playlists.find((p) => p.name === "E2E新規")
        return {
          p1: p1?.items.length,
          p2: p2?.items.length,
          created: created?.items.length,
          createdRange: created?.items[0]?.range,
        }
      })
      .toEqual({
        p1: 4,
        p2: 2,
        created: 1,
        createdRange: { start: 0, end: 90_000, name: "OP" },
      })

    // Escape cancels the picker without a dispatch.
    await page.locator("#d-op-add-wrapper").hover()
    await popupItems.nth(1).click()
    await expect(page.locator("#d-op-modal")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.locator("#d-op-modal")).toHaveCount(0)
    const p1CountAfterEscape = (await readPublicState(worker)).playlists.find(
      (p) => p.id === "pl-1",
    )?.items.length
    expect(p1CountAfterEscape).toBe(4)

    // Custom range: カスタム範囲 → bar → inputs → テスト seeks → 追加 → picker.
    await page.locator("#d-op-add-wrapper").hover()
    await popupItems.nth(2).click()
    await expect(page.locator("#d-op-custom-bar")).toBeVisible()
    const startInput = page.locator("#d-op-custom-bar [data-dop-field='start']")
    const endInput = page.locator("#d-op-custom-bar [data-dop-field='end']")
    await startInput.fill("0:05")
    await startInput.dispatchEvent("change")
    await endInput.fill("0:15")
    await endInput.dispatchEvent("change")
    await page.locator("#d-op-custom-bar button", { hasText: "テスト" }).click()
    await expect.poll(async () => page.evaluate("window.__fixture.jumps")).toContain(5)
    await page.screenshot({ path: evidence("player-custombar.png") })
    await page.locator("#d-op-custom-bar button", { hasText: "追加" }).click()
    await page.locator(".d-op-modal-playlist-item", { hasText: "E2E Alpha" }).click()
    await page.locator("#d-op-modal .d-op-modal-footer button.primary").click()
    await page.locator("#d-op-modal .d-op-modal-footer button.primary").click() // 追加完了 OK
    await expect
      .poll(async () => {
        const p1 = (await readPublicState(worker)).playlists.find((p) => p.id === "pl-1")
        return p1?.items.at(-1)?.range
      })
      .toEqual({ start: 5_000, end: 15_000, name: "CUSTOM" })
    // Custom-preview still owns the page → the new range paints as a colored marker.
    await expect(page.locator("#d-op-seek-markers .d-op-seek-marker")).toHaveCount(3)
    await page.locator("#d-op-custom-bar button", { hasText: "キャンセル" }).click()
    await expect(page.locator("#d-op-custom-bar")).toHaveCount(0)

    // Resilience: 1000 synthetic DOM mutations leave exactly one of each node.
    await page.evaluate(`(() => {
      for (let i = 0; i < 1000; i += 1) {
        const s = document.createElement("span")
        s.className = "dop-storm"
        document.body.appendChild(s)
      }
    })()`)
    await page.waitForTimeout(500)
    expect(await page.locator("#d-op-add-wrapper").count()).toBe(1)
    expect(await page.locator("#d-op-seek-markers").count()).toBe(1)
    expect(await page.locator("#d-op-top-panel").count()).toBeLessThanOrEqual(1)
    expect(await page.locator("#d-op-playlist-prev").count()).toBeLessThanOrEqual(1)
    // The ♪ popup still works after the storm.
    await page.locator("#d-op-add-wrapper").hover()
    await expect(page.locator(".d-op-popup-item").first()).toContainText("OP")
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("player: op-ed mode colors markers, keeps native controls, survives video replacement", async ({}, testInfo) => {
  const { context } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.goto(`${PLAYER}?partId=p1&dopRangeIndex=0`)

    // OP/ED mode: colored markers (op class + active), native prev/next visible.
    await expect(page.locator("#d-op-top-panel .d-op-top-mode")).toHaveText("OP/ED", {
      timeout: 15_000,
    })
    const opMarker = page.locator("#d-op-seek-markers .d-op-seek-marker.op")
    await expect(opMarker).toHaveCount(1)
    await expect(opMarker).toHaveClass(/active/)
    expect(
      await page.locator(".buttonArea .next").evaluate((el) => getComputedStyle(el).display),
    ).not.toBe("none")
    await expect.poll(async () => page.evaluate("window.__fixture.jumps")).toContain(0)
    await page.screenshot({ path: evidence("player-oped-markers.png") })

    // Video replacement: the debounced observer reattaches listeners to the
    // new element (expando instrumentation is invisible across worlds, so the
    // functional proof is that post-replacement enforcement still fires).
    await page.evaluate("window.__dopReplaceVideo()")
    await page.waitForFunction(`document.getElementById("video").duration === ${VIDEO_SECONDS}`)
    await page.waitForTimeout(400) // DOM_MUTATION_DEBOUNCE_MS + slack
    const jumpsBefore = (await page.evaluate("window.__fixture.jumps.length")) as number
    await page.waitForTimeout(1_200) // post-seeked cooldown
    // 95 s sits BETWEEN the chapter ranges (0-90 / 110-200) — op-ed skips
    // forward to the next range start (110 s). Exactly one new jump proves a
    // single listener set reattached to the replacement element.
    await page.evaluate("window.__dopSetTime(95)")
    await expect
      .poll(async () => page.evaluate("window.__fixture.jumps.at(-1)"), { timeout: 10_000 })
      .toBe(110)
    expect((await page.evaluate("window.__fixture.jumps.length")) as number).toBe(jumpsBefore + 1)
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("work page: OP/ED menu selects ranges, chapter failure falls back to dopRangeIndex=0", async ({}, testInfo) => {
  const { context, setFailChapterFetch } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.goto(WORK)

    const buttons = page.locator(".d-op-store-btn")
    await expect(buttons).toHaveCount(2, { timeout: 15_000 })
    await buttons.nth(0).click()
    const menuItems = page.locator(".d-op-store-range-item")
    await expect(menuItems).toHaveCount(2)
    await expect(menuItems.nth(0)).toContainText("OP")
    await expect(menuItems.nth(1)).toContainText("ED")
    await page.screenshot({ path: evidence("store-menu.png") })

    // Selecting ED opens the player with dopRangeIndex=1 + title params.
    const opened = context.waitForEvent("page", { timeout: 15_000 })
    await menuItems.nth(1).click()
    const playerTab = await opened
    await expect.poll(() => playerTab.url()).toContain("dopRangeIndex=1")
    await expect.poll(() => playerTab.url()).toContain("partId=p1")
    await expect
      .poll(() => new URL(playerTab.url()).searchParams.get("dopTitle"))
      .toBe("Fixture Work Title")
    await playerTab.close().catch(() => {})
    await expect(page.locator("#d-op-store-range-menu")).toHaveCount(0)

    // Chapter fetch failure → the first-range fallback opens dopRangeIndex=0.
    setFailChapterFetch(true)
    const openedFallback = context.waitForEvent("page", { timeout: 15_000 })
    await buttons.nth(1).click()
    const fallbackTab = await openedFallback
    await expect.poll(() => fallbackTab.url()).toContain("partId=p2")
    await expect.poll(() => fallbackTab.url()).toContain("dopRangeIndex=0")
    await fallbackTab.close().catch(() => {})
  } finally {
    await context.close()
  }
})
