// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import type { LocalCommand, TransientState } from "../../../../packages/shared/src/local-model"
import type { CommandReply } from "../../src/storage/repository"
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
  <div id="playlistListSection">
    <input id="playlistFilter" />
    <div id="playlistList"></div>
  </div>
  <button id="openOptions"></button><span id="popupVersion"></span>
  <button id="themeToggle"></button>
`

function makeDeps(overrides: Partial<PopupDeps> = {}): {
  deps: PopupDeps
  sent: unknown[]
  commands: LocalCommand[]
  state: { public: PublicReply; transient: TransientState }
  listeners: Set<() => void>
} {
  const sent: unknown[] = []
  const commands: LocalCommand[] = []
  const listeners = new Set<() => void>()
  const state: { public: PublicReply; transient: TransientState } = {
    public: {
      schemaVersion: 2,
      revision: 0,
      playlists: [playlist("p1"), playlist("p2", ["x"])],
      preferences: { windowMode: "window", collapsedPlaylists: {} },
    },
    transient: emptyTransientState(),
  }
  const deps: PopupDeps = {
    doc: document,
    storage: {
      readPublic: async () => state.public,
      readVault: async () => ({ revision: 0, publications: [], pendingCreates: [] }),
      readTransient: async () => state.transient,
      writeTransient: async (next) => {
        state.transient = next
      },
      dispatch: async (command) => {
        commands.push(command)
        if (command.kind === "set-preferences") {
          state.public = { ...state.public, preferences: command.preferences }
        }
        state.public.revision += 1
        const reply: CommandReply = {
          kind: "committed",
          operationId: command.operationId,
          revision: state.public.revision,
        }
        return reply
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
  return { deps, sent, commands, state, listeners }
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

  it("filter auto-expands item hits, collapses misses, and Escape clears", async () => {
    const { deps } = makeDeps()
    const controller = createPopupController(deps)
    controller.start()
    await settle()

    const filter = document.getElementById("playlistFilter") as HTMLInputElement
    filter.value = "Episode b"
    filter.dispatchEvent(new Event("input"))
    await settle()

    const cards = [...document.querySelectorAll<HTMLElement>(".playlist-card")]
    const p1 = cards.find((card) => card.dataset["playlistId"] === "p1")
    const p2 = cards.find((card) => card.dataset["playlistId"] === "p2")
    expect(p1?.classList.contains("expanded")).toBe(true)
    // Popup filtering drives expansion, not row hiding (options hides rows).
    expect(p1?.querySelectorAll(".playlist-card-item").length).toBe(3)
    expect(p2?.classList.contains("expanded")).toBe(false)
    expect(p2?.querySelectorAll(".playlist-card-item").length).toBe(0)

    filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await settle()
    expect(filter.value).toBe("")
    expect(document.querySelectorAll(".playlist-card.expanded").length).toBe(0)
    controller.dispose()
  })

  it("theme toggle persists an explicit preference and repaints the popup", async () => {
    const { deps, commands, state } = makeDeps()
    const controller = createPopupController(deps)
    controller.start()
    await settle()
    const toggle = document.getElementById("themeToggle") as HTMLButtonElement
    expect(document.documentElement.dataset["dopTheme"]).toBe("system")
    toggle.click()
    await settle()
    // jsdom has no matchMedia → system resolves light, so the toggle picks dark.
    expect(document.documentElement.dataset["dopTheme"]).toBe("dark")
    expect(toggle.textContent).toBe("")
    expect(toggle.querySelector("svg")).not.toBeNull()
    const preference = commands.find((command) => command.kind === "set-preferences")
    expect(preference?.kind === "set-preferences" && preference.preferences.theme).toBe("dark")
    expect(state.public.preferences.theme).toBe("dark")
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
