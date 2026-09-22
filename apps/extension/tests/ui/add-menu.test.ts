// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import type { LocalCommand } from "../../../../packages/shared/src/local-model"
import {
  type AddMenuDeps,
  type AddMenuSession,
  createAddMenu,
  readPlayerPageInfo,
} from "../../src/player/add-menu"
import { createModalHost } from "../../src/player/modal"
import type { CommandReply, PublicLocalState } from "../../src/storage/repository"
import { item, playlist } from "../domain/fixtures"

const PLAYER_URL =
  "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=p9&dopTitle=URL%20Work"

const HTML = `
  <div class="buttonArea"><span class="time">0:00</span></div>
  <a id="backInfo" href="/animestore/ci/work?workId=w9">
    <span class="backInfoTxt1">DOM Work</span>
    <span class="backInfoTxt2">第3話</span>
    <span class="backInfoTxt3">DOM Episode</span>
  </a>
`

type Harness = {
  deps: AddMenuDeps
  commands: LocalCommand[]
  state: { public: PublicLocalState }
  session: { current: AddMenuSession }
  timers: { callback: () => void; ms: number }[]
  flushTimers: () => void
}

function makeDeps(): Harness {
  const commands: LocalCommand[] = []
  const timers: { callback: () => void; ms: number }[] = []
  const session = {
    current: {
      partId: "p9",
      chapters: [
        { startMs: 0, endMs: 90_000, type: "none" },
        { startMs: 1_320_000, endMs: 1_410_000, type: "none" },
      ],
    } satisfies AddMenuSession,
  }
  const state = {
    public: {
      schemaVersion: 2,
      revision: 0,
      playlists: [playlist("p1", ["a"]), playlist("p2", ["b"])],
      preferences: { windowMode: "window" as const, collapsedPlaylists: {} },
    } satisfies PublicLocalState,
  }
  const modal = createModalHost(document)
  const deps: AddMenuDeps = {
    getVideo: () => undefined,
    getSession: () => session.current,
    readPublic: async () => state.public,
    dispatch: async (command) => {
      commands.push(command)
      if (command.kind === "replace-library") {
        state.public = { ...state.public, playlists: command.playlists }
      }
      state.public.revision += 1
      const reply: CommandReply = {
        kind: "committed",
        operationId: command.operationId,
        revision: state.public.revision,
      }
      return reply
    },
    newId: () => crypto.randomUUID(),
    showModal: (request) => modal.show(request),
    beginCustomPreview: async () => true,
    getCustomDraft: () => null,
    endCustomPreview: async () => {},
    currentUrl: () => PLAYER_URL,
    schedule: (callback, ms) => {
      const timer = { callback, ms }
      timers.push(timer)
      return timer
    },
    cancelTimer: (timer) => {
      const index = timers.indexOf(timer as { callback: () => void; ms: number })
      if (index >= 0) timers.splice(index, 1)
    },
  }
  return {
    deps,
    commands,
    state,
    session,
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

describe("player/add-menu", () => {
  beforeEach(() => {
    document.body.innerHTML = HTML
  })

  it("anchors the ♪ wrapper after .buttonArea .time and lists chapter rows", async () => {
    const { deps } = makeDeps()
    const menu = createAddMenu(document, deps)
    menu.refresh()
    await settle()

    const wrapper = document.getElementById("d-op-add-wrapper")
    expect(wrapper).not.toBeNull()
    expect(wrapper?.previousElementSibling?.className).toBe("time")

    const rows = [...document.querySelectorAll(".d-op-popup-item")].map((r) => r.textContent)
    // Two chapters + カスタム範囲 row (content.js:660-663).
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain("OP")
    expect(rows[0]).toContain("0:00-1:30")
    expect(rows[2]).toBe("カスタム範囲")
    menu.dispose()
  })

  it("multi-add commits ONE replace-library covering two playlists + a new one", async () => {
    const { deps, commands, state } = makeDeps()
    const menu = createAddMenu(document, deps)
    menu.refresh()
    await settle()

    // Click the first chapter row → playlist picker modal opens.
    ;(document.querySelector(".d-op-popup-item") as HTMLElement).click()
    await settle()
    const pickerItems = document.querySelectorAll(".d-op-modal-playlist-item")
    expect(pickerItems).toHaveLength(2)

    // Select both playlists AND type a new-playlist name.
    ;(pickerItems[0] as HTMLElement).click()
    ;(pickerItems[1] as HTMLElement).click()
    const newName = document.querySelector<HTMLInputElement>(".d-op-modal-new-row input")
    expect(newName).not.toBeNull()
    if (newName !== null) {
      newName.value = "新規リスト"
      newName.dispatchEvent(new Event("input"))
    }
    const add = document.querySelector<HTMLButtonElement>(".d-op-modal-footer button.primary")
    expect(add?.disabled).toBe(false)
    add?.click()
    await settle()
    // Completion modal → OK.
    document.querySelector<HTMLButtonElement>(".d-op-modal-footer button.primary")?.click()
    await settle()

    const replaces = commands.filter((c) => c.kind === "replace-library")
    expect(replaces).toHaveLength(1)
    const playlists = (replaces[0] as Extract<LocalCommand, { kind: "replace-library" }>).playlists
    expect(playlists).toHaveLength(3)
    const p1 = playlists.find((p) => p.id === "p1")
    const p2 = playlists.find((p) => p.id === "p2")
    const created = playlists.find((p) => p.name === "新規リスト")
    expect(p1?.items).toHaveLength(2)
    expect(p2?.items).toHaveLength(2)
    expect(created?.items).toHaveLength(1)
    const added = p1?.items[1]
    expect(added?.partId).toBe("p9")
    expect(added?.workId).toBe("w9")
    expect(added?.range).toEqual({ start: 0, end: 90_000, name: "OP" })
    expect(state.public.playlists).toHaveLength(3)
    menu.dispose()
  })

  it("custom picker rejects an invalid draft, accepts a valid one", async () => {
    const { deps } = makeDeps()
    let draft: { startMs: number | null; endMs: number | null; name: string } | null = {
      startMs: 1000,
      endMs: 500, // start >= end → error modal
      name: "",
    }
    const invalidDeps: AddMenuDeps = { ...deps, getCustomDraft: () => draft }
    const menu = createAddMenu(document, invalidDeps)
    void menu.openCustomPicker()
    await settle()
    expect(document.querySelector(".d-op-modal-body")?.textContent).toContain(
      "開始地点は終了地点より前",
    )
    document.querySelector<HTMLButtonElement>(".d-op-modal-footer button.primary")?.click()
    await settle()

    draft = { startMs: 10_000, endMs: 100_000, name: "mycustom" }
    void menu.openCustomPicker()
    await settle()
    // Picker opened with the draft name prefilled.
    const nameInput = document.querySelector<HTMLInputElement>(".d-op-modal-name-row input")
    expect(nameInput?.value).toBe("mycustom")
    menu.dispose()
  })

  it("dispose removes the wrapper; refresh is a no-op after dispose", async () => {
    const { deps } = makeDeps()
    const menu = createAddMenu(document, deps)
    menu.refresh()
    await settle()
    menu.dispose()
    expect(document.getElementById("d-op-add-wrapper")).toBeNull()
    menu.refresh()
    await settle()
    expect(document.getElementById("d-op-add-wrapper")).toBeNull()
  })

  it("popup is not rebuilt when partId is unchanged", async () => {
    const { deps } = makeDeps()
    const menu = createAddMenu(document, deps)
    menu.refresh()
    await settle()
    const popup = document.getElementById("d-op-add-popup")
    const sentinel = document.createElement("div")
    sentinel.id = "sentinel"
    popup?.appendChild(sentinel)
    menu.refresh()
    await settle()
    // Same partId → no rebuild → sentinel survives (content.js:637 parity).
    expect(document.getElementById("sentinel")).not.toBeNull()
    menu.dispose()
  })

  it("readPlayerPageInfo prefers URL dopTitle, falls back to backInfo DOM", () => {
    const info = readPlayerPageInfo(document, PLAYER_URL)
    expect(info.partId).toBe("p9")
    expect(info.workId).toBe("w9")
    expect(info.workTitle).toBe("URL Work")
    expect(info.episodeNumber).toBe("第3話")
    expect(info.episodeTitle).toBe("DOM Episode")
  })

  it("stored playlist names override chapter guesses in the popup", async () => {
    const { deps, state } = makeDeps()
    state.public.playlists = [
      {
        ...playlist("stored", []),
        items: [
          {
            ...item("s1"),
            partId: "p9",
            range: { start: 0, end: 90_000, name: "保存済みOP" },
          },
        ],
      },
    ]
    const menu = createAddMenu(document, deps)
    menu.refresh()
    await settle()
    const first = document.querySelector(".d-op-popup-item")?.textContent
    expect(first).toContain("保存済みOP")
    menu.dispose()
  })
})
