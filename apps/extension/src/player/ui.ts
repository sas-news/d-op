// Player DOM renderer — applies PlayerUiSnapshot to the page. Ports the
// structural parts of createPlaylistControls/updatePlaylistUI/
// showTopRightPanel/runUpdateSeekMarkers/showCustomRangeBar plus the seek
// popup label (content.js:696-786, 799-864, 1009-1065, 1233-1429). All nodes
// are idempotent, removed on idle/dispose, and aligned to the native 50px
// .buttonArea bar. The ♪ add menu lives in add-menu.ts.
import { parseTimeInput } from "../ui/format"
import { PANEL_HIDE_DELAY_MS } from "./constants"
import type { PlayerUiSnapshot, PlayerVideo, SeekMarker } from "./runtime"

export type PlayerUiDeps = {
  readonly onPrev: () => void
  readonly onNext: () => void
  readonly onStop: () => void
  readonly onCustomDraft: (patch: {
    readonly startMs?: number | null
    readonly endMs?: number | null
    readonly name?: string
  }) => void
  readonly onCustomTest: () => void
  readonly onCustomCancel: () => void
  /** '追加' on the custom bar — opens the playlist picker with the draft. */
  readonly onCustomAdd: () => void
  readonly getVideo: () => PlayerVideo | undefined
  readonly schedule: (callback: () => void, ms: number) => unknown
  readonly cancelTimer: (timer: unknown) => void
}

export type PlayerUi = {
  readonly render: (snapshot: PlayerUiSnapshot) => void
  readonly dispose: () => void
}

