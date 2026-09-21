import { assertNever } from "../../../../packages/shared/src/limits"
import type { LocalCommand, LocalV2State } from "../../../../packages/shared/src/local-model"
import { findDuplicateIdentity } from "../domain/identity"
import {
  addItem,
  createPlaylist,
  deletePlaylist,
  type PlaylistMutationResult,
  removeItem,
  renamePlaylist,
} from "../domain/playlist"

type StoredCollections = Pick<
  LocalV2State,
  "playlists" | "publications" | "pendingCreates" | "preferences"
>
export type StorageMutationResult =
  | { readonly kind: "updated"; readonly collections: StoredCollections }
  | { readonly kind: "rejected"; readonly reason: string }

function rejected(
  result: Exclude<PlaylistMutationResult, { readonly kind: "updated" }>,
): StorageMutationResult {
  switch (result.kind) {
    case "duplicate-id":
      return { kind: "rejected", reason: `duplicate-${result.entity}-id` }
    case "playlist-not-found":
      return { kind: "rejected", reason: "playlist-not-found" }
    case "item-not-found":
      return { kind: "rejected", reason: "item-not-found" }
    case "invalid-position":
      return { kind: "rejected", reason: "invalid-position" }
    default:
      return assertNever(result)
  }
}

function playlistMutation(
  state: LocalV2State,
  command: LocalCommand,
  newId: () => string,
): PlaylistMutationResult {
  switch (command.kind) {
    case "create-playlist":
      return createPlaylist(state.playlists, command.name, newId)
    case "rename-playlist":
      return renamePlaylist(state.playlists, command.playlistId, command.name)
    case "delete-playlist":
      return deletePlaylist(state.playlists, command.playlistId)
    case "add-item": {
      const { id: _id, ...item } = command.item
      return addItem(state.playlists, {
        playlistId: command.playlistId,
        item,
        nextId: () => command.item.id,
      })
    }
    case "remove-item":
      return removeItem(state.playlists, command.playlistId, command.itemId)
    case "replace-library": {
      const duplicate = findDuplicateIdentity(command.playlists)
      return duplicate ?? { kind: "updated", playlists: command.playlists }
    }
    case "set-preferences":
    case "put-publication":
    case "discard-publication-management":
    case "put-pending-create":
    case "remove-pending-create":
      return { kind: "updated", playlists: state.playlists }
    default:
      return assertNever(command)
  }
}

export function applyStorageMutation(
  state: LocalV2State,
  command: LocalCommand,
  newId: () => string,
): StorageMutationResult {
  const playlistResult = playlistMutation(state, command, newId)
  if (playlistResult.kind !== "updated") return rejected(playlistResult)

  const playlists = [...playlistResult.playlists]
  let publications = state.publications
  let pendingCreates = state.pendingCreates
  let preferences = state.preferences
  switch (command.kind) {
    case "delete-playlist":
    case "replace-library": {
      const localIds = new Set(playlists.map((playlist) => playlist.id))
      publications = publications.map((record) =>
        record.localPlaylistId !== null && !localIds.has(record.localPlaylistId)
          ? { ...record, localPlaylistId: null, state: "local-deleted" }
          : record,
      )
      break
    }
    case "set-preferences":
      preferences = command.preferences
      break
    case "put-publication":
      publications = [
        ...publications.filter((record) => record.shareId !== command.publication.shareId),
        command.publication,
      ]
      break
    case "discard-publication-management":
      publications = publications.filter((record) => record.shareId !== command.shareId)
      break
    case "put-pending-create":
      pendingCreates = [
        ...pendingCreates.filter(
          (record) => record.operationId !== command.pendingCreate.operationId,
        ),
        command.pendingCreate,
      ]
      break
    case "remove-pending-create":
      pendingCreates = pendingCreates.filter(
        (record) => record.operationId !== command.pendingOperationId,
      )
      break
    case "create-playlist":
    case "rename-playlist":
    case "add-item":
    case "remove-item":
      break
    default:
      return assertNever(command)
  }
  return { kind: "updated", collections: { playlists, publications, pendingCreates, preferences } }
}
