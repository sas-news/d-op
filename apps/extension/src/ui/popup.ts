// Popup controller — ports popup.js (legacy lines 1-373). Reads the transient
// playback envelope + public playlists, renders either the now-playing view
// (controls, ordered/shuffled item list, shuffle actions) or the playlist
// picker (popup-picker.ts); playback actions live in popup-actions.ts and
// shared row helpers in popup-rows.ts. All mutations go through the
// background: transient playback writes via DOP_STORAGE_WRITE_TRANSIENT
// (owner-tagged), player commands via FORWARD_TO_PLAYER, window opens via
// REQUEST_PLAYER. Storage-change events re-render through a coalescing guard
// — never two concurrent renders.
import type { LocalPlaylist } from "../../../../packages/shared/src/local-model"
import { fromTransientPlayback } from "../player/transient-session"
import { decodeHtmlEntities, isSystemPlaylist } from "./format"
import { createPopupActions } from "./popup-actions"
import { createPlaylistPicker } from "./popup-picker"
import { itemRowTexts } from "./popup-rows"
import type { PublicReply, UiStorageClient } from "./storage-client"

export type PopupDeps = {
  readonly doc: Document
  readonly storage: UiStorageClient
  readonly sendMessage: (message: unknown) => Promise<unknown>
  readonly openOptionsPage: () => void
  readonly version: string
  readonly now: () => number
  /** crypto.randomUUID — mints the ownerToken and correlation ids. */
  readonly newId: () => string
  readonly random: () => number
  readonly subscribe: (listener: () => void) => () => void
  readonly log?: (label: string, data?: unknown) => void
}

export type PopupController = {
  readonly start: () => void
  readonly dispose: () => void
}

