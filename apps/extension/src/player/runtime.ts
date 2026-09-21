// Shared player runtime: dependency surface, mutable session context and the
// small helpers every flow uses (cookies, timers, transient persistence, video
// attach, seek readiness). Mode semantics are ported from content.js with
// generation/owner guards added (plan task 9; legacy defect #3).
import { PAGE_MESSAGE_SOURCE, type PageCommand } from "../../../../packages/shared/src/bridge"
import type {
  LocalPlaylist,
  TransientPlayback,
  TransientState,
} from "../../../../packages/shared/src/local-model"
import type { PublicLocalState } from "../storage/repository"
import {
  NATIVE_SKIP_COOKIE,
  PLAYER_URL_PARAM_KEYS,
  SEEK_ACCEPT_TOLERANCE_MS,
  SEEK_COOLDOWN_PLAYBACK_MS,
  SEEK_READY_DEADLINE_MS,
  SEEK_READY_MAX_ATTEMPTS,
  STARTUP_LOCK_ITEM_MS,
  STARTUP_LOCK_PLAYBACK_MS,
} from "./constants"
import type { EnforcedRange, PlayerModeKind, SameVideoRange } from "./enforcement"
import {
  type ActivePlayback,
  mutateTransientState,
  toTransientPlayback,
  withOpEdMode,
  withOwnedPlaybackCleared,
} from "./transient-session"

