// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { installKeyboardFocusGuard, isEditableElement } from "../../src/player/keyboard-focus"
import { createModalHost } from "../../src/player/modal"
import { computeSeekMarkers } from "../../src/player/seek-ranges"
import { item } from "../domain/fixtures"

const CHAPTERS = [
  { startMs: 0, endMs: 90_000, type: "none" },
  { startMs: 90_000, endMs: 1_300_000, type: "mainStory" },
  { startMs: 1_300_000, endMs: 1_390_000, type: "none" },
]

describe("player/seek-ranges (getSeekMarkers parity)", () => {
  it("merges chapter labels with stored range names; dedupes identical bounds", () => {
    const markers = computeSeekMarkers({
      mode: "idle",
      state: { mode: "idle" },
      chapters: CHAPTERS,
      libraryRanges: [
        // Same bounds as chapter 0 — stored name wins the label.
        { startMs: 0, endMs: 90_000, name: "俺のOP" },
        // Unique stored range → appended as 範囲 (empty name).
        { startMs: 500_000, endMs: 600_000, name: "" },
        // Exact duplicate of chapter 1 → no second marker.
        { startMs: 90_000, endMs: 1_300_000, name: "" },
      ],
      durationMs: 1_420_000,
    })
    // The mainStory chapter is filtered out (not a skip range); its bounds
    // still appear via the stored library range as a plain 範囲 marker.
    expect(markers).toHaveLength(4)
    expect(markers[0]?.label).toBe("俺のOP")
    expect(markers[1]?.label).toBe("ED")
    expect(markers[2]?.label).toBe("範囲")
    expect(markers[3]?.label).toBe("範囲")
    expect(markers.every((m) => !m.active)).toBe(true)
  })

  it("playlist mode marks markers whose bounds equal the playing item", () => {
    const playing = {
      ...item("a"),
      range: { start: 0, end: 90_000, name: "My OP" },
    }
    const markers = computeSeekMarkers({
      mode: "playlist",
      state: {
        mode: "playlist",
        playback: {
          playlistId: "p1",
          order: ["a"],
          currentItemId: "a",
          item: playing,
          mode: "ordered",
          endMenuShown: false,
        },
      },
      chapters: CHAPTERS,
      libraryRanges: [],
      durationMs: 1_420_000,
    })
    expect(markers[0]?.active).toBe(true)
    expect(markers[1]?.active).toBe(false)
  })

  it("op-ed mode marks the selected range index", () => {
    const markers = computeSeekMarkers({
      mode: "op-ed",
      state: {
        mode: "op-ed",
        ranges: [
          { startMs: 0, endMs: 90_000, name: "OP" },
          { startMs: 1_300_000, endMs: 1_390_000, name: "ED" },
        ],
        rangeIndex: 1,
      },
      chapters: CHAPTERS,
      libraryRanges: [],
      durationMs: 1_420_000,
    })
    // mainStory filtered → ED is marker index 1.
    expect(markers[1]?.active).toBe(true)
    expect(markers[0]?.active).toBe(false)
  })

  it("custom-preview renders a full draft marker or a single-edge point marker", () => {
    const full = computeSeekMarkers({
      mode: "custom-preview",
      state: {
        mode: "custom-preview",
        draft: { startMs: 10_000, endMs: 40_000, name: "ドラフト" },
        testing: false,
      },
      chapters: CHAPTERS,
      libraryRanges: [],
      durationMs: 1_420_000,
    })
    const draftMarker = full.find((m) => m.startMs === 10_000)
    expect(draftMarker?.label).toBe("ドラフト")
    expect(draftMarker?.active).toBe(true)

    const point = computeSeekMarkers({
      mode: "custom-preview",
      state: {
        mode: "custom-preview",
        draft: { startMs: 50_000, endMs: null, name: "" },
        testing: false,
      },
      chapters: CHAPTERS,
      libraryRanges: [],
      durationMs: 1_420_000,
    })
    const pointMarker = point.find((m) => m.startMs === 50_000)
    expect(pointMarker?.endMs).toBe(50_000)
    expect(pointMarker?.label).toBe("CUSTOM")
  })
})

describe("player/keyboard-focus (content.js:1533-1549 parity)", () => {
  it("stopPropagation on keydown only while an editable element is focused", async () => {
    document.body.innerHTML = `<input id="in" /><div id="plain"></div>`
    const dispose = installKeyboardFocusGuard(document)
    const spy = vi.fn()
    document.addEventListener("keydown", spy)

    const input = document.getElementById("in") as HTMLInputElement
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
    const suppressed = new KeyboardEvent("keydown", { key: " ", bubbles: true })
    const stopSpy = vi.spyOn(suppressed, "stopImmediatePropagation")
    input.dispatchEvent(suppressed)
    expect(stopSpy).toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()

    // Focus leaves → keydown flows again after the deferred focusout turn.
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    document.getElementById("plain")?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }))
    expect(spy).toHaveBeenCalled()
    dispose()
  })

  it("isEditableElement covers input/textarea/select/contenteditable", () => {
    document.body.innerHTML = `
      <input /><textarea></textarea><select></select>
      <div id="ce" contenteditable="true"></div><div id="no"></div>`
    expect(isEditableElement(document.querySelector("input"))).toBe(true)
    expect(isEditableElement(document.querySelector("textarea"))).toBe(true)
    expect(isEditableElement(document.querySelector("select"))).toBe(true)
    expect(isEditableElement(document.getElementById("ce"))).toBe(true)
    expect(isEditableElement(document.getElementById("no"))).toBe(false)
    expect(isEditableElement(null)).toBe(false)
  })
})

describe("player/modal host (showModal parity)", () => {
  it("resolves the clicked button value; Escape resolves null", async () => {
    const host = createModalHost(document)
    const pending = host.show({
      title: "t",
      body: "b",
      buttons: [
        { label: "Cancel", value: "cancel" },
        { label: "OK", value: "ok", primary: true },
      ],
    })
    expect(document.getElementById("d-op-modal")).not.toBeNull()
    // Primary focused (legacy autofocus parity).
    expect(document.activeElement?.textContent).toBe("OK")
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await expect(pending).resolves.toBeNull()

    const second = host.show({
      title: "t",
      body: "b",
      buttons: [{ label: "OK", value: "ok", primary: true }],
    })
    document.querySelector<HTMLButtonElement>(".d-op-modal-footer button")?.click()
    await expect(second).resolves.toBe("ok")
    host.dispose()
  })

  it("backdrop mousedown cancels; disabled buttons do not resolve", async () => {
    const host = createModalHost(document)
    const pending = host.show({
      title: "",
      body: "b",
      buttons: [{ label: "Nope", value: "nope", disabled: true }],
    })
    const modal = document.getElementById("d-op-modal") as HTMLElement
    // Click on the backdrop itself.
    modal.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    await expect(pending).resolves.toBeNull()
    expect(document.getElementById("d-op-modal")).toBeNull()
    host.dispose()
  })

  it("onReady receives the handle; body rows can close with a value", async () => {
    const host = createModalHost(document)
    const body = document.createElement("div")
    const row = document.createElement("button")
    row.textContent = "pick"
    body.appendChild(row)
    let handle: { close: (v: string | null) => void } | null = null
    const pending = host.show({
      title: "t",
      body: "",
      bodyNode: body,
      buttons: [{ label: "Cancel", value: "cancel" }],
      onReady: (h) => {
        handle = h
        row.addEventListener("click", () => h.close("picked"))
      },
    })
    row.click()
    await expect(pending).resolves.toBe("picked")
    expect(handle).not.toBeNull()
    host.dispose()
  })
})
