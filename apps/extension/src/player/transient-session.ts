// Transient playback/window session mapping — bridges the domain item-ID
// navigation space (src/domain/navigation.ts) to the index-space
// TransientPlayback envelope (packages/shared/src/local-model.ts) that replaces
// legacy dop_playback / dop_oped_mode / dop_player_window.
// Ownership is explicit: playback carries ownerToken + ownerGeneration so a
// tab only ever clears state it owns (fixes legacy defect #3 — an unset
// currentSessionId let any tab clear another tab's playback, content.js:150-155).
import type {
  LocalItem,
  LocalPlaylist,
  TransientPlayback,
  TransientState,
} from "../../../../packages/shared/src/local-model"
import { OPED_MODE_MAX_AGE_MS, RESUME_MAX_AGE_MS } from "./constants"

export type PlaybackOwner = {
  readonly token: string
  readonly generation: number
}

/** What the orchestrator tracks while a playlist item is playing. */
export type ActivePlayback = {
  readonly playlistId: string
  /** Item ids in play order (domain space). */
  readonly order: readonly string[]
  readonly currentItemId: string
  /** Resolved current item; range may be null (full-episode play). */
  readonly item: LocalItem
  readonly mode: "ordered" | "shuffle"
  /** Legacy `_endPopupShown`: end menu already offered for this position. */
  endMenuShown: boolean
}

export type TransientPlaybackWrite =
  | { readonly kind: "ok"; readonly playback: TransientPlayback }
  | { readonly kind: "unresolved-order" }

/**
 * Project item-ID playback onto the legacy index space. `index` is the position
 * inside `order`; `shuffledIndices` (position -> real playlist index) is only
 * written for shuffle mode, matching legacy dopSetPlayback (common.js:290-303).
 */
export function toTransientPlayback(
  playback: ActivePlayback,
  playlist: LocalPlaylist,
  owner: PlaybackOwner,
  now: number,
): TransientPlaybackWrite {
  const index = playback.order.indexOf(playback.currentItemId)
  if (index < 0) return { kind: "unresolved-order" }
  const base = {
    playlistId: playback.playlistId,
    index,
    updatedAt: now,
    ownerToken: owner.token,
    ownerGeneration: owner.generation,
  }
  if (playback.mode === "ordered") return { kind: "ok", playback: base }
  const shuffledIndices: number[] = []
  for (const itemId of playback.order) {
    const realIndex = playlist.items.findIndex((item) => item.id === itemId)
    if (realIndex < 0) return { kind: "unresolved-order" }
    shuffledIndices.push(realIndex)
  }
  return { kind: "ok", playback: { ...base, shuffledIndices } }
}

export type RestoredPlayback = {
  readonly playlistId: string
  readonly currentItemId: string
  readonly order: readonly string[]
  readonly mode: "ordered" | "shuffle"
}

/**
 * Restore a transient playback into item-ID space. `index` resolves through
 * `shuffledIndices` exactly like legacy dopResolvePlaybackIndex
 * (common.js:502-508): empty/absent shuffle means the index is a real index.
 * Stale orders are kept as-is; reconcileShuffleOrder cleans them on use.
 */
export function fromTransientPlayback(
  stored: TransientPlayback,
  playlist: LocalPlaylist,
): RestoredPlayback | null {
  const shuffled = stored.shuffledIndices
  const hasShuffle = shuffled !== undefined && shuffled.length > 0
  const realIndex = hasShuffle ? shuffled[stored.index] : stored.index
  if (realIndex === undefined || realIndex < 0 || realIndex >= playlist.items.length) return null
  const item = playlist.items[realIndex]
  if (item === undefined) return null
  const order = hasShuffle
    ? shuffled
        .map((position) => playlist.items[position]?.id)
        .filter((id): id is string => id !== undefined)
    : playlist.items.map((entry) => entry.id)
  if (!order.includes(item.id)) return null
  return {
    playlistId: stored.playlistId,
    currentItemId: item.id,
    order,
    mode: hasShuffle ? "shuffle" : "ordered",
  }
}

/** Legacy resume freshness: `Date.now() - updatedAt > 5min` expired (content.js:1413). */
export function isPlaybackFresh(stored: TransientPlayback, now: number): boolean {
  return now - stored.updatedAt <= RESUME_MAX_AGE_MS
}

/** Fresh op-ed intent — legacy `Date.now() - updatedAt < 5min` (content.js:1498). */
export function isOpEdModeFresh(state: TransientState, now: number): boolean {
  const mode = state.opedMode
  if (mode?.active !== true) return false
  return now - mode.updatedAt < OPED_MODE_MAX_AGE_MS
}

/** True when this transient playback belongs to the given owner token. */
export function playbackOwnedBy(state: TransientState, ownerToken: string): boolean {
  return state.playback?.ownerToken === ownerToken
}

/**
 * Read-modify-write helper shared by the background window manager (direct
 * driver) and content scripts (DOP_STORAGE_READ/WRITE_TRANSIENT round trip).
 * Every write preserves fields it does not own and bumps `generation`.
 */
export async function mutateTransientState(
  read: () => Promise<TransientState>,
  write: (state: TransientState) => Promise<unknown>,
  mutate: (current: TransientState) => TransientState,
): Promise<TransientState> {
  const current = await read()
  const next = mutate(current)
  const stamped: TransientState = {
    ...next,
    schemaVersion: 1,
    generation: current.generation + 1,
  }
  await write(stamped)
  return stamped
}

export function withPlayback(
  state: TransientState,
  playback: TransientPlayback | undefined,
): TransientState {
  const next = { ...state }
  if (playback === undefined) delete next.playback
  else next.playback = playback
  return next
}

export function withOpEdMode(state: TransientState, active: boolean, now: number): TransientState {
  const next = { ...state }
  if (active) next.opedMode = { active: true, updatedAt: now }
  else delete next.opedMode
  return next
}

/** Clear playback only when the caller owns it — never another tab's state. */
export function withOwnedPlaybackCleared(
  state: TransientState,
  ownerToken: string,
): TransientState {
  if (!playbackOwnedBy(state, ownerToken)) return state
  return withPlayback(state, undefined)
}