/** Minimal video surface shared with the page DOM (never window.vc). */
export type PlayerVideo = {
  readonly currentTime: number
  readonly duration: number
  readonly readyState: number
  readonly paused: boolean
  readonly ended: boolean
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export type PlayerStorage = {
  readonly readPublic: () => Promise<PublicLocalState>
  readonly readTransient: () => Promise<TransientState>
  readonly writeTransient: (state: TransientState) => Promise<unknown>
}

export type ModalButton = {
  readonly label: string
  readonly value: string
  readonly primary?: boolean
}
export type ModalRequest = {
  readonly title: string
  readonly body: string
  readonly buttons: readonly ModalButton[]
}

export type NamedRange = { readonly startMs: number; readonly endMs: number; readonly name: string }

export type CustomDraft = {
  readonly startMs: number | null
  readonly endMs: number | null
  readonly name: string
}

/** Explicit mode machine — idle / playlist / op-ed / custom-preview. */
export type PlayerState =
  | { readonly mode: "idle" }
  | { readonly mode: "playlist"; readonly playback: ActivePlayback }
  | {
      readonly mode: "op-ed"
      readonly ranges: readonly NamedRange[]
      readonly rangeIndex: number
    }
  | {
      readonly mode: "custom-preview"
      readonly draft: CustomDraft
      readonly testing: boolean
    }

export type SeekMarker = {
  readonly startMs: number
  readonly endMs: number
  readonly label: string
  readonly active: boolean
}

export type PlayerUiSnapshot = {
  readonly mode: PlayerModeKind
  /** body.d-op-playlist-active — hides native prev/next (styles, legacy 183-186). */
  readonly playlistActive: boolean
  /** body.d-op-skip-hidden — hides native .skipUi in any active mode. */
  readonly skipUiHidden: boolean
  readonly controlsVisible: boolean
  readonly prevDisabled: boolean
  readonly nextDisabled: boolean
  readonly panelLabel: string
  readonly panelSub: string
  readonly panelMeta: string
  /** Seek-bar markers (legacy runUpdateSeekMarkers, content.js:1009-1065). */
  readonly markers: readonly SeekMarker[]
  /** Custom-preview bar visibility + draft (legacy showCustomRangeBar). */
  readonly customBar: {
    readonly visible: boolean
    readonly startMs: number | null
    readonly endMs: number | null
    readonly name: string
    readonly testing: boolean
  }
}

export type PlayerDeps = {
  readonly now: () => number
  readonly newOwnerToken: () => string
  readonly getVideo: () => PlayerVideo | undefined
  readonly sendPageCommand: (command: PageCommand) => void
  readonly storage: PlayerStorage
  readonly requestPlayer: (url: string) => Promise<unknown>
  readonly getCookie: (name: string) => string | null
  readonly setCookie: (name: string, value: string) => void
  readonly getOpEdSessionFlag: () => boolean
  readonly setOpEdSessionFlag: (active: boolean) => void
  readonly currentUrl: () => string
  readonly replaceUrl: (url: string) => void
  readonly schedule: (callback: () => void, ms: number) => unknown
  readonly cancelTimer: (timer: unknown) => void
  readonly showModal: (request: ModalRequest) => Promise<string | null>
  readonly render: (snapshot: PlayerUiSnapshot) => void
  readonly log?: (label: string, data?: unknown) => void
}

export type PlayerContext = {
  readonly deps: PlayerDeps
  state: PlayerState
  /** Bumped on every mode/part change; stale async work checks it. */
  generation: number
  readonly ownerToken: string
  chapters: readonly EnforcedRange[] | null
  partId: string | null
  playlistName: string
  /** Same-partId playlist items for seek retargeting + markers (content.js:243-246). */
  sameVideoItems: readonly (SameVideoRange & {
    readonly itemId: string
    readonly name: string
  })[]
  seekingStart: boolean
  cooldownUntil: number
  startupLockUntil: number
  lastActionAt: number
  lastPrevClickAt: number
  advancing: boolean
  originalSkipCookie: string | null
  attachedVideo: PlayerVideo | null
  disposed: boolean
}

export function createContext(deps: PlayerDeps): PlayerContext {
  return {
    deps,
    state: { mode: "idle" },
    generation: 1,
    ownerToken: deps.newOwnerToken(),
    chapters: null,
    partId: null,
    playlistName: "",
    sameVideoItems: [],
    seekingStart: false,
    cooldownUntil: 0,
    startupLockUntil: 0,
    lastActionAt: 0,
    lastPrevClickAt: 0,
    advancing: false,
    originalSkipCookie: null,
    attachedVideo: null,
    disposed: false,
  }
}

export function alive(ctx: PlayerContext, generation: number): boolean {
  return !ctx.disposed && ctx.generation === generation
}

export function sendCommand(ctx: PlayerContext, command: PageCommand): void {
  ctx.deps.sendPageCommand(command)
}

export function currentPartId(ctx: PlayerContext): string | null {
  try {
    return new URL(ctx.deps.currentUrl()).searchParams.get("partId")
  } catch {
    return null
  }
}

/** Ranges currently enforced for the active mode (legacy targetRanges). */
export function enforcedRanges(ctx: PlayerContext): readonly EnforcedRange[] {
  const state = ctx.state
  switch (state.mode) {
    case "playlist": {
      const range = state.playback.item.range
      return range === null ? [] : [{ startMs: range.start, endMs: range.end }]
    }
    case "op-ed":
      return state.ranges
    case "custom-preview":
      return state.testing &&
        state.draft.startMs !== null &&
        state.draft.endMs !== null &&
        state.draft.startMs < state.draft.endMs
        ? [{ startMs: state.draft.startMs, endMs: state.draft.endMs }]
        : []
    case "idle":
      return []
  }
}

/** Port of setNativeSkip/resetNativeSkip (content.js:122-138). */
export function setNativeSkip(ctx: PlayerContext, enabled: boolean, blockAutoAdvance = true): void {
  if (ctx.originalSkipCookie === null) {
    ctx.originalSkipCookie = ctx.deps.getCookie(NATIVE_SKIP_COOKIE) ?? "1"
  }
  ctx.deps.setCookie(NATIVE_SKIP_COOKIE, enabled ? ctx.originalSkipCookie : "0")
  if (!enabled && blockAutoAdvance)
    sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "BLOCK_AUTO_ADVANCE" })
}

export function resetNativeSkip(ctx: PlayerContext): void {
  if (ctx.originalSkipCookie !== null) {
    ctx.deps.setCookie(NATIVE_SKIP_COOKIE, ctx.originalSkipCookie)
    ctx.originalSkipCookie = null
  }
  sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "UNBLOCK_AUTO_ADVANCE" })
}

