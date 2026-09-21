// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import type { TransientState } from "../../../../packages/shared/src/local-model"
import { emptyTransientState } from "../../src/storage/transient"
import { createPopupController, type PopupDeps } from "../../src/ui/popup"
import type { PublicReply } from "../../src/ui/storage-client"
import { playlist } from "../domain/fixtures"

const HTML = `
  <div id="playback" class="hidden">
    <div id="playlistName"></div><div id="shuffleBadge" class="hidden"></div>
    <div id="trackInfo"></div><div id="trackDetail"></div><div id="trackProgress"></div>
    <button id="prevBtn"></button><button id="nextBtn"></button><button id="stopBtn"></button>
    <div id="playlistItems"></div>
    <div id="shuffleActions" class="hidden">
      <button id="shuffleFullBtn"></button><button id="shuffleHereBtn"></button>
    </div>
  </div>
  <div id="playlistListSection"><div id="playlistList"></div></div>
  <button id="openOptions"></button><span id="popupVersion"></span>
`

function makeDeps(overrides: Partial<PopupDeps> = {}): {
  deps: PopupDeps
  sent: unknown[]
  state: { public: PublicReply; transient: TransientState }
  listeners: Set<() => void>
} {
  const sent: unknown[] = []
  const listeners = new Set<() => void>()
  const state = {
    public: {
      schemaVersion: 2,
      revision: 0,
      playlists: [playlist("p1"), playlist("p2", ["x"])],
      preferences: { windowMode: "window" as const, collapsedPlaylists: {} },
    } satisfies PublicReply,
    transient: emptyTransientState(),
  }
  const deps: PopupDeps = {
    doc: document,
    storage: {
      readPublic: async () => state.public,
      readTransient: async () => state.transient,
      writeTransient: async (next) => {
        state.transient = next
      },
      dispatch: async () => {
        throw new Error("popup never dispatches")
      },
    },
    sendMessage: async (message) => {
      sent.push(message)
      return undefined
    },
    openOptionsPage: () => {},
    version: "2.0.0",
    now: () => 1_700_000_000_000,
    newId: () => crypto.randomUUID(),
    random: () => 0.42,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ...overrides,
  }
  return { deps, sent, state, listeners }
}

/** Flush pending microtasks + the render loop. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("ui/popup", () => {
  beforeEach(() => {
    document.body.innerHTML = HTML
  })

  it("renders the playlist picker with expandable cards and counts", async () => {
    const { deps } = makeDeps()
    const controller = createPopupController(deps)
    controller.start()
    await settle()

    expect(document.getElementById("popupVersion")?.textContent).toBe("d-OP v2.0.0")
    const cards = document.querySelectorAll(".playlist-card")
    expect(cards).toHaveLength(2)
    expect(cards[0]?.querySelector(".playlist-card-title")?.textContent).toBe("Playlist p1")
    expect(cards[0]?.querySelector(".count")?.textContent).toBe("3曲")

    // Expand → item rows appear with range labels.
    const expandHeader = cards[0]?.querySelector(".playlist-card-header")
    if (!(expandHeader instanceof HTMLElement)) throw new Error("missing card header")
    expandHeader.click()
    await settle()
    const items = document.querySelectorAll(".playlist-card-item")
    expect(items).toHaveLength(3)
    expect(items[0]?.querySelector(".item-range-name")?.textContent).toBe("My OP")
    controller.dispose()
  })

  it("clicking an item writes transient playback and requests the player", async () => {
    const { deps, sent, state } = makeDeps()
    const controller = createPopupController(deps)
    controller.start()
    await settle()
    ;(document.querySelector(".playlist-card-header") as HTMLElement).click()
    await settle()
    ;(document.querySelectorAll(".playlist-card-item")[1] as HTMLElement).click()
    await settle()

    expect(state.transient.playback?.playlistId).toBe("p1")
    expect(state.transient.playback?.index).toBe(1)
    expect(state.transient.playback?.ownerToken).toBeTruthy()
    const request = sent.find((m) => (m as { kind: string }).kind === "REQUEST_PLAYER") as {
      url: string
    }
    expect(request.url).toContain("dopPlaylistId=p1")
    expect(request.url).toContain("dopIndex=1")
    controller.dispose()
  })

  it("renders the now-playing view with controls and PLAYLIST_JUMP rows", async () => {
    const { deps, sent, state } = makeDeps()
    state.transient = {
      ...emptyTransientState(),
      playback: {
        playlistId: "p1",
        index: 1,
        updatedAt: 1_700_000_000_000,
        ownerToken: "tok",
        ownerGeneration: 1,
      },
    }
    const controller = createPopupController(deps)
    controller.start()
    await settle()

    expect(document.getElementById("playback")?.classList.contains("hidden")).toBe(false)
    expect(document.getElementById("playlistName")?.textContent).toBe("Playlist p1")
    expect(document.getElementById("trackProgress")?.textContent).toBe("2 / 3")
    const rows = document.querySelectorAll(".playlist-item")
    expect(rows).toHaveLength(3)
    expect(rows[1]?.classList.contains("current")).toBe(true)

    // Row click forwards PLAYLIST_JUMP at the display position.
    ;(rows[2] as HTMLElement).click()
    await settle()
    const jump = sent.find(
      (m) => (m as { command?: { type: string } }).command?.type === "PLAYLIST_JUMP",
    ) as { command: { index: number } }
    expect(jump.command.index).toBe(2)

    // Prev/next forward the matching commands.
    ;(document.getElementById("prevBtn") as HTMLButtonElement).click()
    ;(document.getElementById("nextBtn") as HTMLButtonElement).click()
    const types = sent
      .map((m) => (m as { command?: { type: string } }).command?.type)
      .filter(Boolean)
    expect(types).toContain("PLAYLIST_PREV")
    expect(types).toContain("PLAYLIST_NEXT")
    controller.dispose()
  })

  it("stop button sends RELEASE_PLAYER; storage events re-render coalesced", async () => {
    const { deps, sent, listeners } = makeDeps()
    const controller = createPopupController(deps)
    controller.start()
    await settle()
    expect(listeners.size).toBe(1)
    ;(document.getElementById("stopBtn") as HTMLButtonElement).click()
    await settle()
    expect(sent.some((m) => (m as { kind: string }).kind === "RELEASE_PLAYER")).toBe(true)

    for (const listener of listeners) listener()
    for (const listener of listeners) listener()
    await settle()
    expect(document.querySelectorAll(".playlist-card").length).toBeGreaterThan(0)
    controller.dispose()
    expect(listeners.size).toBe(0)
  })

  it("hides __dop_ system playlists from the picker", async () => {
    const { deps, state } = makeDeps()
    state.public = {
      ...state.public,
      playlists: [...state.public.playlists, { ...playlist("sys"), name: "__dop_pending" }],
    }
    const controller = createPopupController(deps)
    controller.start()
    await settle()
    const titles = [...document.querySelectorAll(".playlist-card-title")].map((n) => n.textContent)
    expect(titles).not.toContain("__dop_pending")
    controller.dispose()
  })
})
