// Playlist-mode flows — ports content.js startPlayback (229-267),
// playPlaylistIndex/advancePlayback/goToPlaylistItem (269-328), end menu
// (330-350), handlePrevClick (352-367), URL param start (386-406),
// resumePlaybackIfAny (1406-1436) and jumpToPlaylistIndex (1438-1449).
// Navigation itself delegates to the item-ID domain (src/domain/navigation.ts):
// reconcile before every action, removed current item stops, boundaries never
// wrap, restart is a separate explicit action.
import { PAGE_MESSAGE_SOURCE } from "../../../../packages/shared/src/bridge"
import type { LocalItem, LocalPlaylist } from "../../../../packages/shared/src/local-model"
import { navigate, type Playback, reconcileShuffleOrder, startNavigation } from "../domain/index"
import { decidePreviousClick } from "./enforcement"
import {
  alive,
  armPlaybackStart,
  currentPartId,
  type PlayerContext,
  persistPlayback,
  renderPlayerUi,
  seekToStartWhenReady,
  sendCommand,
  setNativeSkip,
  stopPlayback,
} from "./runtime"
import { type ActivePlayback, fromTransientPlayback } from "./transient-session"
import { buildPlaylistItemUrl } from "./url-params"

export type { ActivePlayback }

function domainPlayback(playback: ActivePlayback, now: number): Playback {
  return {
    playlistId: playback.playlistId,
    currentItemId: playback.currentItemId,
    order: playback.order,
    mode: playback.mode,
    updatedAt: now,
  }
}

function itemPlaybackUrl(item: LocalItem): string {
  // Legacy used item.url verbatim (content.js:321); v2 tolerates a missing url
  // by rebuilding from partId on the primary supported origin.
  if (item.url !== undefined && URL.parse(item.url) !== null) return item.url
  return `https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=${encodeURIComponent(item.partId)}`
}

export function findPlaylist(
  ctx: PlayerContext,
  playlistId: string,
): Promise<LocalPlaylist | undefined> {
  return ctx.deps.storage
    .readPublic()
    .then((state) => state.playlists.find((playlist) => playlist.id === playlistId))
}

/** Same-video item index used by the seek-retarget rule (content.js:241-245). */
export function refreshSameVideoItems(ctx: PlayerContext, playlist: LocalPlaylist): void {
  const partId = currentPartId(ctx)
  ctx.sameVideoItems = playlist.items
    .filter((item) => item.partId === partId && item.range !== null)
    .map((item) => ({
      itemId: item.id,
      startMs: item.range?.start ?? 0,
      endMs: item.range?.end ?? 0,
      name: item.range?.name ?? "",
    }))
}

async function persistQuietly(ctx: PlayerContext, playlist: LocalPlaylist): Promise<void> {
  try {
    await persistPlayback(ctx, playlist)
  } catch (error) {
    ctx.deps.log?.("persist-playback-failed", error)
  }
}

/**
 * Port of startPlayback. `sameEpisode` keeps the running order and short
 * startup lock (legacy playItemInCurrentVideo). A null-range item plays the
 * full episode from zero after readiness (plan Local data step 5) — legacy
 * silently returned instead; the delta is recorded in DoneClaim evidence.
 */
