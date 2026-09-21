// Popup playlist picker — ports popup.js list view: expandable cards with
// play/shuffle buttons and per-item rows that start playback. The expanded
// card id is module state inside the picker factory; header clicks re-render
// the list synchronously without a storage round-trip.

import type { LocalPlaylist } from "../../../../packages/shared/src/local-model"
import type { PopupDeps } from "./popup"
import type { PopupActions } from "./popup-actions"
import { itemRowTexts, shuffleIcon } from "./popup-rows"

export type PickerContext = {
  readonly doc: Document
  readonly deps: Pick<PopupDeps, "openOptionsPage">
  readonly actions: PopupActions
  readonly render: () => void
}

export type PlaylistPicker = {
  readonly renderPlaylistList: (playlists: readonly LocalPlaylist[]) => void
}

export function createPlaylistPicker(ctx: PickerContext): PlaylistPicker {
  const { doc, deps, actions, render } = ctx
  let expandedPlaylistId: string | null = null

  const el = <T extends HTMLElement>(id: string): T | null => doc.getElementById(id) as T | null

  function renderPlaylistList(playlists: readonly LocalPlaylist[]): void {
    const list = el("playlistList")
    if (list === null) return
    list.replaceChildren()
    if (playlists.length === 0) {
      const empty = doc.createElement("div")
      empty.className = "empty-state"
      const icon = doc.createElement("div")
      icon.className = "empty-state-icon"
      icon.textContent = "♪"
      const text = doc.createElement("div")
      text.textContent = "プレイリストがありません。"
      const create = doc.createElement("button")
      create.id = "emptyCreateBtn"
      create.type = "button"
      create.textContent = "管理画面で作成"
      create.addEventListener("click", () => deps.openOptionsPage())
      empty.append(icon, text, create)
      list.appendChild(empty)
      return
    }

    for (const playlist of playlists) {
      const card = doc.createElement("div")
      card.className = `playlist-card${expandedPlaylistId === playlist.id ? " expanded" : ""}`
      card.dataset["playlistId"] = playlist.id

      const header = doc.createElement("div")
      header.className = "playlist-card-header"
      header.addEventListener("click", () => {
        expandedPlaylistId = expandedPlaylistId === playlist.id ? null : playlist.id
        renderPlaylistList(playlists)
        // The re-render replaces every node — put focus back on the card's
        // toggle so keyboard users do not drop to <body> (task 24).
        list
          .querySelector<HTMLElement>(
            `.playlist-card[data-playlist-id="${playlist.id}"] .playlist-card-toggle`,
          )
          ?.focus()
      })
      // The title/count area is a real button (task 24) so keyboard users can
      // expand a card without relying on a clickable div; its click bubbles
      // up to the header handler, keeping one toggle path for mouse + keys.
      const toggle = doc.createElement("button")
      toggle.type = "button"
      toggle.className = "playlist-card-toggle"
      toggle.setAttribute("aria-expanded", String(expandedPlaylistId === playlist.id))
      toggle.setAttribute("aria-label", `${playlist.name}のクリップ一覧`)
      const title = doc.createElement("span")
      title.textContent = playlist.name
      title.className = "playlist-card-title"
      const count = doc.createElement("span")
      count.className = "count"
      count.textContent = `${playlist.items.length}曲`
      toggle.append(title, count)
      const isEmpty = playlist.items.length === 0

      const playBtn = doc.createElement("button")
      playBtn.type = "button"
      playBtn.className = "playlist-card-play"
      playBtn.textContent = "▶"
      playBtn.title = isEmpty ? "プレイリストが空です" : "先頭から再生"
      playBtn.disabled = isEmpty
      playBtn.addEventListener("click", (event) => {
        event.stopPropagation()
        if (isEmpty) return
        void actions.startItem(playlist, 0).then(render)
      })
      const shuffleBtn = doc.createElement("button")
      shuffleBtn.type = "button"
      shuffleBtn.className = "playlist-card-shuffle"
      shuffleBtn.replaceChildren(shuffleIcon(doc))
      shuffleBtn.title = isEmpty ? "プレイリストが空です" : "シャッフル再生"
      shuffleBtn.disabled = isEmpty
      shuffleBtn.addEventListener("click", (event) => {
        event.stopPropagation()
        if (isEmpty) return
        void actions.startShuffle(playlist).then(render)
      })
      header.append(toggle, playBtn, shuffleBtn)
      card.appendChild(header)

      if (expandedPlaylistId === playlist.id) {
        const items = doc.createElement("div")
        items.className = "playlist-card-items"
        if (playlist.items.length === 0) {
          const emptyMsg = doc.createElement("div")
          emptyMsg.className = "playlist-card-empty"
          emptyMsg.textContent = "プレイリストが空です。"
          items.appendChild(emptyMsg)
        } else {
          for (const [index, item] of playlist.items.entries()) {
            // Button rows (task 24): Tab-reachable, Enter/Space activate —
            // the div variant was mouse-only.
            const row = doc.createElement("button")
            row.type = "button"
            row.className = "playlist-card-item"
            const texts = itemRowTexts(item)
            const titleEl = doc.createElement("div")
            titleEl.className = "item-episode"
            titleEl.textContent = texts.title
            const subEl = doc.createElement("div")
            subEl.className = "item-work"
            subEl.textContent = texts.sub
            const metaEl = doc.createElement("div")
            metaEl.className = "item-meta"
            const rangeEl = doc.createElement("span")
            rangeEl.className = "item-range-name"
            rangeEl.textContent = texts.range
            metaEl.appendChild(rangeEl)
            if (texts.time !== null) {
              const timeEl = doc.createElement("span")
              timeEl.className = "item-range-time"
              timeEl.textContent = texts.time
              metaEl.appendChild(timeEl)
            }
            row.append(titleEl, subEl, metaEl)
            row.addEventListener("click", (event) => {
              event.stopPropagation()
              void actions.startItem(playlist, index).then(render)
            })
            items.appendChild(row)
          }
        }
        card.appendChild(items)
      }
      list.appendChild(card)
    }
  }

  return { renderPlaylistList }
}
