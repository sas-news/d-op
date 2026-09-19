import type { LocalItem, LocalPlaylist } from "../../../../packages/shared/src/local-model"
import { type DuplicateIdentity, findDuplicateIdentity } from "./identity"

type MutationError =
  | DuplicateIdentity
  | { readonly kind: "playlist-not-found"; readonly playlistId: string }
  | { readonly kind: "item-not-found"; readonly itemId: string }
  | { readonly kind: "invalid-position"; readonly position: number }

export type PlaylistMutationResult =
  | { readonly kind: "updated"; readonly playlists: readonly LocalPlaylist[] }
  | MutationError

type ItemDraft = Omit<LocalItem, "id">
type AddItemRequest = {
  readonly playlistId: string
  readonly item: ItemDraft
  readonly nextId: () => string
}
type CopyItemRequest = {
  readonly sourcePlaylistId: string
  readonly itemId: string
  readonly targetPlaylistId: string
  readonly nextId: () => string
}
type ReplaceItemRequest = {
  readonly playlistId: string
  readonly itemId: string
  readonly item: ItemDraft
}
type ReorderItemRequest = {
  readonly playlistId: string
  readonly itemId: string
  readonly position: number
}

function checked(playlists: readonly LocalPlaylist[]): DuplicateIdentity | null {
  return findDuplicateIdentity(playlists)
}

function updatePlaylist(
  playlists: readonly LocalPlaylist[],
  playlistId: string,
  update: (playlist: LocalPlaylist) => LocalPlaylist,
): readonly LocalPlaylist[] {
  return playlists.map((playlist) => (playlist.id === playlistId ? update(playlist) : playlist))
}

function hasItemId(playlists: readonly LocalPlaylist[], itemId: string): boolean {
  return playlists.some((playlist) => playlist.items.some((item) => item.id === itemId))
}

export function createPlaylist(
  playlists: readonly LocalPlaylist[],
  name: string,
  nextId: () => string,
): PlaylistMutationResult {
  const duplicate = checked(playlists)
  if (duplicate !== null) return duplicate
  const id = nextId()
  if (playlists.some((playlist) => playlist.id === id)) {
    return { kind: "duplicate-id", entity: "playlist", id }
  }
  return { kind: "updated", playlists: [...playlists, { id, name, items: [] }] }
}

export function renamePlaylist(
  playlists: readonly LocalPlaylist[],
  playlistId: string,
  name: string,
): PlaylistMutationResult {
  const duplicate = checked(playlists)
  if (duplicate !== null) return duplicate
  if (!playlists.some((playlist) => playlist.id === playlistId)) {
    return { kind: "playlist-not-found", playlistId }
  }
  return {
    kind: "updated",
    playlists: updatePlaylist(playlists, playlistId, (playlist) => ({ ...playlist, name })),
  }
}

export function deletePlaylist(
  playlists: readonly LocalPlaylist[],
  playlistId: string,
): PlaylistMutationResult {
  const duplicate = checked(playlists)
  if (duplicate !== null) return duplicate
  if (!playlists.some((playlist) => playlist.id === playlistId)) {
    return { kind: "playlist-not-found", playlistId }
  }
  return { kind: "updated", playlists: playlists.filter((playlist) => playlist.id !== playlistId) }
}

export function clearPlaylistItems(
  playlists: readonly LocalPlaylist[],
  playlistId: string,
): PlaylistMutationResult {
  const duplicate = checked(playlists)
  if (duplicate !== null) return duplicate
  const playlist = playlists.find((candidate) => candidate.id === playlistId)
  if (playlist === undefined) return { kind: "playlist-not-found", playlistId }
  if (playlist.items.length === 0) return { kind: "updated", playlists }
  return {
    kind: "updated",
    playlists: updatePlaylist(playlists, playlistId, (current) => ({ ...current, items: [] })),
  }
}

