// Item rows for the options page — ports options.js item-row DOM: info/meta,
// inline range edit row, and the play/edit/copy/remove controls plus the
// copy-target picker modal. Mutations go through runMutation
// (replace-library built from fresh state) so retries stay correct.

import { episodeLeadLabel } from "../../../../packages/shared/src/index"
import type { LocalItem, LocalPlaylist } from "../../../../packages/shared/src/local-model"
import { copyItem, removeItem, replaceItem } from "../domain/playlist"
import type { ModalHost } from "../player/modal"
import type { ModalHandle } from "../player/runtime"
import {
  decodeHtmlEntities,
  formatRangeName,
  formatSec,
  formatSecTenths,
  isSystemPlaylist,
  parseTimeInput,
} from "./format"
import type { OptionsDeps } from "./options"
import { runMutation } from "./storage-client"
import {
  createTimeStepControl,
  createTimeStepper,
  TIME_STEP_FINE_MS,
  type TimeStepMs,
} from "./time-stepper"

export type BulkSelectionApi = {
  readonly isActive: (playlistId: string) => boolean
  readonly isSelected: (playlistId: string, itemId: string) => boolean
  readonly toggle: (playlistId: string, itemId: string, selected: boolean) => void
}

export type ItemRowContext = {
  readonly doc: Document
  /** Bulk-selection hooks — absent in tests/legacy surfaces, in which case
   *  rows render exactly as before (no checkbox). */
  readonly selection?: BulkSelectionApi
  readonly deps: OptionsDeps
  readonly modal: ModalHost
  readonly showStatus: (text: string, type?: "success" | "error") => void
  readonly showConfirm: (message: string) => Promise<boolean>
  readonly render: () => void
  readonly startPlaylistPlayback: (playlistId: string, index?: number) => Promise<void>
  /**
   * Keyboard reorder entry point (task 24) — forwards to the drag
   * controller's moveByKey so the persisted path stays identical to mouse.
   */
  readonly reorderItem: (row: HTMLElement, delta: -1 | 1) => boolean
}

/** Copy-target picker (options.js:528-594): rows resolve the modal
 *  directly via handle.close(playlistId). */
export async function showCopyDialog(
  doc: Document,
  modal: ModalHost,
  playlists: readonly LocalPlaylist[],
  currentPlaylistId: string,
): Promise<string | null> {
  const targets = playlists.filter(
    (playlist) => !isSystemPlaylist(playlist) && playlist.id !== currentPlaylistId,
  )
  const bodyNode = doc.createElement("div")
  let handle: ModalHandle | null = null
  if (targets.length === 0) {
    const empty = doc.createElement("p")
    empty.textContent = "コピー先がありません。"
    bodyNode.appendChild(empty)
  } else {
    const list = doc.createElement("div")
    list.className = "d-op-modal-playlist-list"
    for (const playlist of targets) {
      const row = doc.createElement("button")
      row.type = "button"
      row.className = "d-op-modal-playlist-item"
      row.textContent = `${playlist.name} (${playlist.items.length}曲)`
      row.addEventListener("click", () => handle?.close(playlist.id))
      list.appendChild(row)
    }
    bodyNode.appendChild(list)
  }
  const value = await modal.show({
    title: "コピー先のプレイリスト",
    body: "",
    bodyNode,
    buttons: [{ label: "キャンセル", value: "cancel" }],
    onReady: (h) => {
      handle = h
    },
  })
  return value
}

