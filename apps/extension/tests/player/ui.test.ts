// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { createModalHost } from "../../src/player/modal"
import type { PlayerUiSnapshot } from "../../src/player/runtime"
import { createPlayerUi, type PlayerUiDeps } from "../../src/player/ui"

const IDLE: PlayerUiSnapshot = {
  mode: "idle",
  playlistActive: false,
  skipUiHidden: false,
  controlsVisible: false,
  prevDisabled: true,
  nextDisabled: true,
  panelLabel: "",
  panelSub: "",
  panelMeta: "",
  markers: [],
  customBar: { visible: false, startMs: null, endMs: null, name: "", testing: false },
}

const PLAYLIST: PlayerUiSnapshot = {
  ...IDLE,
  mode: "playlist",
  playlistActive: true,
  skipUiHidden: true,
  controlsVisible: true,
  prevDisabled: true,
  nextDisabled: false,
  panelLabel: "OP",
  panelSub: "MyList",
  panelMeta: "1 / 3",
  markers: [{ startMs: 10_000, endMs: 90_000, label: "OP", active: true }],
}

function page(): void {
  document.body.innerHTML = `
    <video id="video"></video>
    <div class="buttonArea"><button class="prev"></button><span class="time"></span><button class="next"></button><div class="skipUi"></div></div>
    <div class="seekArea"><div id="seekThumb"></div></div>
  `
}

function uiDeps(overrides: Partial<PlayerUiDeps> = {}): PlayerUiDeps {
  return {
    onPrev: () => undefined,
    onNext: () => undefined,
    onStop: () => undefined,
    onCustomDraft: () => undefined,
    onCustomTest: () => undefined,
    onCustomCancel: () => undefined,
    // jsdom gives <video>.duration = NaN; markers need a finite duration.
    getVideo: () =>
      ({
        duration: 1420,
        currentTime: 30,
        paused: false,
        readyState: 4,
      }) as unknown as ReturnType<PlayerUiDeps["getVideo"]>,
    schedule: (cb, ms) => window.setTimeout(cb, ms),
    cancelTimer: (t) => window.clearTimeout(t as number),
    ...overrides,
  }
}

