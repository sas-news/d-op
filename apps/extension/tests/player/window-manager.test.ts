import { describe, expect, it } from "vitest"
import { TRANSIENT_STATE_KEY } from "../../../../packages/shared/src/limits"
import type { TransientState } from "../../../../packages/shared/src/local-model"
import { PlayerWindowError } from "../../src/player/errors"
import {
  type BrowserTab,
  type BrowserWindow,
  createPlayerWindowManager,
  type WindowManagerDeps,
} from "../../src/player/window-manager"
import { InMemoryStorageDriver } from "../../src/storage/driver"
import {
  emptyTransientState,
  readTransientState,
  writeTransientState,
} from "../../src/storage/transient"

const PLAYER_URL =
  "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=p1&dopPlaylistId=pl-1&dopIndex=0"

class FakeTabs {
  readonly rows = new Map<number, BrowserTab>()
  readonly sent = new Map<number, unknown[]>()
  readonly removed: number[] = []
  #nextId = 100
  async get(tabId: number): Promise<BrowserTab> {
    const tab = this.rows.get(tabId)
    if (tab === undefined) throw new Error("no tab")
    return tab
  }
  async query(query: { windowId: number }): Promise<readonly BrowserTab[]> {
    return [...this.rows.values()].filter((tab) => tab.windowId === query.windowId)
  }
  async update(tabId: number, props: { url: string; active: boolean }): Promise<BrowserTab> {
    const tab = this.rows.get(tabId)
    if (tab === undefined) throw new Error("no tab")
    const next = { ...tab, url: props.url }
    this.rows.set(tabId, next)
    return next
  }
  async create(props: { url: string; active: boolean }): Promise<BrowserTab> {
    return this.addInWindow(900, props.url)
  }
  addInWindow(windowId: number, url: string): BrowserTab {
    const id = this.#nextId++
    const tab: BrowserTab = { id, url, windowId }
    this.rows.set(id, tab)
    return tab
  }
  async remove(tabId: number): Promise<void> {
    this.removed.push(tabId)
    this.rows.delete(tabId)
  }
  async sendMessage(tabId: number, message: unknown): Promise<unknown> {
    if (!this.rows.has(tabId)) throw new Error("no tab")
    const list = this.sent.get(tabId) ?? []
    list.push(message)
    this.sent.set(tabId, list)
    return undefined
  }
}

class FakeWindows {
  readonly rows = new Map<number, BrowserWindow>()
  readonly tabs: FakeTabs
  #nextId = 900
  failCreate = false
  constructor(tabs: FakeTabs) {
    // windows.create({url}) opens a window that already contains a tab —
    // mirror that so tabs.query({windowId}) resolves like a real browser.
    this.tabs = tabs
  }
  async get(windowId: number): Promise<BrowserWindow | undefined> {
    return this.rows.get(windowId)
  }
  async create(props: {
    url: string
    type: "popup"
    left?: number
    top?: number
    width?: number
    height?: number
  }): Promise<BrowserWindow | undefined> {
    if (this.failCreate) throw new Error("popup unavailable")
    const id = this.#nextId++
    const win: BrowserWindow = {
      id,
      left: props.left,
      top: props.top,
      width: props.width,
      height: props.height,
    }
    this.rows.set(id, win)
    this.tabs.addInWindow(id, props.url)
    return win
  }
}

function harness(
  options: { readonly windowMode?: "window" | "tab"; readonly transient?: TransientState } = {},
): {
  deps: WindowManagerDeps
  tabs: FakeTabs
  windows: FakeWindows
  driver: InMemoryStorageDriver
} {
  const tabs = new FakeTabs()
  const windows = new FakeWindows(tabs)
  const driver = new InMemoryStorageDriver()
  if (options.transient !== undefined) void writeTransientState(driver, options.transient)
  return {
    tabs,
    windows,
    driver,
    deps: {
      tabs,
      windows,
      readTransient: () => readTransientState(driver),
      writeTransient: (state) => writeTransientState(driver, state),
      windowMode: async () => options.windowMode ?? "window",
      newOwnerToken: () => crypto.randomUUID(),
    },
  }
}

