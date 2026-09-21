// Shared fake harness for player orchestration tests. Every dependency of
// PlayerDeps is controllable: the fake video fires DOM-style events, timers
// are manual, storage goes through the real transient codec on an in-memory
// driver, and page commands are recorded (and can drive the fake video).
import type { PageCommand } from "../../../../packages/shared/src/bridge"
import type { LocalPlaylist, TransientState } from "../../../../packages/shared/src/local-model"
import type {
  ModalRequest,
  PlayerDeps,
  PlayerUiSnapshot,
  PlayerVideo,
} from "../../src/player/runtime"
import { InMemoryStorageDriver } from "../../src/storage/driver"
import type { PublicLocalState } from "../../src/storage/repository"
import {
  emptyTransientState,
  readTransientState,
  writeTransientState,
} from "../../src/storage/transient"

export class FakeVideo implements PlayerVideo {
  currentTime = 0
  duration = 180
  readyState = 1
  paused = true
  ended = false
  readonly listeners = new Map<string, Set<() => void>>()

  addEventListener(type: string, listener: () => void): void {
    let set = this.listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }
}

export type FakeTimer = { readonly callback: () => void; readonly ms: number }

export type Harness = {
  readonly deps: PlayerDeps
  readonly video: FakeVideo
  readonly commands: PageCommand[]
  readonly cookies: Map<string, string>
  readonly renders: PlayerUiSnapshot[]
  readonly modalRequests: ModalRequest[]
  readonly requestedPlayers: string[]
  readonly replacedUrls: string[]
  readonly timers: FakeTimer[]
  readonly driver: InMemoryStorageDriver
  readonly flushTimers: () => void
  setUrl(url: string): void
  setNow(now: number): void
  setOpEdFlag(active: boolean): void
  getOpEdFlag(): boolean
  answerModal(value: string): void
}

export type HarnessOptions = {
  readonly url?: string
  readonly playlists?: readonly LocalPlaylist[]
  readonly transient?: TransientState
  /** When true, fake SEEK/PLAY/PAUSE commands drive the fake video. */
  readonly videoFollowsCommands?: boolean
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const video = new FakeVideo()
  const commands: PageCommand[] = []
  const cookies = new Map<string, string>()
  const renders: PlayerUiSnapshot[] = []
  const modalRequests: ModalRequest[] = []
  const requestedPlayers: string[] = []
  const replacedUrls: string[] = []
  const timers: FakeTimer[] = []
  const driver = new InMemoryStorageDriver()
  let url = options.url ?? "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=p1"
  let now = 1_000_000
  let opedFlag = false
  let pendingModal: ((value: string | null) => void) | undefined

  if (options.transient !== undefined) void writeTransientState(driver, options.transient)

  const publicState: PublicLocalState = {
    schemaVersion: 2,
    revision: 0,
    playlists: [...(options.playlists ?? [])],
    preferences: { windowMode: "window", collapsedPlaylists: {} },
  }

  const harness: Harness = {
    video,
    commands,
    cookies,
    renders,
    modalRequests,
    requestedPlayers,
    replacedUrls,
    timers,
    driver,
    setUrl: (next) => {
      url = next
    },
    setNow: (value) => {
      now = value
    },
    setOpEdFlag: (active) => {
      opedFlag = active
    },
    getOpEdFlag: () => opedFlag,
    answerModal: (value) => pendingModal?.(value),
    flushTimers: () => {
      const pending = [...timers]
      timers.length = 0
      for (const timer of pending) timer.callback()
    },
    deps: {
      now: () => now,
      newOwnerToken: () => crypto.randomUUID(),
      getVideo: () => video,
      sendPageCommand: (command) => {
        commands.push(command)
        if (options.videoFollowsCommands !== true) return
        if (command.type === "SEEK") {
          video.currentTime = command.timeMs / 1000
          queueMicrotask(() => video.fire("seeked"))
        } else if (command.type === "PLAY") {
          video.paused = false
        } else if (command.type === "PAUSE") {
          video.paused = true
        }
      },
      storage: {
        readPublic: async () => publicState,
        readTransient: () => readTransientState(driver),
        writeTransient: (state) => writeTransientState(driver, state),
      },
      requestPlayer: async (target) => {
        requestedPlayers.push(target)
      },
      getCookie: (name) => cookies.get(name) ?? null,
      setCookie: (name, value) => {
        cookies.set(name, value)
      },
      getOpEdSessionFlag: () => opedFlag,
      setOpEdSessionFlag: (active) => {
        opedFlag = active
      },
      currentUrl: () => url,
      replaceUrl: (next) => {
        replacedUrls.push(next)
        url = next
      },
      schedule: (callback, ms) => {
        const timer = { callback, ms }
        timers.push(timer)
        return timer
      },
      cancelTimer: (timer) => {
        const index = timers.indexOf(timer as FakeTimer)
        if (index >= 0) timers.splice(index, 1)
      },
      showModal: (request) => {
        modalRequests.push(request)
        return new Promise<string | null>((resolve) => {
          pendingModal = resolve
        })
      },
      render: (snapshot) => {
        renders.push(snapshot)
      },
    },
  }
  return harness
}

export function transientOf(driver: InMemoryStorageDriver): Promise<TransientState> {
  return readTransientState(driver)
}

export { emptyTransientState }