describe("player ui", () => {
  it("playlist mode hides native prev/next and skipUi, shows own controls", () => {
    page()
    const ui = createPlayerUi(document, uiDeps())
    ui.render(PLAYLIST)
    expect(document.body.classList.contains("d-op-playlist-active")).toBe(true)
    expect(document.body.classList.contains("d-op-skip-hidden")).toBe(true)
    const prev = document.getElementById("d-op-playlist-prev") as HTMLElement
    const next = document.getElementById("d-op-playlist-next") as HTMLElement
    expect(prev.style.display).toBe("inline-flex")
    expect(next.style.display).toBe("inline-flex")
    expect(prev.querySelector("button")?.disabled).toBe(true)
    expect(next.querySelector("button")?.disabled).toBe(false)
    // Panel shows playlist meta.
    expect(document.querySelector("#d-op-top-panel .d-op-top-mode")?.textContent).toBe("OP")
    expect(document.querySelector("#d-op-top-panel .d-op-top-meta")?.textContent).toBe("1 / 3")
    // Marker rendered inside .seekArea before #seekThumb.
    const marker = document.querySelector("#d-op-seek-markers .d-op-seek-marker")
    expect(marker?.classList.contains("op")).toBe(true)
    expect(marker?.classList.contains("active")).toBe(true)
    ui.dispose()
  })

  it("op-ed mode leaves native controls visible (no playlist-active)", () => {
    page()
    const ui = createPlayerUi(document, uiDeps())
    ui.render({ ...IDLE, mode: "op-ed", skipUiHidden: true, panelLabel: "OP/ED" })
    expect(document.body.classList.contains("d-op-playlist-active")).toBe(false)
    expect(document.body.classList.contains("d-op-skip-hidden")).toBe(true)
    expect((document.getElementById("d-op-playlist-prev") as HTMLElement).style.display).toBe(
      "none",
    )
    ui.dispose()
  })

  it("idle removes all owned DOM and classes", () => {
    page()
    const ui = createPlayerUi(document, uiDeps())
    ui.render(PLAYLIST)
    ui.render(IDLE)
    expect(document.body.classList.contains("d-op-playlist-active")).toBe(false)
    expect(document.body.classList.contains("d-op-skip-hidden")).toBe(false)
    expect(document.getElementById("d-op-top-panel")).toBeNull()
    ui.dispose()
    for (const id of [
      "d-op-playlist-prev",
      "d-op-playlist-next",
      "d-op-seek-markers",
      "d-op-custom-bar",
    ]) {
      expect(document.getElementById(id)).toBeNull()
    }
  })

  it("prev/next/stop buttons dispatch to deps", () => {
    page()
    const calls: string[] = []
    const ui = createPlayerUi(
      document,
      uiDeps({
        onPrev: () => calls.push("prev"),
        onNext: () => calls.push("next"),
        onStop: () => calls.push("stop"),
      }),
    )
    ui.render({ ...PLAYLIST, prevDisabled: false })
    ;(document.querySelector("#d-op-playlist-prev button") as HTMLButtonElement).click()
    ;(document.querySelector("#d-op-playlist-next button") as HTMLButtonElement).click()
    ;(document.querySelector("#d-op-top-panel button") as HTMLButtonElement).click()
    expect(calls).toEqual(["prev", "next", "stop"])
    // A disabled prev button never dispatches (PLAYLIST.prevDisabled = true).
    calls.length = 0
    ui.render(PLAYLIST)
    ;(document.querySelector("#d-op-playlist-prev button") as HTMLButtonElement).click()
    expect(calls).toEqual([])
    ui.dispose()
  })

  it("custom-preview renders the bar and drafts via buttons", () => {
    page()
    const drafts: unknown[] = []
    const ui = createPlayerUi(document, uiDeps({ onCustomDraft: (patch) => drafts.push(patch) }))
    ui.render({
      ...IDLE,
      mode: "custom-preview",
      skipUiHidden: true,
      customBar: { visible: true, startMs: 5_000, endMs: 20_000, name: "X", testing: false },
    })
    const bar = document.getElementById("d-op-custom-bar")
    expect(bar).not.toBeNull()
    expect(bar?.querySelector("[data-dop-field='start']")?.textContent).toBe("0:05")
    ui.dispose()
    expect(document.getElementById("d-op-custom-bar")).toBeNull()
  })
})

describe("modal host", () => {
  it("resolves the clicked button value and never uses native dialogs", async () => {
    page()
    const host = createModalHost(document)
    const pending = host.show({
      title: "再生終了",
      body: "プレイリストの最後まで再生しました",
      buttons: [
        { label: "最初から再生", value: "restart" },
        { label: "このまま継続", value: "continue", primary: true },
        { label: "モードを解除", value: "close" },
      ],
    })
    const modal = document.getElementById("d-op-modal")
    expect(modal?.querySelector("h3")?.textContent).toBe("再生終了")
    const buttons = modal?.querySelectorAll(".d-op-modal-footer button") ?? []
    expect(buttons).toHaveLength(3)
    ;(buttons[1] as HTMLButtonElement).click()
    await expect(pending).resolves.toBe("continue")
    expect(document.getElementById("d-op-modal")).toBeNull()
  })

  it("Escape resolves null and a second show replaces the first", async () => {
    page()
    const host = createModalHost(document)
    const first = host.show({
      title: "A",
      body: "",
      buttons: [{ label: "OK", value: "ok" }],
    })
    const second = host.show({
      title: "B",
      body: "",
      buttons: [{ label: "OK", value: "ok" }],
    })
    await expect(first).resolves.toBeNull()
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    await expect(second).resolves.toBeNull()
    host.dispose()
  })
})
