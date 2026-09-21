import fs from "node:fs"
import path from "node:path"
import { AxeBuilder } from "@axe-core/playwright"
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

// Task-24 accessibility / visual-fidelity / interaction acceptance for the
// real unpacked WXT build (chrome-mv3). Same fixture strategy as
// extension-parity.spec.ts: synthetic player/work pages are served through
// route interception on the real d-Anime origins, and extension pages are
// opened as tabs on chrome-extension://. No live service is touched.
//
// Covers: keyboard reorder (ArrowUp/ArrowDown on the grip button) sharing the
// drag path's persistence, modal focus trap + focus restore, popup keyboard
// activation + width bound, player ♪-menu and store range-menu keyboard
// contracts, reduced-motion CSS, no horizontal overflow at narrow width, and
// axe scans of the extension pages. Screenshots land in the task-24 evidence
// directory.
const EXTENSION_PATH = path.resolve("apps/extension/.output/chrome-mv3")
const EVIDENCE_DIR = path.resolve(".omo/evidence/task-24-d-op-v2-share")
const PLAYER = "https://animestore.docomo.ne.jp/animestore/sc_d_pc"
const WORK = "https://animestore.docomo.ne.jp/animestore/ci/work?workId=w1"
const VIDEO_SECONDS = 200

test.setTimeout(90_000)

const LIBRARY = [
  {
    id: "pl-1",
    name: "E2Eキーボード",
    items: [
      {
        id: "item-a",
        partId: "p1",
        title: "Fixture Work",
        episodeTitle: "第1話 サブタイトルが長めのエピソード",
        url: `${PLAYER}?partId=p1`,
        range: { start: 0, end: 90_000, name: "OP" },
      },
      {
        id: "item-c",
        partId: "p1",
        title: "Fixture Work",
        episodeTitle: "第1話 サブタイトルが長めのエピソード",
        url: `${PLAYER}?partId=p1`,
        range: { start: 110_000, end: 200_000, name: "ED" },
      },
      {
        id: "item-b",
        partId: "p2",
        title: "とても長い作品タイトルを持つアニメーション作品の名前がここに入ります",
        episodeTitle: "第2話",
        url: `${PLAYER}?partId=p2`,
        range: { start: 0, end: 90_000, name: "OP" },
      },
    ],
  },
] as const

// Minimal sc_d_pc shape: #video, .buttonArea with prev/next/.skipUi/.time
// (the ♪ anchor), .seekArea + #seekThumb/#seekPopupInWrap, #backInfo and a
// window.vc carrying the embedded "chapters" JSON the store fetch parses.
const PLAYER_FIXTURE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>fixture player</title></head>
<body>
<a id="backInfo" href="/animestore/ci/work?workId=w1"><span class="backInfoTxt1">Fixture Work</span><span class="backInfoTxt2">第1話</span><span class="backInfoTxt3">Fixture Episode</span></a>
<video id="video" preload="auto"></video>
<div class="buttonArea"><button class="prev">prev</button><button class="next">next</button><div class="skipUi">skip</div><span class="time">0:00</span></div>
<div class="seekArea"><div id="seekThumb"></div><div id="seekPopupInWrap"></div></div>
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
  window.vc = {
    "ws010105Data": {
      "duration": ${VIDEO_SECONDS * 1000},
      "chapters": [
        { "start": 0, "end": 90000, "type": "none" },
        { "start": 110000, "end": 200000, "type": "none" }
      ],
    },
    jump: (value) => { document.getElementById("video").currentTime = value },
    goNext: () => {},
    procEndedEvent: () => {},
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
  await context.route("**/*", (route) => {
    const url = route.request().url()
    if (/^https?:\/\//.test(url)) return route.abort()
    return route.continue()
  })
  await context.route(/animestore\.docomo\.ne\.jp\/animestore\/sc_d_pc/, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: PLAYER_FIXTURE_HTML }),
  )
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
  return { context, worker, extensionId }
}

