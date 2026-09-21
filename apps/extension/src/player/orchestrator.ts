// Player orchestrator — the explicit idle/playlist/op-ed/custom-preview state
// machine. Ports handleChapters (content.js:1468-1500), attachVideoListener
// (569-584), onSeeking/onSeeked/onVideoEnded (549-567), handleRuntimeMessage
// (1451-1466) and the debounced MutationObserver reattach (1550-1566). Async
// completions are guarded by ctx.generation + ownerToken; enforcement itself
// is decided by the pure enforcement.ts module.
import {
  type ChaptersFound,
  PAGE_MESSAGE_SOURCE,
  type PlayerCommand,
} from "../../../../packages/shared/src/bridge"
import { assertNever } from "../../../../packages/shared/src/limits"
import {
  DOM_MUTATION_DEBOUNCE_MS,
  SEEK_COOLDOWN_PLAYBACK_MS,
  SEEK_COOLDOWN_SEEKED_MS,
  SEEK_COOLDOWN_SEEKING_MS,
  SEEK_MARKER_DEBOUNCE_MS,
} from "./constants"
import { decideEnforcement, type PlayerModeKind } from "./enforcement"
import {
  beginCustomPreview,
  cancelCustomPreview,
  enterOpEdMode,
  startWorkPageRange,
  testCustomPreview,
  updateCustomDraft,
} from "./mode-flow"
import {
  advancePlayback,
  findPlaylist,
  handlePrevClick,
  jumpToOrderPosition,
  refreshSameVideoItems,
} from "./playlist-flow"
import { resumePlaybackIfAny, startFromPlaylistParams } from "./resume-flow"
import {
  alive,
  type CustomDraft,
  createContext,
  currentPartId,
  enforcedRanges,
  type PlayerContext,
  type PlayerDeps,
  persistPlayback,
  renderPlayerUi,
  resetNativeSkip,
  sendCommand,
  stopPlayback,
} from "./runtime"
import { isOpEdModeFresh, mutateTransientState, withOpEdMode } from "./transient-session"
import { readPlayerUrlParams, stripPlayerUrlParams } from "./url-params"

export type CustomPreviewApi = {
  readonly begin: () => Promise<boolean>
  readonly updateDraft: (patch: {
    readonly startMs?: number | null
    readonly endMs?: number | null
    readonly name?: string
  }) => void
  readonly test: () => Promise<boolean>
  readonly cancel: () => Promise<void>
  /** Live draft for the add-menu's '追加' button; null outside selection. */
  readonly draft: () => CustomDraft | null
}

export type PlayerOrchestrator = {
  readonly handleChapters: (payload: ChaptersFound) => Promise<void>
  readonly handleCommand: (command: PlayerCommand) => Promise<void>
  readonly handleDomMutation: () => void
  /** Canonical storage writes (any surface) → debounced marker refresh. */
  readonly handleStorageChange: () => void
  /** Current partId + chapter list for the ♪ add menu. */
  readonly session: () => {
    readonly partId: string | null
    readonly chapters: PlayerContext["chapters"]
  }
  readonly customPreview: CustomPreviewApi
  readonly dispose: () => void
  readonly mode: () => PlayerModeKind
}

const VIDEO_EVENTS = ["timeupdate", "seeking", "seeked", "ended"] as const

