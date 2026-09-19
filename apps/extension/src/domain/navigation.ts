import { assertNever } from "../../../../packages/shared/src/limits"
import type { LocalItem, LocalPlaylist } from "../../../../packages/shared/src/local-model"
import { reconcileShuffleOrder } from "./shuffle"

export type Playback = {
  readonly playlistId: string
  readonly currentItemId: string
  readonly order: readonly string[]
  readonly mode: "ordered" | "shuffle"
  readonly updatedAt: number
}

export type NavigationResult =
  | { readonly kind: "target"; readonly playback: Playback; readonly item: LocalItem }
  | { readonly kind: "boundary"; readonly edge: "start" | "end" }
  | {
      readonly kind: "stop"
      readonly reason:
        | "playlist-deleted"
        | "empty-playlist"
        | "current-item-removed"
        | "duplicate-item-id"
    }

type StartNavigationRequest = {
  readonly playlist: LocalPlaylist | null
  readonly currentItemId: string
  readonly order: readonly string[]
  readonly mode: Playback["mode"]
  readonly clock: () => number
}

type NavigateRequest = {
  readonly playlist: LocalPlaylist | null
  readonly playback: Playback
  readonly direction: "previous" | "next"
  readonly clock: () => number
}

type TargetRequest = {
  readonly playlist: LocalPlaylist
  readonly playback: Playback
  readonly itemId: string
  readonly updatedAt: number
}

function target(request: TargetRequest): NavigationResult {
  const item = request.playlist.items.find((candidate) => candidate.id === request.itemId)
  if (item === undefined) return { kind: "stop", reason: "current-item-removed" }
  return {
    kind: "target",
    item,
    playback: {
      ...request.playback,
      currentItemId: request.itemId,
      updatedAt: request.updatedAt,
    },
  }
}

function reconcile(
  playlist: LocalPlaylist | null,
  playback: Playback,
):
  | { readonly kind: "ready"; readonly playlist: LocalPlaylist; readonly order: readonly string[] }
  | Extract<NavigationResult, { readonly kind: "stop" }> {
  if (playlist === null || playlist.id !== playback.playlistId) {
    return { kind: "stop", reason: "playlist-deleted" }
  }
  const result = reconcileShuffleOrder(
    playlist.items.map((item) => item.id),
    playback.order,
    playback.currentItemId,
  )
  switch (result.kind) {
    case "duplicate-id":
      return { kind: "stop", reason: "duplicate-item-id" }
    case "stop":
      return result.reason === "empty-playlist"
        ? { kind: "stop", reason: "empty-playlist" }
        : { kind: "stop", reason: "current-item-removed" }
    case "ready":
      return { kind: "ready", playlist, order: result.order }
    default:
      return assertNever(result)
  }
}

export function startNavigation(request: StartNavigationRequest): NavigationResult {
  if (request.playlist === null) return { kind: "stop", reason: "playlist-deleted" }
  const updatedAt = request.clock()
  const playback: Playback = {
    playlistId: request.playlist.id,
    currentItemId: request.currentItemId,
    order: request.order,
    mode: request.mode,
    updatedAt,
  }
  const reconciled = reconcile(request.playlist, playback)
  if (reconciled.kind === "stop") return reconciled
  return target({
    playlist: reconciled.playlist,
    playback: { ...playback, order: reconciled.order },
    itemId: request.currentItemId,
    updatedAt,
  })
}

export function navigate(request: NavigateRequest): NavigationResult {
  const reconciled = reconcile(request.playlist, request.playback)
  if (reconciled.kind === "stop") return reconciled
  const currentPosition = reconciled.order.indexOf(request.playback.currentItemId)
  const offset = request.direction === "next" ? 1 : -1
  const nextItemId = reconciled.order[currentPosition + offset]
  if (nextItemId === undefined) {
    return { kind: "boundary", edge: request.direction === "next" ? "end" : "start" }
  }
  return target({
    playlist: reconciled.playlist,
    playback: { ...request.playback, order: reconciled.order },
    itemId: nextItemId,
    updatedAt: request.clock(),
  })
}

export function restartNavigation(
  playlist: LocalPlaylist | null,
  playback: Playback,
  clock: () => number,
): NavigationResult {
  const reconciled = reconcile(playlist, playback)
  if (reconciled.kind === "stop") return reconciled
  const firstItemId = reconciled.order[0]
  if (firstItemId === undefined) return { kind: "stop", reason: "empty-playlist" }
  return target({
    playlist: reconciled.playlist,
    playback: { ...playback, order: reconciled.order },
    itemId: firstItemId,
    updatedAt: clock(),
  })
}
