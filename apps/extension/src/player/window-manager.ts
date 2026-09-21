// Background-side player window/tab lifecycle — ports background.js
// (baseline fc9d7fd): REQUEST_PLAYER reuse-or-create, popup-vs-tab
// preference, bounds restore via the transient envelope (legacy
// dop_player_window), RELEASE_PLAYER, FORWARD_TO_PLAYER, owned-window/tab
// cleanup and service-worker restart recovery.
//
// v2 differences by contract:
//  - state lives in dop_v2_transient.playerWindow + .playback; the legacy
//    dop_player_window key is never read, so a stale legacy window ID can
//    never be reactivated (plan task 9 / Local data step 1).
//  - persistent preference windowMode comes from the v2 public state
//    (preferences.windowMode), not dop_window_mode.

import type { PlayerCommand } from "../../../../packages/shared/src/bridge"
import { assertNever } from "../../../../packages/shared/src/limits"
import type { TransientState } from "../../../../packages/shared/src/local-model"
import { PlayerWindowError } from "./errors"
import { mutateTransientState } from "./transient-session"
import { isPlayerPageUrl } from "./url-params"

export type BrowserTab = {
  readonly id?: number | undefined
  readonly url?: string | undefined
  readonly windowId?: number | undefined
}
export type BrowserWindow = {
  readonly id?: number | undefined
  readonly left?: number | undefined
  readonly top?: number | undefined
  readonly width?: number | undefined
  readonly height?: number | undefined
}

export type WindowManagerDeps = {
  readonly tabs: {
    readonly get: (tabId: number) => Promise<BrowserTab>
    readonly query: (query: { readonly windowId: number }) => Promise<readonly BrowserTab[]>
    readonly update: (
      tabId: number,
      props: { readonly url: string; readonly active: boolean },
    ) => Promise<unknown>
    readonly create: (props: {
      readonly url: string
      readonly active: boolean
    }) => Promise<BrowserTab>
    readonly remove: (tabId: number) => Promise<unknown>
    readonly sendMessage: (tabId: number, message: PlayerCommand) => Promise<unknown>
  }
  readonly windows: {
    readonly get: (windowId: number) => Promise<BrowserWindow | undefined>
    readonly create: (props: {
      readonly url: string
      readonly type: "popup"
      readonly left?: number
      readonly top?: number
      readonly width?: number
      readonly height?: number
    }) => Promise<BrowserWindow | undefined>
  }
  readonly readTransient: () => Promise<TransientState>
  readonly writeTransient: (state: TransientState) => Promise<unknown>
  readonly windowMode: () => Promise<"window" | "tab">
  readonly newOwnerToken: () => string
}

export type PlayerWindowManager = {
  readonly requestPlayer: (url: string) => Promise<"reused" | "created">
  readonly releasePlayer: () => Promise<void>
  readonly forwardToPlayer: (command: PlayerCommand) => Promise<boolean>
  readonly recover: () => Promise<void>
  readonly onTabRemoved: (tabId: number, isWindowClosing: boolean) => Promise<void>
  readonly onWindowRemoved: (windowId: number) => Promise<void>
}

type PlayerTarget = { readonly windowId: number; readonly tabId: number }

const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800

