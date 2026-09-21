// Options controller — ports options.js (legacy lines 1-906). Playlist CRUD,
// collapse state, and the window-mode preference live here; item rows/copy
// (options-items.ts), drag reorder (options-drag.ts), and JSON import/export
// (options-io.ts) are sibling modules this controller composes. All
// persistent mutations go through DOP_STORAGE_COMMAND
// (replace-library/set-preferences/typed ops) with revision-checked retries;
// playback starts via transient write + REQUEST_PLAYER. Modals are the shared
// custom host — never alert/confirm/prompt.

import type { TransientPlayback } from "../../../../packages/shared/src/local-model"
import { createModalHost } from "../player/modal"
import { mutateTransientState, withPlayback } from "../player/transient-session"
import { buildPlaylistItemUrl } from "../player/url-params"
import type { DataPermissions } from "../share/consent"
import { publicationDirty } from "../share/dirty-state"
import { createShareManageClient } from "../share/management-protocol"
import { createShareConsentSection } from "./consent-section"
import { formatSec, isSystemPlaylist, itemPlaybackUrl } from "./format"
import { createShareManagement } from "./management"
import { createDragController } from "./options-drag"
import { createImportExport } from "./options-io"
import { buildItemRow } from "./options-items"
import { createShareDialog } from "./share-dialog"
import { runMutation, type UiStorageClient } from "./storage-client"

export type OptionsDeps = {
  readonly doc: Document
  readonly storage: UiStorageClient
  readonly sendMessage: (message: unknown) => Promise<unknown>
  readonly version: string
  /**
   * Task 22: Firefox ≥140 native data-consent surface (browser.permissions).
   * Absent → the persisted in-extension decision alone gates Share traffic.
   */
  readonly dataPermissions?: DataPermissions
  readonly now: () => number
  readonly newId: () => string
  readonly schedule: (callback: () => void, ms: number) => unknown
  readonly cancelTimer: (timer: unknown) => void
  readonly subscribe: (listener: () => void) => () => void
  readonly copyText?: (text: string) => Promise<boolean>
  readonly log?: (label: string, data?: unknown) => void
}

export type OptionsController = {
  readonly start: () => void
  readonly dispose: () => void
}