export async function persistPlayback(ctx: PlayerContext, playlist: LocalPlaylist): Promise<void> {
  if (ctx.state.mode !== "playlist") return
  const generation = ctx.generation
  const write = toTransientPlayback(
    ctx.state.playback,
    playlist,
    { token: ctx.ownerToken, generation },
    ctx.deps.now(),
  )
  if (write.kind !== "ok") {
    ctx.deps.log?.("persist-playback-unresolved", { playlistId: playlist.id })
    return
  }
  const playback: TransientPlayback = write.playback
  await mutateTransientState(
    () => ctx.deps.storage.readTransient(),
    (state) => ctx.deps.storage.writeTransient(state),
    (current) => ({ ...current, playback }),
  )
}

/** Clear playback only when this tab owns it — never another owner's state. */
export async function clearOwnedPlayback(ctx: PlayerContext): Promise<void> {
  await mutateTransientState(
    () => ctx.deps.storage.readTransient(),
    (state) => ctx.deps.storage.writeTransient(state),
    (current) => withOwnedPlaybackCleared(current, ctx.ownerToken),
  )
}

export async function setOpEdTransient(ctx: PlayerContext, active: boolean): Promise<void> {
  const now = ctx.deps.now()
  await mutateTransientState(
    () => ctx.deps.storage.readTransient(),
    (state) => ctx.deps.storage.writeTransient(state),
    (current) => withOpEdMode(current, active, now),
  )
}

/**
 * Port of seekToStartWhenReady (content.js:178-227): seek once metadata is
 * ready (or immediately when readyState>=1), retry while the landed position
 * is more than 0.5 s off, give up after 3 attempts or the 3000 ms deadline —
 * onReady always fires unless the generation went stale.
 */
export function seekToStartWhenReady(
  ctx: PlayerContext,
  startMs: number,
  onReady: () => void,
): void {
  const generation = ctx.generation
  const video = ctx.deps.getVideo()
  if (!video) {
    if (alive(ctx, generation)) onReady()
    return
  }
  let attempts = 0
  const doSeek = (): void => {
    if (!alive(ctx, generation)) return
    attempts += 1
    sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "SEEK", timeMs: startMs })
    const onSeeked = (): void => {
      video.removeEventListener("seeked", onSeeked)
      ctx.deps.cancelTimer(fallback)
      if (!alive(ctx, generation)) return
      if (Math.abs(video.currentTime * 1000 - startMs) < SEEK_ACCEPT_TOLERANCE_MS) onReady()
      else if (attempts < SEEK_READY_MAX_ATTEMPTS) doSeek()
      else onReady()
    }
    video.addEventListener("seeked", onSeeked)
    const fallback = ctx.deps.schedule(() => {
      video.removeEventListener("seeked", onSeeked)
      if (alive(ctx, generation)) onReady()
    }, SEEK_READY_DEADLINE_MS)
  }
  if (video.readyState >= 1 && video.duration) {
    doSeek()
    return
  }
  const onMetadata = (): void => {
    video.removeEventListener("loadedmetadata", onMetadata)
    ctx.deps.cancelTimer(metaFallback)
    doSeek()
  }
  const metaFallback = ctx.deps.schedule(() => {
    video.removeEventListener("loadedmetadata", onMetadata)
    if (alive(ctx, generation)) onReady()
  }, SEEK_READY_DEADLINE_MS)
  video.addEventListener("loadedmetadata", onMetadata)
}

/** Apply the playback-start cooldowns (content.js:247-260). */
export function armPlaybackStart(ctx: PlayerContext, sameEpisode: boolean): void {
  const now = ctx.deps.now()
  ctx.cooldownUntil = now + SEEK_COOLDOWN_PLAYBACK_MS
  ctx.seekingStart = true
  ctx.lastActionAt = 0
  ctx.startupLockUntil = now + (sameEpisode ? STARTUP_LOCK_ITEM_MS : STARTUP_LOCK_PLAYBACK_MS)
}

const EMPTY_BAR = {
  visible: false,
  startMs: null,
  endMs: null,
  name: "",
  testing: false,
} as const

