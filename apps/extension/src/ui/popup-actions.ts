// Popup playback actions — ports popup.js:42-141. Each action writes the
// owner-tagged transient playback envelope via DOP_STORAGE_WRITE_TRANSIENT,
// then REQUEST_PLAYER / FORWARD_TO_PLAYER goes through the background
// message bus. No direct chrome.storage access here.

import type { LocalPlaylist, TransientPlayback } from "../../../../packages/shared/src/local-model"
import { reshuffleAfterCurrent, shuffleAll } from "../domain/shuffle"
import { mutateTransientState, withPlayback } from "../player/transient-session"
import { buildPlaylistItemUrl } from "../player/url-params"
import { itemPlaybackUrl } from "./format"
import type { PopupDeps } from "./popup"

export type PopupActionDeps = Pick<
  PopupDeps,
  "storage" | "sendMessage" | "now" | "newId" | "random" | "log"
>

export type PopupActions = {
  readonly forward: (command: { readonly type: string; readonly index?: number }) => void
  readonly startItem: (playlist: LocalPlaylist, index: number) => Promise<void>
  readonly startShuffle: (playlist: LocalPlaylist) => Promise<void>
  readonly shuffleFromHere: (
    playlist: LocalPlaylist,
    order: readonly string[],
    currentItemId: string,
    position: number,
  ) => Promise<void>
}

export function createPopupActions(deps: PopupActionDeps, ownerToken: string): PopupActions {
  async function writePlayback(playback: TransientPlayback): Promise<void> {
    await mutateTransientState(
      () => deps.storage.readTransient(),
      (state) => deps.storage.writeTransient(state),
      (current) => withPlayback(current, playback),
    )
  }

  function forward(command: { readonly type: string; readonly index?: number }): void {
    void deps
      .sendMessage({
        kind: "FORWARD_TO_PLAYER",
        command,
        correlationId: deps.newId(),
      })
      .catch((error: unknown) => deps.log?.("forward-failed", error))
  }

  /** startPlaylistItem (popup.js:132-141): transient index + REQUEST_PLAYER
   *  with dopPlaylistId/dopIndex on the item url. */
  async function startItem(playlist: LocalPlaylist, index: number): Promise<void> {
    const item = playlist.items[index]
    if (item === undefined) return
    const itemUrl = itemPlaybackUrl(item)
    if (itemUrl === null) return
    await writePlayback({
      playlistId: playlist.id,
      index,
      updatedAt: deps.now(),
      ownerToken,
      ownerGeneration: 1,
    })
    await deps.sendMessage({
      kind: "REQUEST_PLAYER",
      url: buildPlaylistItemUrl(itemUrl, playlist.id, index),
    })
  }

  /** startShufflePlayback (popup.js:42-54): full shuffle, index 0. */
  async function startShuffle(playlist: LocalPlaylist): Promise<void> {
    const result = shuffleAll(
      playlist.items.map((item) => item.id),
      deps.random,
    )
    if (result.kind !== "ready") return
    const shuffledIndices: number[] = []
    for (const itemId of result.order) {
      const realIndex = playlist.items.findIndex((item) => item.id === itemId)
      if (realIndex < 0) return
      shuffledIndices.push(realIndex)
    }
    const first = playlist.items[shuffledIndices[0] ?? -1]
    if (first === undefined) return
    const itemUrl = itemPlaybackUrl(first)
    if (itemUrl === null) return
    await writePlayback({
      playlistId: playlist.id,
      index: 0,
      shuffledIndices,
      updatedAt: deps.now(),
      ownerToken,
      ownerGeneration: 1,
    })
    await deps.sendMessage({
      kind: "REQUEST_PLAYER",
      url: buildPlaylistItemUrl(itemUrl, playlist.id, shuffledIndices[0] ?? 0),
    })
  }

  /** startShuffleFromHere (popup.js:56-71): keep the prefix through the
   *  current position, reshuffle the tail. */
  async function shuffleFromHere(
    playlist: LocalPlaylist,
    order: readonly string[],
    currentItemId: string,
    position: number,
  ): Promise<void> {
    const result = reshuffleAfterCurrent({
      itemIds: playlist.items.map((item) => item.id),
      order,
      currentItemId,
      random: deps.random,
    })
    if (result.kind !== "ready") return
    const shuffledIndices: number[] = []
    for (const itemId of result.order) {
      const realIndex = playlist.items.findIndex((item) => item.id === itemId)
      if (realIndex < 0) return
      shuffledIndices.push(realIndex)
    }
    const currentReal = playlist.items.findIndex((item) => item.id === currentItemId)
    const current = playlist.items[currentReal]
    if (current === undefined) return
    const itemUrl = itemPlaybackUrl(current)
    if (itemUrl === null) return
    await writePlayback({
      playlistId: playlist.id,
      index: position,
      shuffledIndices,
      updatedAt: deps.now(),
      ownerToken,
      ownerGeneration: 1,
    })
    await deps.sendMessage({
      kind: "REQUEST_PLAYER",
      url: buildPlaylistItemUrl(itemUrl, playlist.id, currentReal),
    })
  }

  return { forward, startItem, startShuffle, shuffleFromHere }
}