describe("player window manager", () => {
  it("creates a popup window with stored bounds restored", async () => {
    const stored: TransientState = {
      ...emptyTransientState(),
      playerWindow: {
        windowId: 55,
        ownerToken: crypto.randomUUID(),
        ownerGeneration: 1,
        left: 10,
        top: 20,
        width: 640,
        height: 480,
      },
    }
    const { deps, windows } = harness({ transient: stored })
    const manager = createPlayerWindowManager(deps)
    // Stored window 55 does not exist → adoption fails, a new popup is created
    // with the persisted bounds (legacy getStoredWindowBounds path).
    expect(await manager.requestPlayer(PLAYER_URL)).toBe("created")
    const created = [...windows.rows.values()].at(-1)
    expect(created).toMatchObject({ left: 10, top: 20, width: 640, height: 480 })
  })

  it("creates a normal tab when windowMode is tab", async () => {
    const { deps, tabs } = harness({ windowMode: "tab" })
    const manager = createPlayerWindowManager(deps)
    expect(await manager.requestPlayer(PLAYER_URL)).toBe("created")
    const tab = [...tabs.rows.values()].at(-1)
    expect(tab?.url).toBe(PLAYER_URL)
  })

  it("reuses the live player tab on repeated REQUEST_PLAYER", async () => {
    const { deps, tabs, windows } = harness({ windowMode: "tab" })
    const manager = createPlayerWindowManager(deps)
    await manager.requestPlayer(PLAYER_URL)
    const tab = [...tabs.rows.values()].at(-1)
    expect(tab).toBeDefined()
    windows.rows.set(900, { id: 900 })
    const next = `${PLAYER_URL}&dopIndex=1`
    expect(await manager.requestPlayer(next)).toBe("reused")
    expect(tabs.rows.get(tab?.id ?? -1)?.url).toBe(next)
  })

  it("rejects non-player URLs with a structured error", async () => {
    const { deps } = harness()
    const manager = createPlayerWindowManager(deps)
    await expect(manager.requestPlayer("https://evil.example/x")).rejects.toBeInstanceOf(
      PlayerWindowError,
    )
    await expect(
      manager.requestPlayer("http://127.0.0.1:8123/animestore/sc_d_pc?partId=1"),
    ).rejects.toBeInstanceOf(PlayerWindowError)
  })

  it("releasePlayer stops the tab, removes it and clears the transient session", async () => {
    const { deps, tabs, windows, driver } = harness({ windowMode: "tab" })
    const manager = createPlayerWindowManager(deps)
    await manager.requestPlayer(PLAYER_URL)
    windows.rows.set(900, { id: 900 })
    const tabId = [...tabs.rows.values()][0]?.id ?? -1
    await manager.releasePlayer()
    expect(tabs.sent.get(tabId)).toEqual([{ type: "PLAYLIST_STOP" }])
    expect(tabs.removed).toEqual([tabId])
    const transient = await readTransientState(driver)
    expect(transient.playerWindow).toBeUndefined()
    expect(transient.playback).toBeUndefined()
  })

  it("forwards player commands only while a player tab lives", async () => {
    const { deps, tabs, windows } = harness({ windowMode: "tab" })
    const manager = createPlayerWindowManager(deps)
    expect(await manager.forwardToPlayer({ type: "PLAYLIST_NEXT" })).toBe(false)
    await manager.requestPlayer(PLAYER_URL)
    windows.rows.set(900, { id: 900 })
    const tabId = [...tabs.rows.values()][0]?.id ?? -1
    expect(await manager.forwardToPlayer({ type: "PLAYLIST_NEXT" })).toBe(true)
    expect(tabs.sent.get(tabId)).toEqual([{ type: "PLAYLIST_NEXT" }])
  })

  it("clears owned session state when the player tab closes", async () => {
    const { deps, tabs, windows, driver } = harness({ windowMode: "tab" })
    const manager = createPlayerWindowManager(deps)
    await manager.requestPlayer(PLAYER_URL)
    windows.rows.set(900, { id: 900 })
    const tabId = [...tabs.rows.values()][0]?.id ?? -1
    tabs.rows.delete(tabId)
    await manager.onTabRemoved(tabId, false)
    const transient = await readTransientState(driver)
    expect(transient.playerWindow).toBeUndefined()
    // Subsequent REQUEST_PLAYER must create a fresh surface.
    expect(await manager.requestPlayer(PLAYER_URL)).toBe("created")
  })

  it("clears the session when the player window closes", async () => {
    const { deps, tabs, windows, driver } = harness({ windowMode: "tab" })
    const manager = createPlayerWindowManager(deps)
    await manager.requestPlayer(PLAYER_URL)
    windows.rows.set(900, { id: 900 })
    const tabId = [...tabs.rows.values()][0]?.id ?? -1
    windows.rows.delete(900)
    await manager.onWindowRemoved(900)
    expect((await readTransientState(driver)).playerWindow).toBeUndefined()
    void tabId
  })

  it("recovers the singleton from the v2 transient record after SW restart", async () => {
    const stored: TransientState = {
      ...emptyTransientState(),
      generation: 4,
      playerWindow: {
        windowId: 900,
        ownerToken: crypto.randomUUID(),
        ownerGeneration: 2,
      },
    }
    const { deps, tabs, windows } = harness({ windowMode: "tab", transient: stored })
    tabs.rows.set(7, { id: 7, url: PLAYER_URL, windowId: 900 })
    windows.rows.set(900, { id: 900, left: 5, top: 6, width: 700, height: 500 })
    const manager = createPlayerWindowManager(deps)
    await manager.recover()
    expect(await manager.requestPlayer(`${PLAYER_URL}&dopIndex=1`)).toBe("reused")
  })

  it("never reactivates a dead stored window id", async () => {
    const stored: TransientState = {
      ...emptyTransientState(),
      playerWindow: {
        windowId: 424242, // stale
        ownerToken: crypto.randomUUID(),
        ownerGeneration: 1,
      },
    }
    const { deps, windows, driver } = harness({ transient: stored })
    const manager = createPlayerWindowManager(deps)
    await manager.recover()
    expect((await readTransientState(driver)).playerWindow).toBeUndefined()
    expect(await manager.requestPlayer(PLAYER_URL)).toBe("created")
    expect(windows.rows.has(424242)).toBe(false)
  })

  it("falls back to a tab when popup creation fails", async () => {
    const { deps, tabs, windows } = harness({ windowMode: "window" })
    windows.failCreate = true
    const manager = createPlayerWindowManager(deps)
    expect(await manager.requestPlayer(PLAYER_URL)).toBe("created")
    expect([...tabs.rows.values()].at(-1)?.url).toBe(PLAYER_URL)
  })

  it("persists window bounds into the transient envelope only", async () => {
    const { deps, driver } = harness()
    const manager = createPlayerWindowManager(deps)
    await manager.requestPlayer(PLAYER_URL)
    const stored = await readTransientState(driver)
    expect(stored.playerWindow?.windowId).toBe(900)
    expect(stored.playerWindow?.width).toBe(1280)
    // The legacy dop_player_window key is never written by v2.
    const legacyWindowKey = "dop_player_window"
    const raw = await driver.get([legacyWindowKey, TRANSIENT_STATE_KEY])
    expect(raw[legacyWindowKey]).toBeUndefined()
    expect(raw[TRANSIENT_STATE_KEY]).toBeDefined()
  })
})