export function createPlayerOrchestrator(deps: PlayerDeps): PlayerOrchestrator {
  const ctx = createContext(deps)
  let domTimer: unknown
  let markerTimer: unknown
  let markersRefreshing = false
  let markersQueued = false

  function onSeeking(): void {
    const now = deps.now()
    if (now < ctx.startupLockUntil) return
    ctx.cooldownUntil = now + SEEK_COOLDOWN_SEEKING_MS
  }

  function onSeeked(): void {
    const now = deps.now()
    if (now < ctx.startupLockUntil) return
    ctx.cooldownUntil = now + SEEK_COOLDOWN_SEEKED_MS
  }

  function onEnded(): void {
    if (ctx.state.mode === "playlist") void advancePlayback(ctx, 1)
  }

  const listeners: Record<(typeof VIDEO_EVENTS)[number], () => void> = {
    timeupdate: () => enforce(),
    seeking: onSeeking,
    seeked: onSeeked,
    ended: onEnded,
  }

  /** Port of attachVideoListener (content.js:569-584). */
  function attachVideo(): void {
    const video = deps.getVideo()
    if (video === undefined || ctx.attachedVideo === video) return
    if (ctx.attachedVideo !== null) {
      for (const event of VIDEO_EVENTS) {
        ctx.attachedVideo.removeEventListener(event, listeners[event])
      }
    }
    ctx.attachedVideo = video
    for (const event of VIDEO_EVENTS) video.addEventListener(event, listeners[event])
  }

  /** trySwitchToOtherRange retarget (content.js:529-546): swap the current
   *  item inside the same video, re-arm cooldown, persist + repaint. */
  async function switchToItem(itemId: string): Promise<void> {
    if (ctx.state.mode !== "playlist") return
    const generation = ctx.generation
    const playback = ctx.state.playback
    const playlist = await findPlaylist(ctx, playback.playlistId)
    if (!alive(ctx, generation) || ctx.state.mode !== "playlist" || playlist === undefined) return
    const item = playlist.items.find((candidate) => candidate.id === itemId)
    if (item === undefined || item.id === playback.currentItemId) return
    ctx.state = {
      mode: "playlist",
      playback: { ...playback, currentItemId: item.id, item },
    }
    ctx.cooldownUntil = deps.now() + SEEK_COOLDOWN_PLAYBACK_MS
    refreshSameVideoItems(ctx, playlist)
    try {
      await persistPlayback(ctx, playlist)
    } catch (error) {
      deps.log?.("persist-playback-failed", error)
    }
    renderPlayerUi(ctx)
  }

  /** Apply a pure enforcement decision — the only place page commands fire. */
  function enforce(): void {
    const video = deps.getVideo()
    if (video === undefined) return // legacy returns early without a video
    const state = ctx.state
    const decision = decideEnforcement({
      mode: state.mode,
      hasPlayback: state.mode === "playlist",
      fullEpisode: state.mode === "playlist" && state.playback.item.range === null,
      ranges: enforcedRanges(ctx),
      positionMs: video.currentTime * 1000,
      durationMs: Number.isFinite(video.duration)
        ? video.duration * 1000
        : Number.POSITIVE_INFINITY,
      ended: video.ended,
      seekingStart: ctx.seekingStart,
      now: deps.now(),
      lastActionAt: ctx.lastActionAt,
      cooldownUntil: ctx.cooldownUntil,
      sameVideoItems: ctx.sameVideoItems,
      currentItemId: state.mode === "playlist" ? state.playback.currentItemId : null,
    })
    switch (decision.kind) {
      case "none":
        return
      case "in-range":
        // content.js:470-478 — landing inside clears seekingStart and the
        // end-menu latch so the next end visit re-offers the menu.
        ctx.seekingStart = false
        if (ctx.state.mode === "playlist" && ctx.state.playback.endMenuShown) {
          ctx.state.playback.endMenuShown = false
          renderPlayerUi(ctx)
        }
        return
      case "seek":
      case "seek-end":
        ctx.lastActionAt = deps.now()
        sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "SEEK", timeMs: decision.timeMs })
        return
      case "pause":
        ctx.lastActionAt = deps.now()
        sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "PAUSE" })
        return
      case "advance":
        ctx.lastActionAt = deps.now()
        sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "PAUSE" })
        void advancePlayback(ctx, 1)
        return
      case "switch-item":
        ctx.lastActionAt = deps.now()
        void switchToItem(decision.itemId)
        return
      default:
        assertNever(decision)
    }
  }

  /** checkUrlParams (content.js:386-406): dop* params are stripped via
   *  history.replaceState BEFORE acting so a reload never re-triggers. */
  async function checkUrlParams(generation: number): Promise<void> {
    const params = readPlayerUrlParams(deps.currentUrl())
    if (params.playlistId !== null && params.playlistIndex !== null) {
      deps.replaceUrl(stripPlayerUrlParams(deps.currentUrl()))
      if (await startFromPlaylistParams(ctx, params.playlistId, params.playlistIndex)) return
      if (!alive(ctx, generation)) return
    }
    if (params.rangeIndex !== null) {
      deps.replaceUrl(stripPlayerUrlParams(deps.currentUrl()))
      await startWorkPageRange(ctx, params.rangeIndex)
    }
  }

  /**
   * Refresh ctx.libraryRanges (and sameVideoItems while playlist mode is
   * live) from the canonical public snapshot — the marker overlay's library
   * half. Ports the storage side of updateSeekMarkers (content.js:958-1007);
   * serialized so overlapping reads cannot paint stale state.
   */
  async function refreshLibraryRanges(): Promise<void> {
    const generation = ctx.generation
    const partId = currentPartId(ctx)
    const state = await deps.storage.readPublic().catch((error: unknown) => {
      deps.log?.("library-ranges-read-failed", error)
      return null
    })
    if (state === null) return
    if (!alive(ctx, generation)) return
    const ranges: { startMs: number; endMs: number; name: string }[] = []
    if (partId !== null) {
      for (const playlist of state.playlists) {
        for (const item of playlist.items) {
          const range = item.range
          if (item.partId !== partId || range === null) continue
          ranges.push({ startMs: range.start, endMs: range.end, name: range.name ?? "" })
        }
      }
    }
    ctx.libraryRanges = ranges
    if (ctx.state.mode === "playlist") {
      const playlist = state.playlists.find(
        (candidate) =>
          ctx.state.mode === "playlist" && candidate.id === ctx.state.playback.playlistId,
      )
      if (playlist !== undefined) refreshSameVideoItems(ctx, playlist)
    }
    renderPlayerUi(ctx)
  }

  async function runLibraryRefresh(): Promise<void> {
    if (markersRefreshing) {
      markersQueued = true
      return
    }
    markersRefreshing = true
    try {
      do {
        markersQueued = false
        await refreshLibraryRanges()
      } while (markersQueued && !ctx.disposed)
    } finally {
      markersRefreshing = false
    }
  }

  /** Debounced entry — legacy scheduleUpdateSeekMarkers (content.js:995-1007):
   *  marker reads never run more than once per SEEK_MARKER_DEBOUNCE_MS and a
   *  pending refresh coalesces instead of overlapping. */
  function handleStorageChange(): void {
    if (ctx.disposed) return
    if (markerTimer !== undefined) deps.cancelTimer(markerTimer)
    const generation = ctx.generation
    markerTimer = deps.schedule(() => {
      markerTimer = undefined
      if (!alive(ctx, generation)) return
      void runLibraryRefresh()
    }, SEEK_MARKER_DEBOUNCE_MS)
  }

  /** handleChapters (content.js:1468-1500). */
  async function handleChapters(payload: ChaptersFound): Promise<void> {
    const partId = readPlayerUrlParams(deps.currentUrl()).partId
    const partIdChanged = ctx.partId !== partId
    ctx.chapters = payload.chapters.map((chapter) => ({
      startMs: chapter.startMs,
      endMs: chapter.endMs,
    }))
    if (partIdChanged) {
      ctx.partId = partId
      if (ctx.state.mode === "idle") {
        resetNativeSkip(ctx)
      } else if (ctx.state.mode === "op-ed") {
        await enterOpEdMode(ctx, 0)
      }
    }
    attachVideo()
    renderPlayerUi(ctx)
    // Chapters arrival = marker source change — refresh library ranges like
    // legacy handleChapters → updateSeekMarkers (content.js:1488).
    handleStorageChange()
    const generation = ctx.generation
    await checkUrlParams(generation)
    if (!alive(ctx, generation)) return
    await resumePlaybackIfAny(ctx)
    if (!alive(ctx, generation) || ctx.state.mode !== "idle") return
    const transient = await deps.storage.readTransient()
    if (!alive(ctx, generation) || ctx.state.mode !== "idle") return
    if (isOpEdModeFresh(transient, deps.now()) && deps.getOpEdSessionFlag()) {
      await enterOpEdMode(ctx, 0)
      return
    }
    // Stale or foreign op-ed intent is dead state — clear it and the flag
    // (content.js:1493-1498).
    await mutateTransientState(
      () => deps.storage.readTransient(),
      (next) => deps.storage.writeTransient(next),
      (current) => withOpEdMode(current, false, deps.now()),
    )
    deps.setOpEdSessionFlag(false)
  }

  async function handleCommand(command: PlayerCommand): Promise<void> {
    switch (command.type) {
      case "PLAYLIST_PREV":
        await handlePrevClick(ctx)
        return
      case "PLAYLIST_NEXT":
        await advancePlayback(ctx, 1)
        return
      case "PLAYLIST_STOP":
        await stopPlayback(ctx)
        return
      case "PLAYLIST_JUMP":
        await jumpToOrderPosition(ctx, command.index)
        return
      default:
        assertNever(command)
    }
  }

  /** Debounced MutationObserver body — reattaches the video element and
   *  repaints controls when the SPA rebuilds the player DOM (content.js:
   *  1550-1566; v2 adds the debounce + generation guard). */
  function handleDomMutation(): void {
    if (ctx.disposed) return
    if (domTimer !== undefined) deps.cancelTimer(domTimer)
    const generation = ctx.generation
    domTimer = deps.schedule(() => {
      domTimer = undefined
      if (!alive(ctx, generation)) return
      attachVideo()
      renderPlayerUi(ctx)
    }, DOM_MUTATION_DEBOUNCE_MS)
  }

  function dispose(): void {
    if (ctx.disposed) return
    ctx.disposed = true
    ctx.generation += 1
    if (domTimer !== undefined) deps.cancelTimer(domTimer)
    domTimer = undefined
    if (markerTimer !== undefined) deps.cancelTimer(markerTimer)
    markerTimer = undefined
    if (ctx.attachedVideo !== null) {
      for (const event of VIDEO_EVENTS) {
        ctx.attachedVideo.removeEventListener(event, listeners[event])
      }
      ctx.attachedVideo = null
    }
    // Restore the native skip cookie + auto-advance hooks on teardown
    // (plan: restore callbacks/cookie on dispose where possible).
    resetNativeSkip(ctx)
  }

  return {
    handleChapters,
    handleCommand,
    handleDomMutation,
    handleStorageChange,
    session: () => ({ partId: currentPartId(ctx), chapters: ctx.chapters }),
    customPreview: {
      begin: () => beginCustomPreview(ctx),
      updateDraft: (patch) => updateCustomDraft(ctx, patch),
      test: () => testCustomPreview(ctx),
      cancel: () => cancelCustomPreview(ctx),
      draft: () => (ctx.state.mode === "custom-preview" ? ctx.state.draft : null),
    },
    dispose,
    mode: () => ctx.state.mode,
  }
}

export type { PlayerContext }