export function createOptionsController(deps: OptionsDeps): OptionsController {
  const doc = deps.doc
  const modal = createModalHost(doc)
  const ownerToken = deps.newId()
  let renderQueued = false
  let renderRunning = false
  let unsubscribe: (() => void) | null = null
  let disposed = false
  let statusTimer: unknown

  const el = <T extends HTMLElement>(id: string): T | null => doc.getElementById(id) as T | null

  function showStatus(text: string, type: "success" | "error" = "success"): void {
    const status = el("importStatus")
    if (status === null) return
    status.textContent = text
    status.className = type === "error" ? "error" : "success"
    if (statusTimer !== undefined) deps.cancelTimer(statusTimer)
    statusTimer = deps.schedule(() => {
      statusTimer = undefined
      status.textContent = ""
      status.className = ""
    }, 3000)
  }

  async function showConfirm(message: string): Promise<boolean> {
    const value = await modal.show({
      title: "",
      body: message,
      buttons: [
        { label: "キャンセル", value: "cancel" },
        { label: "削除", value: "ok", primary: true },
      ],
    })
    return value === "ok"
  }

  /** startPlaylistPlayback (options.js:712-730): transient index write +
   *  REQUEST_PLAYER. v2 permits null-range items (full-episode playback). */
  async function startPlaylistPlayback(playlistId: string, index = 0): Promise<void> {
    const state = await deps.storage.readPublic()
    const playlist = state.playlists.find((candidate) => candidate.id === playlistId)
    if (playlist === undefined || playlist.items.length === 0) {
      await modal.show({
        title: "",
        body: "プレイリストが空です。",
        buttons: [{ label: "OK", value: "ok", primary: true }],
      })
      return
    }
    const item = playlist.items[index]
    if (item === undefined) return
    const itemUrl = itemPlaybackUrl(item)
    if (itemUrl === null) {
      await modal.show({
        title: "",
        body: "選択したアイテムの再生URLがありません。",
        buttons: [{ label: "OK", value: "ok", primary: true }],
      })
      return
    }
    const playback: TransientPlayback = {
      playlistId: playlist.id,
      index,
      updatedAt: deps.now(),
      ownerToken,
      ownerGeneration: 1,
    }
    await mutateTransientState(
      () => deps.storage.readTransient(),
      (next) => deps.storage.writeTransient(next),
      (current) => withPlayback(current, playback),
    )
    await deps.sendMessage({
      kind: "REQUEST_PLAYER",
      url: buildPlaylistItemUrl(itemUrl, playlistId, index),
    })
  }

  const drag = createDragController(deps)
  const itemRowCtx = {
    doc,
    deps,
    modal,
    showStatus,
    showConfirm,
    render: () => render(),
    startPlaylistPlayback,
    reorderItem: (row: HTMLElement, delta: -1 | 1) => drag.moveByKey(row, delta),
  }
  const io = createImportExport({
    doc,
    deps,
    modal,
    showStatus,
    render: () => render(),
  })
  // Task 15: share management lives on the privileged options surface only.
  // The manage client forwards typed intents to the background worker, which
  // alone performs Share API calls; this page never fetches the share origin.
  const manage = createShareManageClient(deps.sendMessage)
  const shareDialog = createShareDialog({
    doc,
    modal,
    storage: deps.storage,
    manage,
    newId: deps.newId,
    dataPermissions: deps.dataPermissions,
    copyText: deps.copyText ?? (async () => false),
    showStatus,
    subscribe: deps.subscribe,
    log: deps.log,
    onChanged: () => render(),
  })
  // Local data step 7: the detached '共有管理 / ローカル削除済み' list renders
  // alongside playlists on every render cycle.
  const management = createShareManagement({
    doc,
    storage: deps.storage,
    manage,
    newId: deps.newId,
    modal,
    showStatus,
    log: deps.log,
    onChanged: () => render(),
  })
  // Task 22: explicit Share consent section — renders the persisted decision
  // (undecided/granted/declined) and writes choices through the repository.
  const consentSection = createShareConsentSection({
    doc,
    storage: deps.storage,
    dataPermissions: deps.dataPermissions,
    newId: deps.newId,
    showStatus,
    log: deps.log,
    onChanged: () => render(),
  })

  /**
   * Keyboard-driven mutations (reorder, rename, collapse) commit through the
   * single writer and come back through subscribe() as a full re-render, which
   * replaces every node and drops focus to <body>. Capture the focused
   * control's identity before the rebuild and re-focus the equivalent fresh
   * node afterwards so keyboard flows never lose their place (task 24).
   */
  function takeFocusRestore(container: HTMLElement): (() => void) | null {
    const active = doc.activeElement
    if (!(active instanceof HTMLElement) || !container.contains(active)) return null
    const itemRow = active.closest<HTMLElement>(".item-row")
    if (itemRow !== null && active.classList.contains("drag-grip")) {
      const itemId = itemRow.dataset["itemId"]
      if (itemId === undefined) return null
      return () => {
        container
          .querySelector<HTMLElement>(`.item-row[data-item-id="${itemId}"] .drag-grip`)
          ?.focus()
      }
    }
    const card = active.closest<HTMLElement>(".playlist-card")
    const playlistId = card?.dataset["playlistId"]
    if (playlistId === undefined) return null
    if (active.classList.contains("playlist-name-input")) {
      return () => {
        const input = container.querySelector<HTMLInputElement>(
          `.playlist-card[data-playlist-id="${playlistId}"] .playlist-name-input`,
        )
        input?.focus()
        input?.setSelectionRange(input.value.length, input.value.length)
      }
    }
    if (active.classList.contains("playlist-toggle")) {
      return () => {
        container
          .querySelector<HTMLElement>(
            `.playlist-card[data-playlist-id="${playlistId}"] .playlist-toggle`,
          )
          ?.focus()
      }
    }
    // Action buttons (item 編集/コピー/削除/▶ and card 再生/共有/削除): after a
    // mutation the same labelled button is re-focused inside its row scope;
    // when the row itself was deleted the card toggle is the safe landing.
    if (active instanceof HTMLButtonElement) {
      const row = active.closest<HTMLElement>(".item-row")
      const itemId = row?.dataset["itemId"]
      const label = active.textContent ?? ""
      return () => {
        const scope =
          itemId === undefined
            ? container.querySelector<HTMLElement>(
                `.playlist-card[data-playlist-id="${playlistId}"]`,
              )
            : container.querySelector<HTMLElement>(`.item-row[data-item-id="${itemId}"]`)
        const sameLabel = Array.from(scope?.querySelectorAll("button") ?? []).find(
          (candidate) => candidate.textContent === label,
        )
        const fallback = container.querySelector<HTMLElement>(
          `.playlist-card[data-playlist-id="${playlistId}"] .playlist-toggle`,
        )
        ;(sameLabel ?? fallback)?.focus()
      }
    }
    return null
  }

  async function renderPlaylists(): Promise<void> {
    const container = el("playlistsContainer")
    if (container === null) return
    const state = await deps.storage.readPublic()
    // Vault read feeds the per-card share state badge; a privileged-read
    // failure degrades to plain "共有" buttons rather than breaking render.
    const publications = await deps.storage
      .readVault()
      .then((vault) => vault.publications)
      .catch((error: unknown) => {
        deps.log?.("vault-read-failed", error)
        return []
      })
    if (disposed) return
    const playlists = state.playlists.filter((playlist) => !isSystemPlaylist(playlist))
    const collapsed = state.preferences.collapsedPlaylists
    const restoreFocus = takeFocusRestore(container)
    container.replaceChildren()

    if (playlists.length === 0) {
      const empty = doc.createElement("div")
      empty.className = "empty-state"
      const icon = doc.createElement("div")
      icon.className = "empty-state-icon"
      icon.textContent = "♪"
      const text = doc.createElement("div")
      text.textContent = "プレイリストがありません。"
      empty.append(icon, text)
      container.appendChild(empty)
      return
    }

    for (const playlist of playlists) {
      const card = doc.createElement("div")
      card.className = "playlist-card"
      card.dataset["playlistId"] = playlist.id

      const header = doc.createElement("div")
      header.className = "playlist-header"

      const toggleGroup = doc.createElement("span")
      toggleGroup.className = "playlist-toggle-group"
      // Real button (task 24): keyboard-focusable collapse toggle — the
      // legacy span was mouse-only. aria-expanded mirrors .collapsed.
      const toggleBtn = doc.createElement("button")
      toggleBtn.type = "button"
      toggleBtn.className = "playlist-toggle"
      toggleBtn.textContent = "▶"
      toggleBtn.setAttribute("aria-label", `${playlist.name}の一覧を開閉`)
      // Legacy semantics: collapsed by default; only an explicit `false`
      // expands (options.js:49, 398).
      const expanded = collapsed[playlist.id] === false
      if (expanded) toggleBtn.classList.add("expanded")
      toggleBtn.setAttribute("aria-expanded", String(expanded))
      const count = doc.createElement("span")
      count.className = "playlist-count"
      const totalMs = playlist.items.reduce(
        (sum, item) => (item.range !== null ? sum + (item.range.end - item.range.start) : sum),
        0,
      )
      count.textContent = `${playlist.items.length}件 / ${formatSec(totalMs)}`
      toggleGroup.append(toggleBtn, count)

      const nameInput = doc.createElement("input")
      nameInput.type = "text"
      nameInput.value = playlist.name
      nameInput.className = "playlist-name-input"
      nameInput.setAttribute("aria-label", "プレイリスト名")
      nameInput.addEventListener("change", () => {
        const name = nameInput.value.trim()
        if (name === "" || name === playlist.name) return
        void runMutation(
          deps.storage,
          () => ({ kind: "rename-playlist", playlistId: playlist.id, name }),
          deps.newId,
        ).then((reply) => {
          if (reply.kind !== "committed") showStatus("名前の変更に失敗しました。", "error")
          render()
        })
      })

      const actions = doc.createElement("div")
      actions.className = "playlist-actions"
      const playBtn = doc.createElement("button")
      playBtn.type = "button"
      playBtn.textContent = "▶ 再生"
      playBtn.className = "btn-text"
      playBtn.addEventListener("click", () => void startPlaylistPlayback(playlist.id))
      const shareBtn = doc.createElement("button")
      shareBtn.type = "button"
      shareBtn.className = "btn-text share-open"
      const record = publications.find((entry) => entry.localPlaylistId === playlist.id)
      if (record === undefined) {
        shareBtn.textContent = "共有"
      } else if (record.state === "pending") {
        shareBtn.textContent = "共有 (手続き中)"
      } else {
        const dirty = await publicationDirty(record, playlist)
        shareBtn.textContent = dirty.kind === "clean" ? "共有中" : "共有 (変更あり)"
      }
      shareBtn.addEventListener("click", () => void shareDialog.open(playlist.id))
      const deleteBtn = doc.createElement("button")
      deleteBtn.type = "button"
      deleteBtn.textContent = "削除"
      deleteBtn.className = "btn-danger-text"
      deleteBtn.addEventListener("click", () => {
        void (async () => {
          const ok = await showConfirm(`プレイリスト「${playlist.name}」を削除しますか？`)
          if (!ok) return
          const reply = await runMutation(
            deps.storage,
            () => ({ kind: "delete-playlist", playlistId: playlist.id }),
            deps.newId,
          )
          if (reply.kind !== "committed") showStatus("削除に失敗しました。", "error")
          render()
        })()
      })
      actions.append(playBtn, shareBtn, deleteBtn)
      header.append(toggleGroup, nameInput, actions)
      card.appendChild(header)

      const itemsList = doc.createElement("ol")
      itemsList.className = "items-list"
      // Keyboard reorder resolves the owning playlist from the list node so
      // the same moveByKey path works after any re-render.
      itemsList.dataset["playlistId"] = playlist.id
      for (const item of playlist.items) {
        itemsList.appendChild(buildItemRow(itemRowCtx, playlist, item))
      }
      itemsList.addEventListener("mousedown", (event) => {
        const grip = (event.target as HTMLElement).closest(".drag-grip")
        if (grip === null) return
        event.preventDefault()
        const row = grip.closest<HTMLElement>(".item-row")
        if (row === null) return
        const rowRect = row.getBoundingClientRect()
        const clone = row.cloneNode(true) as HTMLElement
        clone.classList.add("drag-clone")
        clone.style.width = `${rowRect.width}px`
        clone.style.left = `${rowRect.left}px`
        clone.style.top = `${rowRect.top}px`
        ;(doc.body ?? doc.documentElement).appendChild(clone)
        row.classList.add("dragging")
        drag.begin({
          row,
          clone,
          itemsList,
          playlistId: playlist.id,
          offsetY: event.clientY - rowRect.top,
        })
      })

      const setCollapsed = (isCollapsed: boolean): void => {
        card.classList.toggle("collapsed", isCollapsed)
        toggleBtn.classList.toggle("expanded", !isCollapsed)
        toggleBtn.setAttribute("aria-expanded", String(!isCollapsed))
        void runMutation(
          deps.storage,
          (fresh) => ({
            kind: "set-preferences",
            preferences: {
              ...fresh.preferences,
              collapsedPlaylists: {
                ...fresh.preferences.collapsedPlaylists,
                [playlist.id]: isCollapsed,
              },
            },
          }),
          deps.newId,
        )
      }

      // The toggle button is skipped by the header's input/button guard, so it
      // needs its own activation path for keyboard users.
      toggleBtn.addEventListener("click", () => {
        setCollapsed(!card.classList.contains("collapsed"))
      })

      header.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("input, button") !== null) return
        setCollapsed(!card.classList.contains("collapsed"))
      })

      const itemsWrapper = doc.createElement("div")
      itemsWrapper.className = "playlist-items-wrapper"
      itemsWrapper.appendChild(itemsList)
      if (collapsed[playlist.id] !== false) card.classList.add("collapsed")
      card.appendChild(itemsWrapper)
      container.appendChild(card)
    }
    restoreFocus?.()
  }

  /** render() coalescing guard (popup.js:76-81 parity). */
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
          await renderPlaylists()
          await consentSection.render(el("shareConsentBox"))
          await management.render(el("managementList"))
        } while (renderQueued && !disposed)
      } catch (error) {
        deps.log?.("options-render-failed", error)
      } finally {
        renderRunning = false
      }
    })()
  }

  // --- Window-mode preference (options.js:893-905) ------------------------

  async function initWindowMode(): Promise<void> {
    const radios = doc.querySelectorAll<HTMLInputElement>("input[name='windowMode']")
    if (radios.length === 0) return
    const state = await deps.storage.readPublic()
    if (disposed) return
    const target = doc.querySelector<HTMLInputElement>(
      `input[name='windowMode'][value='${state.preferences.windowMode}']`,
    )
    if (target !== null) target.checked = true
    for (const radio of radios) {
      radio.addEventListener("change", () => {
        if (!radio.checked) return
        const windowMode = radio.value === "tab" ? "tab" : "window"
        void runMutation(
          deps.storage,
          (fresh) => ({
            kind: "set-preferences",
            preferences: { ...fresh.preferences, windowMode },
          }),
          deps.newId,
        )
      })
    }
  }

  function start(): void {
    const versionEl = el("optionsVersion")
    if (versionEl !== null) versionEl.textContent = `d-OP v${deps.version}`

    const createBtn = el<HTMLButtonElement>("createPlaylistBtn")
    const newNameInput = el<HTMLInputElement>("newPlaylistName")
    createBtn?.addEventListener("click", () => {
      const name = newNameInput?.value.trim() ?? ""
      if (name === "") return
      void runMutation(deps.storage, () => ({ kind: "create-playlist", name }), deps.newId).then(
        (reply) => {
          if (reply.kind === "committed" && newNameInput !== null) newNameInput.value = ""
          render()
        },
      )
    })
    newNameInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        createBtn?.click()
      }
    })

    const exportBtn = el<HTMLButtonElement>("exportBtn")
    exportBtn?.classList.add("btn-secondary")
    exportBtn?.addEventListener("click", () => void io.exportJson())
    const importFile = el<HTMLInputElement>("importFile")
    importFile?.addEventListener("change", () => {
      const file = importFile.files?.[0]
      if (file !== undefined) void io.importJson(file, importFile)
    })

    // Document-level drag listeners attach ONCE — the legacy per-render
    // listener accumulation is a known leak we do not port.
    doc.addEventListener("mousemove", drag.onMouseMove)
    doc.addEventListener("mouseup", drag.onMouseUp)

    unsubscribe = deps.subscribe(() => render())
    void initWindowMode()
    render()
  }

  function dispose(): void {
    disposed = true
    unsubscribe?.()
    unsubscribe = null
    doc.removeEventListener("mousemove", drag.onMouseMove)
    doc.removeEventListener("mouseup", drag.onMouseUp)
    if (statusTimer !== undefined) deps.cancelTimer(statusTimer)
    drag.cancel()
    modal.dispose()
  }

  return { start, dispose }
}