function playlistMarkers(ctx: PlayerContext, currentItemId: string): readonly SeekMarker[] {
  return ctx.sameVideoItems.map((item) => ({
    startMs: item.startMs,
    endMs: item.endMs,
    label: item.name,
    active: item.itemId === currentItemId,
  }))
}

/** Build the render snapshot — ports updatePlaylistUI/showTopRightPanel state
 *  (content.js:747-786, 799-864). Native prev/next hide only under
 *  playlistActive; .skipUi hides under any active mode. */
export function playerUiSnapshot(ctx: PlayerContext): PlayerUiSnapshot {
  const state = ctx.state
  switch (state.mode) {
    case "playlist": {
      const playback = state.playback
      const position = playback.order.indexOf(playback.currentItemId)
      return {
        mode: "playlist",
        playlistActive: true,
        skipUiHidden: true,
        controlsVisible: true,
        prevDisabled: position <= 0,
        nextDisabled: position >= playback.order.length - 1,
        panelLabel: playback.item.range?.name ?? "範囲",
        panelSub: playback.mode === "shuffle" ? `SHUFFLE - ${ctx.playlistName}` : ctx.playlistName,
        panelMeta: `${position + 1} / ${playback.order.length}`,
        markers: playlistMarkers(ctx, playback.currentItemId),
        customBar: EMPTY_BAR,
      }
    }
    case "op-ed":
      return {
        mode: "op-ed",
        playlistActive: false,
        skipUiHidden: true,
        controlsVisible: false,
        prevDisabled: true,
        nextDisabled: true,
        panelLabel: "OP/ED",
        panelSub: "",
        panelMeta: "",
        markers: state.ranges.map((range, index) => ({
          startMs: range.startMs,
          endMs: range.endMs,
          label: range.name,
          active: index === state.rangeIndex,
        })),
        customBar: EMPTY_BAR,
      }
    case "custom-preview":
      return {
        mode: "custom-preview",
        playlistActive: false,
        skipUiHidden: true,
        controlsVisible: false,
        prevDisabled: true,
        nextDisabled: true,
        panelLabel: state.draft.name || "CUSTOM",
        panelSub: "",
        panelMeta: "",
        markers:
          state.draft.startMs !== null &&
          state.draft.endMs !== null &&
          state.draft.startMs < state.draft.endMs
            ? [
                {
                  startMs: state.draft.startMs,
                  endMs: state.draft.endMs,
                  label: state.draft.name || "CUSTOM",
                  active: true,
                },
              ]
            : [],
        customBar: {
          visible: true,
          startMs: state.draft.startMs,
          endMs: state.draft.endMs,
          name: state.draft.name,
          testing: state.testing,
        },
      }
    case "idle":
      return {
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
        customBar: EMPTY_BAR,
      }
  }
}

export function renderPlayerUi(ctx: PlayerContext): void {
  ctx.deps.render(playerUiSnapshot(ctx))
}

/**
 * Port of clearPlaylistState (content.js:140-159): restore the native skip
 * cookie, unblock auto-advance, clear owned playback + op-ed intent, strip dop*
 * URL params, return to idle. Owner-guarded: only clears transient playback
 * written by this tab's ownerToken.
 */
export async function stopPlayback(ctx: PlayerContext): Promise<void> {
  ctx.generation += 1
  resetNativeSkip(ctx)
  ctx.state = { mode: "idle" }
  ctx.sameVideoItems = []
  ctx.playlistName = ""
  ctx.seekingStart = false
  ctx.cooldownUntil = 0
  ctx.lastActionAt = 0
  ctx.startupLockUntil = 0
  try {
    await clearOwnedPlayback(ctx)
    await setOpEdTransient(ctx, false)
  } catch (error) {
    ctx.deps.log?.("transient-clear-failed", error)
  }
  ctx.deps.setOpEdSessionFlag(false)
  ctx.deps.replaceUrl(stripUrl(ctx.deps.currentUrl()))
  renderPlayerUi(ctx)
}

function stripUrl(href: string): string {
  try {
    const url = new URL(href)
    for (const key of PLAYER_URL_PARAM_KEYS) url.searchParams.delete(key)
    return url.toString()
  } catch {
    return href
  }
}