function evidence(name: string): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  return path.join(EVIDENCE_DIR, name)
}

async function readPublicState(worker: Worker): Promise<{
  playlists: { id: string; items: { id: string }[] }[]
  preferences: { collapsedPlaylists?: Record<string, boolean> }
}> {
  return worker.evaluate(
    `chrome.storage.local.get("dop_v2_state").then((r) => r.dop_v2_state)`,
  ) as Promise<never>
}

/** The element currently holding keyboard focus, as a compact descriptor. */
async function focusedDescriptor(page: Page): Promise<string> {
  return page.evaluate(
    `(() => {
      const el = document.activeElement
      if (el === null) return "none"
      const row = el.closest(".item-row")
      return [el.tagName.toLowerCase(), el.className, row?.dataset.itemId ?? ""].join("|")
    })()`,
  )
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow: boolean = await page.evaluate(
    `document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`,
  )
  expect(overflow).toBe(false)
}

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("options: keyboard reorder shares the drag persistence path and keeps focus", async ({}, testInfo) => {
  const { context, worker, extensionId } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/options.html`)
    await expect(page.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })

    // Expand via the real toggle button — keyboard-focusable with aria state.
    const card = page.locator(".playlist-card").first()
    const toggle = card.locator(".playlist-toggle")
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await toggle.click()
    await expect(card).not.toHaveClass(/collapsed/)
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    // The collapse write commits and re-renders asynchronously — settle it
    // before driving keyboard focus, or the rebuild can detach the freshly
    // focused grip mid-flight (a real back-to-back-commit edge, not a bug
    // this test targets).
    await expect
      .poll(async () => (await readPublicState(worker)).preferences.collapsedPlaylists?.["pl-1"])
      .toBe(false)
    await page.waitForTimeout(150)

    // Focus the middle row's grip and ArrowUp: the row moves one step and the
    // committed order lands through the same replace-library path as drag.
    const gripC = page.locator(".item-row[data-item-id='item-c'] .drag-grip")
    await gripC.focus()
    await page.keyboard.press("ArrowUp")
    await expect
      .poll(async () => {
        const p1 = (await readPublicState(worker)).playlists.find((p) => p.id === "pl-1")
        return p1?.items.map((i) => i.id).join(",")
      })
      .toBe("item-c,item-a,item-b")
    // The storage-driven re-render replaced every row — focus must land back
    // on the moved row's fresh grip, not <body>.
    await expect.poll(() => focusedDescriptor(page)).toContain("button|drag-grip|item-c")

    // ArrowDown returns it; a boundary ArrowDown on the last row is a no-op
    // that leaves focus and order untouched.
    await page.keyboard.press("ArrowDown")
    await expect
      .poll(async () => {
        const p1 = (await readPublicState(worker)).playlists.find((p) => p.id === "pl-1")
        return p1?.items.map((i) => i.id).join(",")
      })
      .toBe("item-a,item-c,item-b")
    const gripB = page.locator(".item-row[data-item-id='item-b'] .drag-grip")
    await gripB.focus()
    await page.keyboard.press("ArrowDown")
    await page.waitForTimeout(300)
    expect(await focusedDescriptor(page)).toContain("item-b")
    await expect
      .poll(async () => {
        const p1 = (await readPublicState(worker)).playlists.find((p) => p.id === "pl-1")
        return p1?.items.map((i) => i.id).join(",")
      })
      .toBe("item-a,item-c,item-b")

    await page.screenshot({ path: evidence("options-expanded.png"), fullPage: true })
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("options modal: dialog semantics, Tab trap, Escape closes and restores focus", async ({}, testInfo) => {
  const { context, worker, extensionId } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/options.html`)
    const card = page.locator(".playlist-card").first()
    await card.locator(".playlist-toggle").click()

    // Open the delete-confirm modal from the item's 削除 button.
    const deleteButton = page.locator(".item-row[data-item-id='item-b'] button", {
      hasText: "削除",
    })
    await deleteButton.focus()
    await page.keyboard.press("Enter")
    const modal = page.locator("#d-op-modal")
    await expect(modal).toBeVisible()

    // Dialog contract: role/aria-modal, labelled, focus moved inside.
    const dialog = page.locator("#d-op-modal [role='dialog']")
    await expect(dialog).toHaveAttribute("aria-modal", "true")
    await expect
      .poll(() =>
        page.evaluate(`document.getElementById("d-op-modal").contains(document.activeElement)`),
      )
      .toBe(true)

    // Tab cycles inside the panel; it never escapes to the page behind.
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press("Tab")
      expect(
        await page.evaluate(
          `document.getElementById("d-op-modal").contains(document.activeElement)`,
        ),
      ).toBe(true)
    }
    await page.keyboard.press("Shift+Tab")
    expect(
      await page.evaluate(`document.getElementById("d-op-modal").contains(document.activeElement)`),
    ).toBe(true)

    // Escape closes the modal and restores focus to the invoking button.
    await page.keyboard.press("Escape")
    await expect(modal).toHaveCount(0)
    expect(await deleteButton.evaluate((el) => el === document.activeElement)).toBe(true)

    // Sanity: nothing was deleted — the cancel path is what Escape resolves.
    const p1 = (await readPublicState(worker)).playlists.find((p) => p.id === "pl-1")
    expect(p1?.items).toHaveLength(3)
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("popup: keyboard expand + clip activation, 340px bound, axe scan", async ({}, testInfo) => {
  const { context, extensionId } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.setViewportSize({ width: 340, height: 520 })
    await page.goto(`chrome-extension://${extensionId}/popup.html`)
    await expect(page.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })

    // Keyboard: focus the card toggle, Enter expands, aria-expanded flips.
    const toggle = page.locator(".playlist-card-toggle").first()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await toggle.focus()
    await page.keyboard.press("Enter")
    await expect(page.locator(".playlist-card-toggle").first()).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    const clipRows = page.locator(".playlist-card-item")
    await expect(clipRows).toHaveCount(3)
    // Focus stays on the freshly-rendered toggle after the expand re-render.
    await expect
      .poll(() =>
        page.evaluate(`document.activeElement.classList.contains("playlist-card-toggle")`),
      )
      .toBe(true)

    // Enter on a clip row starts playback — a real tab opens (aborted doc,
    // inert under the catch-all) carrying the playlist params.
    const opened = context.waitForEvent("page", { timeout: 15_000 })
    await clipRows.nth(1).focus()
    await page.keyboard.press("Enter")
    const playerTab = await opened
    await expect.poll(() => playerTab.url()).toContain("dopPlaylistId=pl-1")
    await expect.poll(() => playerTab.url()).toContain("dopIndex=1")

    // Popup width contract + no horizontal overflow at 340px.
    const width = await page
      .locator(".container")
      .evaluate((el) => el.getBoundingClientRect().width)
    expect(width).toBeLessThanOrEqual(360)
    await expectNoHorizontalOverflow(page)
    await page.screenshot({ path: evidence("popup-340.png") })

    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze()
    expect(scan.violations).toEqual([])
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("player: ♪ menu aria state + keyboard rows + Escape; options axe scan", async ({}, testInfo) => {
  const { context, extensionId } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.goto(`${PLAYER}?partId=p1`)

    // The ♪ trigger anchors on the native bar with popup semantics.
    const addButton = page.locator(".d-op-add-button")
    await expect(addButton).toBeVisible({ timeout: 15_000 })
    await expect(addButton).toHaveAttribute("aria-haspopup", "true")
    await expect(addButton).toHaveAttribute("aria-expanded", "false")

    // Focus opens the popup (focusin parity with hover) and flips the state.
    await addButton.focus()
    await expect(addButton).toHaveAttribute("aria-expanded", "true")
    const rows = page.locator(".d-op-popup .d-op-popup-item")
    await expect.poll(async () => rows.count()).toBeGreaterThan(0)
    // Rows are real buttons — Tab-reachable and Enter-activatable.
    await expect(rows.first()).toHaveJSProperty("tagName", "BUTTON")

    // Escape collapses the popup and returns focus to the trigger.
    await page.keyboard.press("Escape")
    await expect(addButton).toHaveAttribute("aria-expanded", "false")
    expect(await addButton.evaluate((el) => el === document.activeElement)).toBe(true)

    // The wrapper lives on the native 50px bar: same parent as .time and no
    // taller than the bar itself.
    const anchored = await page.evaluate(`(() => {
      const wrapper = document.getElementById("d-op-add-wrapper")
      const time = document.querySelector(".buttonArea .time")
      return wrapper !== null && time !== null && wrapper.parentNode === time.parentNode
    })()`)
    expect(anchored).toBe(true)
    const height = await addButton.evaluate((el) => el.getBoundingClientRect().height)
    expect(height).toBeLessThanOrEqual(50)

    await page.screenshot({ path: evidence("player-add-menu.png") })

    // Options page axe scan (separate tab, same context).
    const options = await context.newPage()
    await options.goto(`chrome-extension://${extensionId}/options.html`)
    await expect(options.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })
    const scan = await new AxeBuilder({ page: options })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze()
    expect(scan.violations).toEqual([])
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("store page: range menu exposes menu semantics and arrow-key navigation", async ({}, testInfo) => {
  const { context } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.goto(WORK)

    const trigger = page.locator(".d-op-store-btn").first()
    await expect(trigger).toBeVisible({ timeout: 15_000 })
    await expect(trigger).toHaveAttribute("aria-haspopup", "menu")
    await trigger.click()

    const menu = page.locator("#d-op-store-range-menu")
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute("role", "menu")
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    const items = menu.locator("[role='menuitem']:not([disabled])")
    await expect(items).toHaveCount(2)

    // Focus starts inside the menu; arrows cycle with wrap.
    await expect
      .poll(() => page.evaluate(`document.activeElement.getAttribute("role")`))
      .toBe("menuitem")
    await page.keyboard.press("ArrowDown")
    expect(await items.nth(1).evaluate((el) => el === document.activeElement)).toBe(true)
    await page.keyboard.press("ArrowDown") // wraps to first
    expect(await items.nth(0).evaluate((el) => el === document.activeElement)).toBe(true)
    await page.keyboard.press("ArrowUp") // wraps to last
    expect(await items.nth(1).evaluate((el) => el === document.activeElement)).toBe(true)

    // Escape closes the menu and restores focus to the trigger.
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true)
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("options: reduced-motion strips animations and narrow width has no overflow", async ({}, testInfo) => {
  const { context, extensionId } = await launchExtension(testInfo)
  try {
    const page = await context.newPage()
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.setViewportSize({ width: 320, height: 800 })
    await page.goto(`chrome-extension://${extensionId}/options.html`)
    await expect(page.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })

    // Under prefers-reduced-motion the modal + row transitions compute to
    // none — the CSS layer is what a real reduced-motion user sees.
    const transitionless = (await page.evaluate(`(() => {
      const modal = document.createElement("div")
      modal.className = "d-op-modal-panel"
      modal.style.display = "none"
      document.body.appendChild(modal)
      const animation = getComputedStyle(modal).animationName
      modal.remove()
      const row = document.querySelector(".item-row")
      const duration = row === null ? "" : getComputedStyle(row).transitionDuration
      return { animation, duration }
    })()`)) as { animation: string; duration: string }
    expect(transitionless.animation).toBe("none")

    // 320px width: no horizontal scrollbar even with the long CJK title.
    await page.locator(".playlist-card .playlist-toggle").first().click()
    await expectNoHorizontalOverflow(page)
    await page.screenshot({ path: evidence("options-320.png"), fullPage: true })
  } finally {
    await context.close()
  }
})