export async function startPlaylistItem(
  ctx: PlayerContext,
  playlist: LocalPlaylist,
  item: LocalItem,
  options: {
    readonly sameEpisode: boolean
    readonly order?: readonly string[]
    readonly mode?: "ordered" | "shuffle"
  },
): Promise<void> {
  const prior = ctx.state.mode === "playlist" ? ctx.state.playback : undefined
  const rawOrder = options.sameEpisode
    ? (prior?.order ?? options.order ?? playlist.items.map((entry) => entry.id))
    : (options.order ?? playlist.items.map((entry) => entry.id))
  const mode = options.sameEpisode
    ? (prior?.mode ?? options.mode ?? "ordered")
    : (options.mode ?? "ordered")
  const reconciled = reconcileShuffleOrder(
    playlist.items.map((entry) => entry.id),
    rawOrder,
    item.id,
  )
  if (reconciled.kind !== "ready") return
  ctx.generation += 1
  ctx.playlistName = playlist.name
  ctx.state = {
    mode: "playlist",
    playback: {
      playlistId: playlist.id,
      order: reconciled.order,
      currentItemId: item.id,
      item,
      mode,
      endMenuShown: false,
    },
  }
  refreshSameVideoItems(ctx, playlist)
  armPlaybackStart(ctx, options.sameEpisode)
  await persistQuietly(ctx, playlist)
  setNativeSkip(ctx, false)
  renderPlayerUi(ctx)
  const startMs = item.range?.start ?? 0
  if (!options.sameEpisode) sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "PAUSE" })
  seekToStartWhenReady(ctx, startMs, () =>
    sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "PLAY" }),
  )
}

/** Same partId switches in place; anything else navigates (content.js:273-282). */
export async function playResolvedItem(
  ctx: PlayerContext,
  playlist: LocalPlaylist,
  playback: ActivePlayback,
  item: LocalItem,
): Promise<void> {
  if (item.partId === currentPartId(ctx)) {
    ctx.generation += 1
    ctx.state = { mode: "playlist", playback }
    refreshSameVideoItems(ctx, playlist)
    armPlaybackStart(ctx, true)
    await persistQuietly(ctx, playlist)
    setNativeSkip(ctx, false)
    renderPlayerUi(ctx)
    seekToStartWhenReady(ctx, item.range?.start ?? 0, () =>
      sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "PLAY" }),
    )
    return
  }
  // Cross-episode: persist order first so the next page restores it
  // (content.js:317-327), then hand the URL to the background singleton.
  ctx.generation += 1
  ctx.state = { mode: "playlist", playback }
  renderPlayerUi(ctx)
  await persistQuietly(ctx, playlist)
  const realIndex = playlist.items.findIndex((candidate) => candidate.id === item.id)
  const url = buildPlaylistItemUrl(itemPlaybackUrl(item), playlist.id, Math.max(0, realIndex))
  await ctx.deps.requestPlayer(url)
}

/** advancePlayback (content.js:284-315) with the advancing mutex preserved. */
export async function advancePlayback(ctx: PlayerContext, direction: 1 | -1): Promise<boolean> {
  if (ctx.state.mode !== "playlist") return false
  if (ctx.advancing) return false
  ctx.advancing = true
  const generation = ctx.generation
  try {
    const playback = ctx.state.playback
    const playlist = await findPlaylist(ctx, playback.playlistId)
    if (!alive(ctx, generation) || ctx.state.mode !== "playlist") return false
    // Domain reconcile happens inside navigate(); a missing playlist stops.
    const result = navigate({
      playlist: playlist ?? null,
      playback: domainPlayback(playback, ctx.deps.now()),
      direction: direction === 1 ? "next" : "previous",
      clock: ctx.deps.now,
    })
    switch (result.kind) {
      case "stop":
        await stopPlayback(ctx)
        return false
      case "boundary":
        if (result.edge === "end" && playlist !== undefined) {
          if (!ctx.state.playback.endMenuShown) {
            ctx.state.playback.endMenuShown = true
            sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "PAUSE" })
            void showEndMenu(ctx, playlist)
          }
        } else {
          sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "PAUSE" })
        }
        return false
      case "target": {
        if (playlist === undefined) return false
        const next: ActivePlayback = {
          playlistId: playback.playlistId,
          order: result.playback.order,
          currentItemId: result.item.id,
          item: result.item,
          mode: playback.mode,
          endMenuShown: false,
        }
        await playResolvedItem(ctx, playlist, next, result.item)
        return true
      }
    }
  } finally {
    ctx.advancing = false
  }
}