export function addItem(
  playlists: readonly LocalPlaylist[],
  request: AddItemRequest,
): PlaylistMutationResult {
  const duplicate = checked(playlists)
  if (duplicate !== null) return duplicate
  if (!playlists.some((playlist) => playlist.id === request.playlistId)) {
    return { kind: "playlist-not-found", playlistId: request.playlistId }
  }
  const id = request.nextId()
  if (hasItemId(playlists, id)) return { kind: "duplicate-id", entity: "item", id }
  return {
    kind: "updated",
    playlists: updatePlaylist(playlists, request.playlistId, (playlist) => ({
      ...playlist,
      items: [...playlist.items, { ...request.item, id }],
    })),
  }
}

export function copyItem(
  playlists: readonly LocalPlaylist[],
  request: CopyItemRequest,
): PlaylistMutationResult {
  const duplicate = checked(playlists)
  if (duplicate !== null) return duplicate
  const source = playlists.find((playlist) => playlist.id === request.sourcePlaylistId)
  const target = playlists.find((playlist) => playlist.id === request.targetPlaylistId)
  if (source === undefined) {
    return { kind: "playlist-not-found", playlistId: request.sourcePlaylistId }
  }
  if (target === undefined) {
    return { kind: "playlist-not-found", playlistId: request.targetPlaylistId }
  }
  const item = source.items.find((candidate) => candidate.id === request.itemId)
  if (item === undefined) return { kind: "item-not-found", itemId: request.itemId }
  const id = request.nextId()
  if (hasItemId(playlists, id)) return { kind: "duplicate-id", entity: "item", id }
  return {
    kind: "updated",
    playlists: updatePlaylist(playlists, target.id, (playlist) => ({
      ...playlist,
      items: [...playlist.items, { ...item, id }],
    })),
  }
}

export function replaceItem(
  playlists: readonly LocalPlaylist[],
  request: ReplaceItemRequest,
): PlaylistMutationResult {
  const duplicate = checked(playlists)
  if (duplicate !== null) return duplicate
  const playlist = playlists.find((candidate) => candidate.id === request.playlistId)
  if (playlist === undefined) return { kind: "playlist-not-found", playlistId: request.playlistId }
  if (!playlist.items.some((item) => item.id === request.itemId)) {
    return { kind: "item-not-found", itemId: request.itemId }
  }
  return {
    kind: "updated",
    playlists: updatePlaylist(playlists, request.playlistId, (current) => ({
      ...current,
      items: current.items.map((item) =>
        item.id === request.itemId ? { ...request.item, id: item.id } : item,
      ),
    })),
  }
}

export function removeItem(
  playlists: readonly LocalPlaylist[],
  playlistId: string,
  itemId: string,
): PlaylistMutationResult {
  const duplicate = checked(playlists)
  if (duplicate !== null) return duplicate
  const playlist = playlists.find((candidate) => candidate.id === playlistId)
  if (playlist === undefined) return { kind: "playlist-not-found", playlistId }
  if (!playlist.items.some((item) => item.id === itemId)) return { kind: "item-not-found", itemId }
  return {
    kind: "updated",
    playlists: updatePlaylist(playlists, playlistId, (current) => ({
      ...current,
      items: current.items.filter((item) => item.id !== itemId),
    })),
  }
}

export function reorderItem(
  playlists: readonly LocalPlaylist[],
  request: ReorderItemRequest,
): PlaylistMutationResult {
  const duplicate = checked(playlists)
  if (duplicate !== null) return duplicate
  const playlist = playlists.find((candidate) => candidate.id === request.playlistId)
  if (playlist === undefined) return { kind: "playlist-not-found", playlistId: request.playlistId }
  const item = playlist.items.find((candidate) => candidate.id === request.itemId)
  if (item === undefined) return { kind: "item-not-found", itemId: request.itemId }
  if (request.position < 0 || request.position >= playlist.items.length) {
    return { kind: "invalid-position", position: request.position }
  }
  const remaining = playlist.items.filter((candidate) => candidate.id !== request.itemId)
  const items = [
    ...remaining.slice(0, request.position),
    item,
    ...remaining.slice(request.position),
  ]
  return {
    kind: "updated",
    playlists: updatePlaylist(playlists, request.playlistId, (current) => ({ ...current, items })),
  }
}
