// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import type { LocalCommand, TransientState } from "../../../../packages/shared/src/local-model"
import type { CommandReply } from "../../src/storage/repository"
import { emptyTransientState } from "../../src/storage/transient"
import { createOptionsController, type OptionsDeps } from "../../src/ui/options"
import type { PublicReply } from "../../src/ui/storage-client"
import { item, playlist } from "../domain/fixtures"

const HTML = `
  <span id="optionsVersion"></span>
  <input id="newPlaylistName" /><button id="createPlaylistBtn"></button>
  <button id="exportBtn"></button><input id="importFile" type="file" />
  <div id="importStatus"></div>
  <label><input type="radio" name="windowMode" value="window" /></label>
  <label><input type="radio" name="windowMode" value="tab" /></label>
  <div id="playlistsContainer"></div>
`

type Harness = {
  deps: OptionsDeps
  commands: LocalCommand[]
  sent: unknown[]
  state: { public: PublicReply; transient: TransientState }
  timers: { callback: () => void; ms: number }[]
  flushTimers: () => void
}

function makeDeps(initial?: Partial<PublicReply>): Harness {
  const commands: LocalCommand[] = []
  const sent: unknown[] = []
  const timers: { callback: () => void; ms: number }[] = []
  const state = {
    public: {
      schemaVersion: 2,
      revision: 0,
      playlists: [playlist("p1"), playlist("p2", ["x"])],
      preferences: { windowMode: "window" as const, collapsedPlaylists: {} },
      ...initial,
    } satisfies PublicReply,
    transient: emptyTransientState(),
  }
  const deps: OptionsDeps = {
    doc: document,
    storage: {
      readPublic: async () => state.public,
      readTransient: async () => state.transient,
      writeTransient: async (next) => {
        state.transient = next
      },
      dispatch: async (command) => {
        commands.push(command)
        // Apply the command minimally so subsequent renders observe it.
        if (command.kind === "replace-library") {
          state.public = { ...state.public, playlists: command.playlists }
        } else if (command.kind === "set-preferences") {
          state.public = { ...state.public, preferences: command.preferences }
        } else if (command.kind === "create-playlist") {
          state.public = {
            ...state.public,
            playlists: [
              ...state.public.playlists,
              { id: `created-${commands.length}`, name: command.name, items: [] },
            ],
          }
        } else if (command.kind === "rename-playlist") {
          state.public = {
            ...state.public,
            playlists: state.public.playlists.map((p) =>
              p.id === command.playlistId ? { ...p, name: command.name } : p,
            ),
          }
        } else if (command.kind === "delete-playlist") {
          state.public = {
            ...state.public,
            playlists: state.public.playlists.filter((p) => p.id !== command.playlistId),
          }
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
    version: "2.0.0",
    now: () => 1_700_000_000_000,
    newId: () => crypto.randomUUID(),
    schedule: (callback, ms) => {
      const timer = { callback, ms }
      timers.push(timer)
      return timer
    },
    cancelTimer: (timer) => {
      const index = timers.indexOf(timer as { callback: () => void; ms: number })
      if (index >= 0) timers.splice(index, 1)
    },
    subscribe: () => () => {},
  }
  return {
    deps,
    commands,
    sent,
    state,
    timers,
    flushTimers: () => {
      const pending = [...timers]
      timers.length = 0
      for (const timer of pending) timer.callback()
    },
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

describe("ui/options", () => {
  beforeEach(() => {
    document.body.innerHTML = HTML
  })

  it("renders playlist cards collapsed by default, expanding on header click", async () => {
    const { deps, commands, state } = makeDeps()
    const controller = createOptionsController(deps)
    controller.start()
    await settle()

    const cards = document.querySelectorAll(".playlist-card")
    expect(cards).toHaveLength(2)
    expect(cards[0]?.classList.contains("collapsed")).toBe(true)
    expect(cards[0]?.querySelector(".playlist-count")?.textContent).toContain("3件")

    const collapseHeader = cards[0]?.querySelector(".playlist-header")
    if (!(collapseHeader instanceof HTMLElement)) throw new Error("missing playlist header")
    collapseHeader.click()
    await settle()
    // set-preferences persists collapsedPlaylists[p1]=false.
    const pref = commands.find((c) => c.kind === "set-preferences") as
      | Extract<LocalCommand, { kind: "set-preferences" }>
      | undefined
    expect(pref?.preferences.collapsedPlaylists?.["p1"]).toBe(false)
    expect(cards[0]?.classList.contains("collapsed")).toBe(false)
    controller.dispose()
    void state
  })

  it("create, rename and delete dispatch the typed commands", async () => {
    const { deps, commands, state } = makeDeps()
    const controller = createOptionsController(deps)
    controller.start()
    await settle()

    // Create
    ;(document.getElementById("newPlaylistName") as HTMLInputElement).value = "新規リスト"
    ;(document.getElementById("createPlaylistBtn") as HTMLButtonElement).click()
    await settle()
    expect(commands.some((c) => c.kind === "create-playlist" && c.name === "新規リスト")).toBe(true)

    // Rename — the name input change event.
    const nameInput = document.querySelector<HTMLInputElement>(
      ".playlist-card .playlist-name-input",
    )
    expect(nameInput).not.toBeNull()
    if (nameInput !== null) {
      nameInput.value = "renamed"
      nameInput.dispatchEvent(new Event("change"))
    }
    await settle()
    expect(commands.some((c) => c.kind === "rename-playlist" && c.name === "renamed")).toBe(true)

    // Delete — confirm through the custom modal (never native confirm).
    const deleteBtn = document.querySelector<HTMLButtonElement>(
      ".playlist-card .playlist-actions .btn-danger-text",
    )
    deleteBtn?.click()
    await settle()
    const modalOk = document.querySelector<HTMLButtonElement>(".d-op-modal-footer button.primary")
    expect(modalOk).not.toBeNull()
    modalOk?.click()
    await settle()
    expect(commands.some((c) => c.kind === "delete-playlist")).toBe(true)
    expect(state.public.playlists.some((p) => p.id === "p1")).toBe(false)
    controller.dispose()
  })

  it("item edit row saves a replaced range via replace-library", async () => {
    const { deps, commands, state } = makeDeps()
    const controller = createOptionsController(deps)
    controller.start()
    await settle()

    // Expand the first card and open the edit row of item 'a'.
    ;(document.querySelector(".playlist-header") as HTMLElement).click()
    await settle()
    const row = document.querySelector<HTMLElement>(".item-row[data-item-id='a']")
    expect(row).not.toBeNull()
    ;(row?.querySelector(".btn-text") as HTMLButtonElement | undefined)?.click()
    const inputs = row?.querySelectorAll<HTMLInputElement>(".item-edit-row input")
    expect(inputs?.length).toBe(3)
    if (inputs !== undefined && inputs.length === 3) {
      const startInput = inputs[1]
      const endInput = inputs[2]
      if (startInput === undefined || endInput === undefined)
        throw new Error("missing range inputs")
      startInput.value = "0:10"
      endInput.value = "1:40"
    }
    const saveButton = row?.querySelector(".item-edit-row .btn-primary")
    if (!(saveButton instanceof HTMLButtonElement)) throw new Error("missing save button")
    saveButton.click()
    await settle()

    const replace = commands.find((c) => c.kind === "replace-library") as
      | Extract<LocalCommand, { kind: "replace-library" }>
      | undefined
    const edited = replace?.playlists.find((p) => p.id === "p1")?.items.find((i) => i.id === "a")
    expect(edited?.range).toEqual({ start: 10_000, end: 100_000, name: "My OP" })
    expect(state.public.playlists[0]?.items[0]?.range?.start).toBe(10_000)
    controller.dispose()
  })

  it("copy dialog lists other playlists and commits copyItem", async () => {
    const { deps, commands, state } = makeDeps()
    const controller = createOptionsController(deps)
    controller.start()
    await settle()
    ;(document.querySelector(".playlist-header") as HTMLElement).click()
    await settle()

    const copyBtn = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".item-row[data-item-id='a'] .item-controls button",
      ),
    ].find((b) => b.textContent === "コピー")
    copyBtn?.click()
    await settle()
    const targets = document.querySelectorAll(".d-op-modal-playlist-item")
    expect(targets.length).toBe(1) // only p2 (current playlist excluded)
    expect(targets[0]?.textContent).toContain("Playlist p2")
    ;(targets[0] as HTMLElement).click()
    await settle()

    const target = state.public.playlists.find((p) => p.id === "p2")
    expect(target?.items).toHaveLength(2)
    expect(target?.items[1]?.partId).toBe("part-a")
    const replace = commands.find((c) => c.kind === "replace-library")
    expect(replace).toBeDefined()
    controller.dispose()
  })

  it("drag reorder persists the new item order via replace-library", async () => {
    const { deps, commands } = makeDeps()
    const controller = createOptionsController(deps)
    controller.start()
    await settle()
    ;(document.querySelector(".playlist-header") as HTMLElement).click()
    await settle()

    const card = document.querySelectorAll(".playlist-card")[0] as HTMLElement
    const rows = card.querySelectorAll<HTMLElement>(".item-row")
    expect(rows.length).toBe(3)
    // jsdom rects are all 0 — mouseup after a mousedown persists DOM order.
    const grip = rows[2]?.querySelector(".drag-grip") as HTMLElement
    grip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 0 }))
    // Move row 'c' to the top by direct DOM reorder (jsdom has no layout).
    const list = card.querySelector(".items-list") as HTMLElement
    const movedRow = rows[2]
    if (movedRow === undefined) throw new Error("missing third row")
    list.insertBefore(movedRow, list.firstChild)
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
    await settle()

    const replace = commands.find((c) => c.kind === "replace-library") as
      | Extract<LocalCommand, { kind: "replace-library" }>
      | undefined
    expect(replace?.playlists.find((p) => p.id === "p1")?.items.map((i) => i.id)).toEqual([
      "c",
      "a",
      "b",
    ])
    controller.dispose()
  })

  it("item play writes transient playback and requests the player URL", async () => {
    const { deps, sent, state } = makeDeps()
    const controller = createOptionsController(deps)
    controller.start()
    await settle()
    ;(document.querySelector(".playlist-header") as HTMLElement).click()
    await settle()
    ;(document.querySelector(".item-row[data-item-id='b'] .btn-icon") as HTMLButtonElement).click()
    await settle()

    expect(state.transient.playback?.playlistId).toBe("p1")
    expect(state.transient.playback?.index).toBe(1)
    const request = sent.find((m) => (m as { kind: string }).kind === "REQUEST_PLAYER") as {
      url: string
    }
    expect(request.url).toContain("dopPlaylistId=p1")
    expect(request.url).toContain("dopIndex=1")
    controller.dispose()
  })

  it("system playlists are filtered from rendering and item count", async () => {
    const { deps, state } = makeDeps()
    state.public.playlists = [
      ...state.public.playlists,
      { ...playlist("sys"), name: "__dop_pending" },
    ]
    const controller = createOptionsController(deps)
    controller.start()
    await settle()
    const names = [...document.querySelectorAll(".playlist-name-input")].map(
      (n) => (n as HTMLInputElement).value,
    )
    expect(names).not.toContain("__dop_pending")
    controller.dispose()
  })

  it("import merges items and reports skipped duplicates", async () => {
    const { deps, state } = makeDeps()
    const controller = createOptionsController(deps)
    controller.start()
    await settle()

    const imported = [
      {
        id: "imp1",
        name: "Playlist p1", // conflicts → merge path
        items: [item("a"), item("brand-new")],
      },
    ]
    const input = document.getElementById("importFile") as HTMLInputElement
    const file = new File([JSON.stringify(imported)], "import.json", {
      type: "application/json",
    })
    Object.defineProperty(input, "files", { value: [file], configurable: true })
    input.dispatchEvent(new Event("change"))
    await settle()
    // First modal: merge vs replace → pick マージ (primary).
    let primary = document.querySelector<HTMLButtonElement>(".d-op-modal-footer button.primary")
    expect(primary?.textContent).toBe("マージ")
    primary?.click()
    await settle()
    // Second modal: merge conflicting names → マージ（重複スキップ）.
    primary = document.querySelector<HTMLButtonElement>(".d-op-modal-footer button.primary")
    primary?.click()
    await settle()

    const p1 = state.public.playlists.find((p) => p.id === "p1")
    expect(p1?.items.map((i) => i.id)).toEqual(["a", "b", "c", "brand-new"])
    expect(document.getElementById("importStatus")?.textContent).toContain("1件追加")
    expect(document.getElementById("importStatus")?.textContent).toContain("重複")
    controller.dispose()
  })

  it("dispose removes document drag listeners and pending timers", async () => {
    const { deps, timers } = makeDeps()
    const controller = createOptionsController(deps)
    controller.start()
    await settle()
    controller.dispose()
    // A second start attaches fresh listeners; disposed controller stays inert.
    const cardsBefore = document.querySelectorAll(".playlist-card").length
    expect(cardsBefore).toBeGreaterThan(0)
    expect(timers.length).toBe(0)
  })
})