/** End-of-playlist modal (content.js:330-350): restart / stay / clear. */
async function showEndMenu(ctx: PlayerContext, playlist: LocalPlaylist): Promise<void> {
  const generation = ctx.generation
  const value = await ctx.deps.showModal({
    title: "再生終了",
    body: "プレイリストの最後まで再生しました",
    buttons: [
      { label: "最初から再生", value: "restart" },
      { label: "このまま継続", value: "continue", primary: true },
      { label: "モードを解除", value: "close" },
    ],
  })
  if (!alive(ctx, generation)) return
  if (value === "restart") {
    // Legacy cleared state then played real index 0 ordered — restart is an
    // explicit action, never a wrap-around (domain startNavigation).
    await stopPlayback(ctx)
    const first = playlist.items[0]
    if (first === undefined) return
    const started = startNavigation({
      playlist,
      currentItemId: first.id,
      order: playlist.items.map((item) => item.id),
      mode: "ordered",
      clock: ctx.deps.now,
    })
    if (started.kind === "target") {
      await playResolvedItem(
        ctx,
        playlist,
        {
          playlistId: playlist.id,
          order: started.playback.order,
          currentItemId: first.id,
          item: first,
          mode: "ordered",
          endMenuShown: false,
        },
        first,
      )
    }
    return
  }
  if (value === "continue") return // stay paused; endMenuShown resets in-range
  await stopPlayback(ctx)
}

/** Prev button semantics (content.js:352-367). */
export async function handlePrevClick(ctx: PlayerContext): Promise<void> {
  if (ctx.state.mode !== "playlist") return
  const playback = ctx.state.playback
  const video = ctx.deps.getVideo()
  const now = ctx.deps.now()
  const decision = decidePreviousClick({
    hasPlayback: true,
    positionMs: video ? video.currentTime * 1000 : null,
    rangeStartMs: playback.item.range?.start ?? null,
    lastPrevClickAt: ctx.lastPrevClickAt,
    now,
  })
  ctx.lastPrevClickAt = now
  if (decision.kind === "step-back") {
    await advancePlayback(ctx, -1)
    return
  }
  if (decision.kind === "restart-range") {
    sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "SEEK", timeMs: decision.timeMs })
    if (video?.paused) sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "PLAY" })
  }
}

/** PLAYLIST_JUMP — display/order position (content.js:1438-1449). */
export async function jumpToOrderPosition(ctx: PlayerContext, index: number): Promise<void> {
  const generation = ctx.generation
  let playlist: LocalPlaylist | undefined
  let order: readonly string[] = []
  let mode: "ordered" | "shuffle" = "ordered"
  let currentItemId = ""
  if (ctx.state.mode === "playlist") {
    playlist = await findPlaylist(ctx, ctx.state.playback.playlistId)
    order = ctx.state.playback.order
    mode = ctx.state.playback.mode
    currentItemId = ctx.state.playback.currentItemId
  } else {
    const transient = await ctx.deps.storage.readTransient()
    const stored = transient.playback
    if (!alive(ctx, generation) || stored === undefined) return
    playlist = await findPlaylist(ctx, stored.playlistId)
    if (!alive(ctx, generation) || playlist === undefined) return
    const restored = fromTransientPlayback(stored, playlist)
    if (restored === null) return
    order = restored.order
    mode = restored.mode
    currentItemId = restored.currentItemId
  }
  if (!alive(ctx, generation) || playlist === undefined) return
  const reconciled = reconcileShuffleOrder(
    playlist.items.map((item) => item.id),
    order,
    playlist.items.some((item) => item.id === currentItemId) ? currentItemId : order[0] || "",
  )
  const orderList = reconciled.kind === "ready" ? reconciled.order : order
  const itemId = orderList[index]
  const item = playlist.items.find((candidate) => candidate.id === itemId)
  if (item === undefined || itemId === undefined) return
  await playResolvedItem(
    ctx,
    playlist,
    {
      playlistId: playlist.id,
      order: orderList,
      currentItemId: item.id,
      item,
      mode,
      endMenuShown: false,
    },
    item,
  )
}