export function createPopupController(deps: PopupDeps): PopupController {
  const doc = deps.doc
  const ownerToken = deps.newId()
  let renderQueued = false
  let renderRunning = false
  let unsubscribe: (() => void) | null = null
  let disposed = false

  const el = <T extends HTMLElement>(id: string): T | null => doc.getElementById(id) as T | null

  const actions = createPopupActions(deps, ownerToken)
  const picker = createPlaylistPicker({ doc, deps, actions, render: () => render() })

  /** renderPlaylistItems (popup.js:268-350): ordered/shuffled rows, current
   *  highlight, click = PLAYLIST_JUMP at the display position. */
  function renderNowPlayingItems(
    playlist: LocalPlaylist,
    order: readonly string[],
    position: number,
  ): void {
    const container = el("playlistItems")
    if (container === null) return
    container.replaceChildren()
    for (const [displayPos, itemId] of order.entries()) {
      const item = playlist.items.find((candidate) => candidate.id === itemId)
      if (item === undefined) continue
      const row = doc.createElement("div")
      row.className = `playlist-item${displayPos === position ? " current" : ""}`
      const thumb = doc.createElement("div")
      thumb.className = "item-thumb"
      thumb.textContent = String(displayPos + 1)
      const info = doc.createElement("div")
      info.className = "item-info"
      const texts = itemRowTexts(item)
      const title = doc.createElement("div")
      title.className = "item-title"
      title.textContent = texts.title
      const sub = doc.createElement("div")
      sub.className = "item-episode"
      sub.textContent = texts.sub
      const meta = doc.createElement("div")
      meta.className = "item-meta"
      const rangeEl = doc.createElement("span")
      rangeEl.className = "item-range-name"
      rangeEl.textContent = texts.range
      meta.appendChild(rangeEl)
      if (texts.time !== null) {
        const timeEl = doc.createElement("span")
        timeEl.className = "item-range-time"
        timeEl.textContent = texts.time
        meta.appendChild(timeEl)
      }
      info.append(title, sub, meta)
      row.append(thumb, info)
      row.addEventListener("click", () => {
        actions.forward({ type: "PLAYLIST_JUMP", index: displayPos })
        render()
      })
      container.appendChild(row)
    }

    const shuffleActions = el("shuffleActions")
    shuffleActions?.classList.remove("hidden")
    const fullBtn = el<HTMLButtonElement>("shuffleFullBtn")
    if (fullBtn !== null) fullBtn.onclick = () => void actions.startShuffle(playlist).then(render)
    const hereBtn = el<HTMLButtonElement>("shuffleHereBtn")
    if (hereBtn !== null)
      hereBtn.onclick = () =>
        void actions.shuffleFromHere(playlist, order, order[position] ?? "", position).then(render)
  }

  async function doRender(): Promise<void> {
    const [transient, pub] = await Promise.all([
      deps.storage.readTransient(),
      deps.storage.readPublic(),
    ])
    if (disposed) return
    const playlists = pub.playlists.filter((playlist) => !isSystemPlaylist(playlist))
    const playbackSection = el("playback")
    const listSection = el("playlistListSection")
    const stored = transient.playback
    const playlist =
      stored !== undefined
        ? playlists.find((candidate) => candidate.id === stored.playlistId)
        : undefined
    const restored =
      stored !== undefined && playlist !== undefined
        ? fromTransientPlayback(stored, playlist)
        : null

    if (stored === undefined || playlist === undefined || restored === null) {
      playbackSection?.classList.add("hidden")
      listSection?.classList.remove("hidden")
      picker.renderPlaylistList(playlists)
      return
    }

    const position = restored.order.indexOf(restored.currentItemId)
    const currentItem = playlist.items.find((item) => item.id === restored.currentItemId)
    if (position < 0 || currentItem === undefined) {
      playbackSection?.classList.add("hidden")
      listSection?.classList.remove("hidden")
      picker.renderPlaylistList(playlists)
      return
    }

    playbackSection?.classList.remove("hidden")
    listSection?.classList.add("hidden")

    const nameEl = el("playlistName")
    if (nameEl !== null) nameEl.textContent = playlist.name
    el("shuffleBadge")?.classList.toggle("hidden", restored.mode !== "shuffle")
    const infoEl = el("trackInfo")
    if (infoEl !== null)
      infoEl.textContent =
        decodeHtmlEntities(currentItem.title || currentItem.episodeTitle) || "(タイトル不明)"
    const detailEl = el("trackDetail")
    if (detailEl !== null) detailEl.textContent = decodeHtmlEntities(currentItem.episodeTitle)
    const progressEl = el("trackProgress")
    if (progressEl !== null) progressEl.textContent = `${position + 1} / ${restored.order.length}`

    const prevBtn = el<HTMLButtonElement>("prevBtn")
    if (prevBtn !== null) prevBtn.disabled = position <= 0
    const nextBtn = el<HTMLButtonElement>("nextBtn")
    if (nextBtn !== null) nextBtn.disabled = position >= restored.order.length - 1

    renderNowPlayingItems(playlist, restored.order, position)
  }

  /** Legacy render() guard (popup.js:76-81): coalesce, never overlap. */
  function render(): void {
    if (disposed) return
    if (renderRunning) {
      renderQueued = true
      return
    }
    renderRunning = true
    void (async () => {
      try {
        do {
          renderQueued = false
          await doRender()
        } while (renderQueued && !disposed)
      } catch (error) {
        deps.log?.("popup-render-failed", error)
      } finally {
        renderRunning = false
      }
    })()
  }

  return {
    start: () => {
      const versionEl = el("popupVersion")
      if (versionEl !== null) versionEl.textContent = `d-OP v${deps.version}`
      el<HTMLButtonElement>("prevBtn")?.addEventListener("click", () =>
        actions.forward({ type: "PLAYLIST_PREV" }),
      )
      el<HTMLButtonElement>("nextBtn")?.addEventListener("click", () =>
        actions.forward({ type: "PLAYLIST_NEXT" }),
      )
      el<HTMLButtonElement>("stopBtn")?.addEventListener("click", () => {
        void deps
          .sendMessage({ kind: "RELEASE_PLAYER" })
          .catch((error: unknown) => deps.log?.("release-failed", error))
          .then(() => render())
      })
      el<HTMLButtonElement>("openOptions")?.addEventListener("click", () => deps.openOptionsPage())
      unsubscribe = deps.subscribe(() => render())
      render()
    },
    dispose: () => {
      disposed = true
      unsubscribe?.()
      unsubscribe = null
    },
  }
}

/** Kept exported for tests: the restored playback shape used by the popup. */
export type { PublicReply }