export function buildItemRow(
  ctx: ItemRowContext,
  playlist: LocalPlaylist,
  item: LocalItem,
): HTMLLIElement {
  const { doc, deps, modal, showStatus, showConfirm, render, startPlaylistPlayback } = ctx
  const li = doc.createElement("li")
  li.className = "item-row"
  li.dataset["itemId"] = item.id

  const info = doc.createElement("div")
  info.className = "item-info"

  const epNum = item.episodeNumber !== undefined ? decodeHtmlEntities(item.episodeNumber) : ""
  const epTitle = decodeHtmlEntities(item.episodeTitle)
  const workTitle = decodeHtmlEntities(item.title)

  const title = doc.createElement("div")
  title.className = "item-episode"
  title.textContent = episodeLeadLabel({
    title: workTitle,
    episodeTitle: epTitle,
    episodeNumber: epNum,
  })
  const episodeSub = doc.createElement("div")
  episodeSub.className = "item-work"
  episodeSub.textContent = workTitle

  const meta = doc.createElement("div")
  meta.className = "item-meta"
  const rangeNameEl = doc.createElement("span")
  rangeNameEl.className = "item-range-name"
  rangeNameEl.textContent = item.range !== null ? formatRangeName(item.range) : "範囲未設定"
  meta.appendChild(rangeNameEl)
  if (item.range !== null) {
    const timeEl = doc.createElement("span")
    timeEl.className = "item-range-time"
    timeEl.textContent = `${formatSec(item.range.start)}-${formatSec(item.range.end)}`
    meta.appendChild(timeEl)
  }

  const editRow = doc.createElement("div")
  editRow.className = "item-edit-row"
  const titleInput = doc.createElement("input")
  titleInput.type = "text"
  titleInput.className = "item-title-input"
  titleInput.value = item.range !== null ? (item.range.name ?? formatRangeName(item.range)) : ""
  titleInput.placeholder = "タイトル"
  titleInput.setAttribute("aria-label", "区間タイトル")
  titleInput.disabled = item.range === null
  const startInput = doc.createElement("input")
  startInput.type = "text"
  startInput.className = "item-time-input"
  startInput.value = item.range !== null ? formatSecTenths(item.range.start) : ""
  startInput.placeholder = "開始"
  startInput.setAttribute("aria-label", "開始時刻")
  startInput.disabled = item.range === null
  const endInput = doc.createElement("input")
  endInput.type = "text"
  endInput.className = "item-time-input"
  endInput.value = item.range !== null ? formatSecTenths(item.range.end) : ""
  endInput.placeholder = "終了"
  endInput.setAttribute("aria-label", "終了時刻")
  endInput.disabled = item.range === null

  let stepMs: TimeStepMs = TIME_STEP_FINE_MS
  const startStepper = createTimeStepper(doc, {
    label: "開始",
    getValue: () => parseTimeInput(startInput.value),
    getStep: () => stepMs,
    onChange: (ms) => {
      startInput.value = formatSecTenths(ms)
    },
  })
  const endStepper = createTimeStepper(doc, {
    label: "終了",
    getValue: () => parseTimeInput(endInput.value),
    getStep: () => stepMs,
    onChange: (ms) => {
      endInput.value = formatSecTenths(ms)
    },
  })
  const stepControl = createTimeStepControl(doc, {
    getStep: () => stepMs,
    onChange: (next) => {
      stepMs = next
      startStepper.sync()
      endStepper.sync()
    },
  })

  const saveBtn = doc.createElement("button")
  saveBtn.type = "button"
  saveBtn.textContent = "保存"
  saveBtn.className = "btn-primary"
  saveBtn.disabled = item.range === null
  saveBtn.addEventListener("click", () => {
    const startMs = parseTimeInput(startInput.value)
    const endMs = parseTimeInput(endInput.value)
    if (startMs === null || endMs === null || startMs >= endMs) {
      showStatus("開始・終了時間を正しく入力してください。", "error")
      return
    }
    const newName = titleInput.value.trim()
    void (async () => {
      const reply = await runMutation(
        deps.storage,
        (fresh) => {
          const current = fresh.playlists.find((p) => p.id === playlist.id)
          const target = current?.items.find((i) => i.id === item.id)
          if (current === undefined || target === undefined || target.range === null) return null
          const replaced = replaceItem(fresh.playlists, {
            playlistId: playlist.id,
            itemId: item.id,
            item: {
              ...target,
              range: {
                start: startMs,
                end: endMs,
                name: newName !== "" ? newName : undefined,
              },
            },
          })
          if (replaced.kind !== "updated") return null
          return { kind: "replace-library", playlists: [...replaced.playlists] }
        },
        deps.newId,
      )
      if (reply.kind === "committed") {
        showStatus("保存しました。")
        render()
      } else {
        showStatus("保存に失敗しました。", "error")
      }
    })()
  })
  const cancelBtn = doc.createElement("button")
  cancelBtn.type = "button"
  cancelBtn.className = "btn-text"
  cancelBtn.textContent = "キャンセル"
  cancelBtn.addEventListener("click", () => {
    editRow.classList.remove("open")
    meta.style.display = ""
  })
  const startGroup = doc.createElement("span")
  startGroup.className = "item-time-group"
  startGroup.append(startInput, startStepper.element)
  const endGroup = doc.createElement("span")
  endGroup.className = "item-time-group"
  endGroup.append(endInput, endStepper.element)
  const editActions = doc.createElement("span")
  editActions.className = "item-edit-actions"
  editActions.append(saveBtn, cancelBtn)
  editRow.append(
    titleInput,
    startGroup,
    doc.createTextNode(" - "),
    endGroup,
    stepControl.element,
    editActions,
  )
  info.append(title, episodeSub, meta, editRow)

  const controls = doc.createElement("div")
  controls.className = "item-controls"

  const playBtn = doc.createElement("button")
  playBtn.type = "button"
  playBtn.textContent = "▶"
  playBtn.title = "再生"
  playBtn.className = "btn-icon"
  playBtn.addEventListener("click", () => {
    void (async () => {
      const state = await deps.storage.readPublic()
      const current = state.playlists.find((p) => p.id === playlist.id)
      const index = current?.items.findIndex((i) => i.id === item.id) ?? -1
      if (index >= 0) await startPlaylistPlayback(playlist.id, index)
    })()
  })

  const editBtn = doc.createElement("button")
  editBtn.type = "button"
  editBtn.textContent = "編集"
  editBtn.className = "btn-text"
  editBtn.disabled = item.range === null
  editBtn.addEventListener("click", () => {
    editRow.classList.add("open")
    meta.style.display = "none"
  })

  const copyBtn = doc.createElement("button")
  copyBtn.type = "button"
  copyBtn.textContent = "コピー"
  copyBtn.className = "btn-text"
  copyBtn.addEventListener("click", () => {
    void (async () => {
      const state = await deps.storage.readPublic()
      const targetId = await showCopyDialog(doc, modal, state.playlists, playlist.id)
      if (targetId === null) return
      const reply = await runMutation(
        deps.storage,
        (fresh) => {
          const copied = copyItem(fresh.playlists, {
            sourcePlaylistId: playlist.id,
            itemId: item.id,
            targetPlaylistId: targetId,
            nextId: deps.newId,
          })
          if (copied.kind !== "updated") return null
          return { kind: "replace-library", playlists: [...copied.playlists] }
        },
        deps.newId,
      )
      if (reply.kind === "committed") {
        showStatus("コピーしました。")
        render()
      } else {
        showStatus("コピーに失敗しました。", "error")
      }
    })()
  })

  const removeBtn = doc.createElement("button")
  removeBtn.type = "button"
  removeBtn.textContent = "削除"
  removeBtn.className = "btn-danger-text"
  removeBtn.addEventListener("click", () => {
    void (async () => {
      const ok = await showConfirm("このアイテムを削除しますか？")
      if (!ok) return
      const reply = await runMutation(
        deps.storage,
        (fresh) => {
          const removed = removeItem(fresh.playlists, playlist.id, item.id)
          if (removed.kind !== "updated") return null
          return { kind: "replace-library", playlists: [...removed.playlists] }
        },
        deps.newId,
      )
      if (reply.kind !== "committed") showStatus("削除に失敗しました。", "error")
      render()
    })()
  })

  const divider = (): void => {
    const d = doc.createElement("span")
    d.className = "divider"
    controls.appendChild(d)
  }
  controls.appendChild(playBtn)
  divider()
  controls.appendChild(editBtn)
  controls.appendChild(copyBtn)
  divider()
  controls.appendChild(removeBtn)

  // The grip doubles as the keyboard-reorder affordance (task 24): a real
  // button so it is focusable, labelled for screen readers, and moves the row
  // one step on ↑/↓. Mouse drag still starts from its mousedown.
  const grip = doc.createElement("button")
  grip.type = "button"
  grip.className = "drag-grip"
  grip.setAttribute("aria-label", `${title.textContent ?? ""}を移動（↑または↓キー）`)
  grip.title = "ドラッグまたは↑↓キーで並び替え"
  grip.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    event.preventDefault()
    event.stopPropagation()
    ctx.reorderItem(li, event.key === "ArrowUp" ? -1 : 1)
  })
  for (let i = 0; i < 3; i += 1) {
    const line = doc.createElement("div")
    line.className = "drag-grip-line"
    grip.appendChild(line)
  }

  const selection = ctx.selection
  if (selection?.isActive(playlist.id) === true) {
    const checkbox = doc.createElement("input")
    checkbox.type = "checkbox"
    checkbox.className = "item-select"
    checkbox.checked = selection.isSelected(playlist.id, item.id)
    checkbox.setAttribute("aria-label", `${title.textContent ?? ""}を選択`)
    checkbox.addEventListener("change", () => {
      selection.toggle(playlist.id, item.id, checkbox.checked)
    })
    li.append(checkbox, grip, info, controls)
  } else {
    li.append(grip, info, controls)
  }
  return li
}