function markerClass(label: string): string {
  if (label === "OP") return "op"
  if (label === "ED") return "ed"
  if (label === "イントロ" || label === "CUSTOM") return "custom"
  return ""
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

/** Hover window for point markers (start == end) — ±500 ms like the legacy
 *  updateSeekPopupTitle fallback (content.js:1413-1420). */
const POINT_MARKER_HOVER_MS = 500

export function createPlayerUi(doc: Document, deps: PlayerUiDeps): PlayerUi {
  let panelTimer: unknown
  let lastCustomName: string | undefined
  let lastCustomStart: number | null | undefined
  let lastCustomEnd: number | null | undefined
  // DOM writes feed back through the page MutationObserver → handleDomMutation
  // → render(). Skip no-op mutations so our own writes cannot loop forever
  // (the legacy freeze class of bug documented in AGENTS.md).
  let lastMarkersSignature = ""
  // Last rendered marker list — feeds the seek-popup hover label.
  let currentMarkers: readonly SeekMarker[] = []
  let seekMoveTarget: Element | null = null

  const body = (): HTMLElement | null => doc.body ?? null

  function button(id: string, label: string, title: string, onClick: () => void): HTMLElement {
    let wrapper = doc.getElementById(id) as HTMLElement | null
    if (wrapper === null) {
      wrapper = doc.createElement("div")
      wrapper.id = id
      wrapper.className = "d-op-playlist-btn-wrapper"
      const control = doc.createElement("button")
      control.className = "d-op-playlist-btn"
      control.type = "button"
      control.textContent = label
      control.title = title
      control.addEventListener("click", onClick)
      wrapper.appendChild(control)
    }
    return wrapper
  }

  function ensureControls(): void {
    const prev = button("d-op-playlist-prev", "⏮", "前へ", deps.onPrev)
    const next = button("d-op-playlist-next", "⏭", "次へ", deps.onNext)
    const nativePrev = doc.querySelector(".buttonArea .prev")
    const nativeNext = doc.querySelector(".buttonArea .next")
    if (nativePrev?.parentNode != null && prev.parentNode !== nativePrev.parentNode) {
      nativePrev.parentNode.insertBefore(prev, nativePrev)
    }
    if (nativeNext?.parentNode != null && next.parentNode !== nativeNext.parentNode) {
      nativeNext.parentNode.insertBefore(next, nativeNext.nextSibling)
    }
  }

  /** Seek-popup label — ports the .seekArea mousemove + #seekPopupInWrap
   *  wiring (content.js:1402-1429). Attached once per .seekArea element;
   *  re-attaches if the player replaces the DOM. */
  function onSeekAreaMove(event: Event): void {
    const mouse = event as MouseEvent
    const wrap = doc.getElementById("seekPopupInWrap") as HTMLElement | null
    const seekArea = doc.querySelector(".seekArea") as HTMLElement | null
    if (wrap === null || seekArea === null) return
    let label = wrap.querySelector("#d-op-seek-popup-label") as HTMLElement | null
    if (label === null) {
      label = doc.createElement("div")
      label.id = "d-op-seek-popup-label"
      label.className = "d-op-seek-popup-label"
      wrap.appendChild(label)
    }
    let current: string | null = null
    const rect = seekArea.getBoundingClientRect()
    const video = deps.getVideo()
    if (
      rect.width > 0 &&
      video !== undefined &&
      Number.isFinite(video.duration) &&
      video.duration > 0
    ) {
      const hoverMs = ((mouse.clientX - rect.left) / rect.width) * video.duration * 1000
      for (const marker of currentMarkers) {
        if (marker.startMs < marker.endMs && hoverMs >= marker.startMs && hoverMs < marker.endMs) {
          current = marker.label
          break
        }
      }
      if (current === null) {
        for (const marker of currentMarkers) {
          if (
            marker.startMs === marker.endMs &&
            Math.abs(hoverMs - marker.startMs) <= POINT_MARKER_HOVER_MS
          ) {
            current = marker.label
            break
          }
        }
      }
    }
    if (current !== null) {
      if (label.textContent !== current) label.textContent = current
      if (label.style.display !== "block") label.style.display = "block"
    } else if (label.style.display !== "none") {
      label.style.display = "none"
    }
  }

  function ensureSeekPopupListener(): void {
    const seekArea = doc.querySelector(".seekArea")
    if (seekArea === seekMoveTarget) return
    if (seekMoveTarget !== null) seekMoveTarget.removeEventListener("mousemove", onSeekAreaMove)
    seekMoveTarget = seekArea
    if (seekArea !== null) seekArea.addEventListener("mousemove", onSeekAreaMove)
  }

  function renderMarkers(snapshot: PlayerUiSnapshot): void {
    const seekArea = doc.querySelector(".seekArea")
    const video = deps.getVideo()
    const duration = video?.duration
    if (
      seekArea === null ||
      video === undefined ||
      duration === undefined ||
      !Number.isFinite(duration) ||
      duration <= 0
    )
      return
    let container = doc.getElementById("d-op-seek-markers") as HTMLElement | null
    if (container === null) {
      container = doc.createElement("div")
      container.id = "d-op-seek-markers"
      container.className = "d-op-seek-markers"
    }
    const thumb = seekArea.querySelector("#seekThumb")
    if (thumb !== null && thumb.previousSibling !== container) {
      seekArea.insertBefore(container, thumb)
    } else if (thumb === null && container.parentNode !== seekArea) {
      seekArea.appendChild(container)
    }
    const durationMs = duration * 1000
    const signature = `${durationMs}:${snapshot.markersColored ? 1 : 0}:${snapshot.markers
      .map((m) => `${m.startMs}-${m.endMs}-${m.label}-${m.active ? 1 : 0}`)
      .join(",")}`
    // A re-created container has no children even when the signature matches.
    if (signature === lastMarkersSignature && container.childElementCount > 0) return
    lastMarkersSignature = signature
    container.replaceChildren()
    for (const marker of snapshot.markers) {
      if (marker.startMs >= durationMs || marker.endMs <= 0) continue
      const left = Math.max(0, (marker.startMs / durationMs) * 100)
      const width = Math.max(
        0,
        Math.min(100 - left, ((marker.endMs - marker.startMs) / durationMs) * 100),
      )
      const el = doc.createElement("div")
      el.className = "d-op-seek-marker"
      // Legacy gates color + active on canSeekColor — a mode must own the page
      // (content.js:1031-1057).
      if (snapshot.markersColored) {
        const kind = markerClass(marker.label)
        if (kind.length > 0) el.classList.add(kind)
        if (marker.active) el.classList.add("active")
      }
      el.style.left = `${left}%`
      if (width > 0) el.style.width = `${width}%`
      else el.classList.add("point")
      el.title = `${marker.label}: ${formatTime(marker.startMs)}-${formatTime(marker.endMs)}`
      container.appendChild(el)
    }
  }

  function renderPanel(snapshot: PlayerUiSnapshot): void {
    const host = body()
    if (host === null) return
    let panel = doc.getElementById("d-op-top-panel") as HTMLElement | null
    if (snapshot.mode === "idle") {
      panel?.remove()
      if (panelTimer !== undefined) deps.cancelTimer(panelTimer)
      panelTimer = undefined
      return
    }
    if (panel === null) {
      panel = doc.createElement("div")
      panel.id = "d-op-top-panel"
      panel.className = "d-op-top-panel"
      const content = doc.createElement("div")
      content.className = "d-op-top-content"
      content.append(
        Object.assign(doc.createElement("div"), { className: "d-op-top-mode" }),
        Object.assign(doc.createElement("div"), { className: "d-op-top-sub" }),
        Object.assign(doc.createElement("div"), { className: "d-op-top-meta" }),
      )
      const stop = doc.createElement("button")
      stop.type = "button"
      stop.textContent = "解除"
      stop.title = "再生モードを解除"
      stop.addEventListener("click", deps.onStop)
      panel.append(content, stop)
      host.appendChild(panel)
    }
    const modeEl = panel.querySelector(".d-op-top-mode")
    const subEl = panel.querySelector(".d-op-top-sub")
    const metaEl = panel.querySelector(".d-op-top-meta")
    if (modeEl !== null && modeEl.textContent !== snapshot.panelLabel)
      modeEl.textContent = snapshot.panelLabel
    if (subEl !== null && subEl.textContent !== snapshot.panelSub)
      subEl.textContent = snapshot.panelSub
    if (metaEl !== null && metaEl.textContent !== snapshot.panelMeta)
      metaEl.textContent = snapshot.panelMeta
    if (panel.style.display !== "flex") panel.style.display = "flex"
    if (panel.style.opacity !== "1") panel.style.opacity = "1"
    if (panelTimer !== undefined) deps.cancelTimer(panelTimer)
    // Legacy fades the panel after 3000 ms but keeps it in the DOM
    // (resetPanelHideTimer, content.js:788-797).
    panelTimer = deps.schedule(() => {
      const current = doc.getElementById("d-op-top-panel")
      if (current !== null) current.style.opacity = "0"
    }, PANEL_HIDE_DELAY_MS)
  }

  function renderCustomBar(snapshot: PlayerUiSnapshot): void {
    const host = body()
    if (host === null) return
    let bar = doc.getElementById("d-op-custom-bar") as HTMLElement | null
    if (!snapshot.customBar.visible) {
      bar?.remove()
      return
    }
    if (bar === null) {
      bar = doc.createElement("div")
      bar.id = "d-op-custom-bar"
      bar.className = "d-op-custom-bar"
      // Editable start/end inputs (legacy .d-op-custom-bar-time-input,
      // content.js:1270-1301): m:ss or raw seconds, parsed on change.
      const startInput = doc.createElement("input")
      startInput.type = "text"
      startInput.className = "d-op-custom-bar-time-input"
      startInput.placeholder = "--:--"
      startInput.setAttribute("data-dop-field", "start")
      startInput.addEventListener("change", () => {
        const ms = parseTimeInput(startInput.value)
        if (ms !== null) {
          deps.onCustomDraft({ startMs: ms })
          // Legacy reformats the input to canonical m:ss after a valid parse.
          startInput.value = formatTime(ms)
        }
      })
      const sep = doc.createElement("span")
      sep.className = "d-op-custom-bar-time-sep"
      sep.textContent = " - "
      const endInput = doc.createElement("input")
      endInput.type = "text"
      endInput.className = "d-op-custom-bar-time-input"
      endInput.placeholder = "--:--"
      endInput.setAttribute("data-dop-field", "end")
      endInput.addEventListener("change", () => {
        const ms = parseTimeInput(endInput.value)
        if (ms !== null) {
          deps.onCustomDraft({ endMs: ms })
          endInput.value = formatTime(ms)
        }
      })
      const startNow = doc.createElement("button")
      startNow.type = "button"
      startNow.textContent = "開始"
      startNow.title = "開始地点を設定"
      startNow.addEventListener("click", () => {
        const video = deps.getVideo()
        if (video !== undefined)
          deps.onCustomDraft({ startMs: Math.floor(video.currentTime * 1000) })
      })
      const endNow = doc.createElement("button")
      endNow.type = "button"
      endNow.textContent = "終了"
      endNow.title = "終了地点を設定"
      endNow.addEventListener("click", () => {
        const video = deps.getVideo()
        if (video !== undefined) deps.onCustomDraft({ endMs: Math.floor(video.currentTime * 1000) })
      })
      const name = doc.createElement("input")
      name.type = "text"
      name.placeholder = "区間名"
      name.setAttribute("data-dop-field", "name")
      name.addEventListener("input", () => deps.onCustomDraft({ name: name.value }))
      const test = doc.createElement("button")
      test.type = "button"
      test.className = "primary"
      test.textContent = "テスト"
      test.addEventListener("click", deps.onCustomTest)
      const add = doc.createElement("button")
      add.type = "button"
      add.className = "primary"
      add.textContent = "追加"
      add.title = "この範囲をプレイリストに追加"
      add.addEventListener("click", deps.onCustomAdd)
      const cancel = doc.createElement("button")
      cancel.type = "button"
      cancel.textContent = "キャンセル"
      cancel.addEventListener("click", deps.onCustomCancel)
      bar.append(startInput, sep, endInput, startNow, endNow, name, test, add, cancel)
      host.appendChild(bar)
      lastCustomName = undefined
      lastCustomStart = undefined
      lastCustomEnd = undefined
    }
    const field = (name: string): HTMLElement | null =>
      bar.querySelector(`[data-dop-field='${name}']`)
    // Sync inputs only while the user is not editing them — overwriting a
    // focused input on every render was a legacy focus-loss bug class.
    const syncTime = (
      input: HTMLElement | null,
      ms: number | null,
      last: number | null | undefined,
    ): void => {
      if (!(input instanceof HTMLInputElement)) return
      if (last === ms) return
      if (doc.activeElement === input) return
      const value = ms === null ? "" : formatTime(ms)
      if (input.value !== value) input.value = value
    }
    syncTime(field("start"), snapshot.customBar.startMs, lastCustomStart)
    syncTime(field("end"), snapshot.customBar.endMs, lastCustomEnd)
    if (doc.activeElement !== field("start")) lastCustomStart = snapshot.customBar.startMs
    if (doc.activeElement !== field("end")) lastCustomEnd = snapshot.customBar.endMs
    const nameInput = field("name")
    if (nameInput instanceof HTMLInputElement && lastCustomName !== snapshot.customBar.name) {
      if (nameInput.value !== snapshot.customBar.name) nameInput.value = snapshot.customBar.name
      lastCustomName = snapshot.customBar.name
    }
  }

  const render = (snapshot: PlayerUiSnapshot): void => {
    const host = body()
    if (host === null) return
    currentMarkers = snapshot.markers
    host.classList.toggle("d-op-playlist-active", snapshot.playlistActive)
    host.classList.toggle("d-op-skip-hidden", snapshot.skipUiHidden)
    ensureControls()
    for (const [id, visible, disabled] of [
      ["d-op-playlist-prev", snapshot.controlsVisible, snapshot.prevDisabled],
      ["d-op-playlist-next", snapshot.controlsVisible, snapshot.nextDisabled],
    ] as const) {
      const wrapper = doc.getElementById(id) as HTMLElement | null
      if (wrapper === null) continue
      const display = visible ? "inline-flex" : "none"
      if (wrapper.style.display !== display) wrapper.style.display = display
      const control = wrapper.querySelector("button")
      if (control !== null) control.disabled = disabled
    }
    renderPanel(snapshot)
    renderMarkers(snapshot)
    ensureSeekPopupListener()
    renderCustomBar(snapshot)
  }

  const dispose = (): void => {
    if (panelTimer !== undefined) deps.cancelTimer(panelTimer)
    panelTimer = undefined
    if (seekMoveTarget !== null) {
      seekMoveTarget.removeEventListener("mousemove", onSeekAreaMove)
      seekMoveTarget = null
    }
    for (const id of [
      "d-op-playlist-prev",
      "d-op-playlist-next",
      "d-op-top-panel",
      "d-op-seek-markers",
      "d-op-seek-popup-label",
      "d-op-custom-bar",
    ]) {
      doc.getElementById(id)?.remove()
    }
    const host = body()
    host?.classList.remove("d-op-playlist-active")
    host?.classList.remove("d-op-skip-hidden")
  }

  return { render, dispose }
}
