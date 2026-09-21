// Resume and URL-param entry flows — ports checkUrlParams playlist branch
// (content.js:386-400) and resumePlaybackIfAny (content.js:1406-1436) onto the
// transient envelope. Expired or unresolvable stored playback is dead state
// and is garbage-collected; active playback owned by another tab is never
// cleared here (owner-guarded clears live in stop()).
import { findPlaylist, playResolvedItem, startPlaylistItem } from "./playlist-flow"
import { alive, currentPartId, type PlayerContext } from "./runtime"
import {
  fromTransientPlayback,
  isPlaybackFresh,
  mutateTransientState,
  withPlayback,
} from "./transient-session"
import { readPlayerUrlParams } from "./url-params"

/** URL dopPlaylistId/dopIndex start path (content.js:386-400). */
export async function startFromPlaylistParams(
  ctx: PlayerContext,
  playlistId: string,
  index: number,
): Promise<boolean> {
  const generation = ctx.generation
  const playlist = await findPlaylist(ctx, playlistId)
  if (!alive(ctx, generation)) return false
  if (playlist === undefined || index >= playlist.items.length) return false
  const item = playlist.items[index]
  if (item === undefined) return false
  const transient = await ctx.deps.storage.readTransient()
  if (!alive(ctx, generation)) return false
  const stored = transient.playback
  const hasOrder =
    stored !== undefined &&
    stored.playlistId === playlistId &&
    stored.shuffledIndices !== undefined &&
    stored.shuffledIndices.length > 0
  const order = hasOrder
    ? (stored.shuffledIndices ?? [])
        .map((position) => playlist.items[position]?.id)
        .filter((id): id is string => id !== undefined)
    : playlist.items.map((entry) => entry.id)
  await startPlaylistItem(ctx, playlist, item, {
    sameEpisode: false,
    order,
    mode: hasOrder ? "shuffle" : "ordered",
  })
  return true
}

async function clearStalePlayback(ctx: PlayerContext): Promise<void> {
  await mutateTransientState(
    () => ctx.deps.storage.readTransient(),
    (state) => ctx.deps.storage.writeTransient(state),
    (current) => withPlayback(current, undefined),
  )
}

/** resumePlaybackIfAny (content.js:1406-1436) with owner-token guards. */
export async function resumePlaybackIfAny(ctx: PlayerContext): Promise<void> {
  if (ctx.state.mode !== "idle") return
  const params = readPlayerUrlParams(ctx.deps.currentUrl())
  if (params.rangeIndex !== null || params.playlistId !== null) return
  const generation = ctx.generation
  const transient = await ctx.deps.storage.readTransient()
  if (!alive(ctx, generation)) return
  const stored = transient.playback
  if (stored === undefined) return
  if (!isPlaybackFresh(stored, ctx.deps.now())) {
    await clearStalePlayback(ctx)
    return
  }
  const playlist = await findPlaylist(ctx, stored.playlistId)
  if (!alive(ctx, generation)) return
  if (playlist === undefined) {
    await clearStalePlayback(ctx)
    return
  }
  const restored = fromTransientPlayback(stored, playlist)
  if (restored === null) {
    await clearStalePlayback(ctx)
    return
  }
  const item = playlist.items.find((candidate) => candidate.id === restored.currentItemId)
  if (item === undefined) {
    await clearStalePlayback(ctx)
    return
  }
  if (item.partId !== currentPartId(ctx)) {
    await playResolvedItem(
      ctx,
      playlist,
      {
        playlistId: playlist.id,
        order: restored.order,
        currentItemId: item.id,
        item,
        mode: restored.mode,
        endMenuShown: false,
      },
      item,
    )
    return
  }
  await startPlaylistItem(ctx, playlist, item, {
    sameEpisode: false,
    order: restored.order,
    mode: restored.mode,
  })
}