export function createPlayerWindowManager(deps: WindowManagerDeps): PlayerWindowManager {
  // In-memory singleton — rebuilt from the transient envelope after a
  // service-worker restart (recover()). Never holds a legacy window id.
  let player: PlayerTarget | null = null
  const ownerToken = deps.newOwnerToken()
  let ownerGeneration = 0

  function withPlayerWindow(
    state: TransientState,
    window: TransientState["playerWindow"],
  ): TransientState {
    const next = { ...state }
    if (window === undefined) delete next.playerWindow
    else next.playerWindow = window
    return next
  }

  function withPlaybackCleared(state: TransientState): TransientState {
    const next = { ...state }
    delete next.playback
    return next
  }

  /** Persist window bounds + owner (legacy savePlayerWindowBounds). */
  async function saveWindow(windowId: number): Promise<void> {
    try {
      const win = await deps.windows.get(windowId)
      if (win?.id === undefined) return
      ownerGeneration += 1
      await mutateTransientState(
        () => deps.readTransient(),
        (state) => deps.writeTransient(state),
        (current) =>
          withPlayerWindow(current, {
            windowId,
            ownerToken,
            ownerGeneration,
            ...(win.left !== undefined ? { left: Math.trunc(win.left) } : {}),
            ...(win.top !== undefined ? { top: Math.trunc(win.top) } : {}),
            ...(win.width !== undefined ? { width: Math.trunc(win.width) } : {}),
            ...(win.height !== undefined ? { height: Math.trunc(win.height) } : {}),
          }),
      )
    } catch {
      // Window may vanish mid-flight; legacy swallowed the same failure.
    }
  }

  /** Drop owned playback + window records (dead-owner GC; legacy cleared
   *  dop_playback + dop_pending + dop_player_window on tab/window loss). */
  async function clearSession(): Promise<void> {
    await mutateTransientState(
      () => deps.readTransient(),
      (state) => deps.writeTransient(state),
      (current) => withPlaybackCleared(withPlayerWindow(current, undefined)),
    )
  }

  /** Legacy validatePlayerState: tab alive, still a d-Anime URL, window alive. */
  async function validate(): Promise<boolean> {
    if (player === null) return false
    try {
      const tab = await deps.tabs.get(player.tabId)
      if (tab.url === undefined || !isPlayerPageUrl(tab.url)) {
        player = null
        return false
      }
      const win = await deps.windows.get(player.windowId)
      if (win?.id === undefined) return false
      return true
    } catch {
      player = null
      return false
    }
  }

  /** Adopt a window from the v2 transient record when it still contains a
   *  player tab (legacy recovery path, background.js:58-80). */
  async function adoptStoredWindow(windowId: number): Promise<boolean> {
    try {
      const win = await deps.windows.get(windowId)
      if (win?.id === undefined) return false
      const tabs = await deps.tabs.query({ windowId })
      const playerTab = tabs.find((tab) => isPlayerPageUrl(tab.url ?? undefined)) ?? tabs[0]
      const tabId = playerTab?.id
      if (tabId === undefined) return false
      player = { windowId, tabId }
      await saveWindow(windowId)
      return true
    } catch {
      return false
    }
  }

  async function recover(): Promise<void> {
    const transient = await deps.readTransient()
    const stored = transient.playerWindow
    if (stored === undefined) return
    if (!(await adoptStoredWindow(stored.windowId))) {
      // Stale window id — clear dead session state instead of reactivating it.
      player = null
      await clearSession()
    }
  }

  async function requestPlayer(url: string): Promise<"reused" | "created"> {
    if (!isPlayerPageUrl(url)) throw new PlayerWindowError("invalid-player-url", url)
    if (player === null) {
      // SW may have restarted: rebuild from the transient record once.
      const stored = (await deps.readTransient()).playerWindow
      if (stored !== undefined) await adoptStoredWindow(stored.windowId)
    }
    if (await validate()) {
      const target = player
      if (target !== null) {
        try {
          await deps.tabs.update(target.tabId, { url, active: true })
          await saveWindow(target.windowId)
          return "reused"
        } catch {
          player = null
          await clearSession()
        }
      }
    }
    const mode = await deps.windowMode()
    if (mode === "tab") {
      const tab = await deps.tabs.create({ url, active: true })
      const id = tab.id
      const windowId = tab.windowId
      if (id !== undefined && windowId !== undefined) {
        player = { windowId, tabId: id }
        await saveWindow(windowId)
      }
      return "created"
    }
    try {
      const stored = (await deps.readTransient()).playerWindow
      const win = await deps.windows.create({
        url,
        type: "popup",
        ...(stored?.left !== undefined ? { left: stored.left } : {}),
        ...(stored?.top !== undefined ? { top: stored.top } : {}),
        width: stored?.width ?? DEFAULT_WIDTH,
        height: stored?.height ?? DEFAULT_HEIGHT,
      })
      const windowId = win?.id
      if (windowId === undefined) throw new PlayerWindowError("window-unavailable", "no id")
      const tabs = await deps.tabs.query({ windowId })
      const tabId = tabs[0]?.id
      if (tabId === undefined) throw new PlayerWindowError("window-unavailable", "no tab")
      player = { windowId, tabId }
      await saveWindow(windowId)
      return "created"
    } catch {
      // Popup creation failed — legacy fell back to a plain tab
      // (background.js:196-202).
    }
    const tab = await deps.tabs.create({ url, active: true })
    const id = tab.id
    const windowId = tab.windowId
    if (id !== undefined && windowId !== undefined) player = { windowId, tabId: id }
    return "created"
  }

  async function releasePlayer(): Promise<void> {
    const target = player
    player = null
    if (target !== null) {
      try {
        const tab = await deps.tabs.get(target.tabId)
        if (tab.url !== undefined && isPlayerPageUrl(tab.url)) {
          await deps.tabs
            .sendMessage(target.tabId, { type: "PLAYLIST_STOP" })
            .catch(() => undefined)
          await deps.tabs.remove(target.tabId).catch(() => undefined)
        }
      } catch {
        // Tab already gone — cleanup continues below.
      }
    }
    await clearSession()
  }

  async function forwardToPlayer(command: PlayerCommand): Promise<boolean> {
    const target = player
    if (target === null) return false
    try {
      await deps.tabs.sendMessage(target.tabId, command)
      return true
    } catch {
      return false
    }
  }

  async function onTabRemoved(tabId: number, isWindowClosing: boolean): Promise<void> {
    if (player !== null && player.tabId === tabId) {
      player = null
      await clearSession()
      return
    }
    if (isWindowClosing) return
    const stored = (await deps.readTransient()).playerWindow
    if (stored === undefined) return
    try {
      const tabs = await deps.tabs.query({ windowId: stored.windowId })
      if (tabs.length === 0 || !tabs.some((tab) => tab.id === tabId)) {
        const win = await deps.windows.get(stored.windowId)
        if (win?.id === undefined) throw new PlayerWindowError("window-unavailable", "gone")
      }
    } catch {
      await clearSession()
    }
  }

  async function onWindowRemoved(windowId: number): Promise<void> {
    if (player !== null && player.windowId === windowId) player = null
    const stored = (await deps.readTransient()).playerWindow
    if (stored !== undefined && stored.windowId === windowId) await clearSession()
  }

  return {
    requestPlayer,
    releasePlayer,
    forwardToPlayer,
    recover,
    onTabRemoved,
    onWindowRemoved,
  }
}

/** Exhaustive dispatcher for BackgroundRequest lifecycle kinds. */
export function dispatchLifecycleRequest(
  request:
    | { readonly kind: "REQUEST_PLAYER"; readonly url: string }
    | { readonly kind: "OPEN_PLAYER"; readonly url: string }
    | { readonly kind: "RELEASE_PLAYER" }
    | {
        readonly kind: "FORWARD_TO_PLAYER"
        readonly command: PlayerCommand
        readonly correlationId: string
      },
  manager: PlayerWindowManager,
): Promise<unknown> {
  switch (request.kind) {
    case "REQUEST_PLAYER":
    case "OPEN_PLAYER":
      return manager.requestPlayer(request.url)
    case "RELEASE_PLAYER":
      return manager.releasePlayer().then(() => ({ kind: "released" }))
    case "FORWARD_TO_PLAYER":
      return manager.forwardToPlayer(request.command).then((delivered) =>
        delivered
          ? { correlationId: request.correlationId, ok: true }
          : {
              correlationId: request.correlationId,
              ok: false,
              error: { code: "player-unreachable", message: "no live player tab" },
            },
      )
    default:
      return assertNever(request)
  }
}
