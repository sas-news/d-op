// ♪ add menu + playlist picker — ports createAddButton/openPlaylistModal/
// addCurrentRangeToPlaylist (content.js:586-697, 1138-1227, 1372-1404).
// The ♪ button anchors after `.buttonArea .time` on the native 50px bar and
// hover/focus opens a popup listing the detected OP/ED-like chapter ranges
// (labels overridden by stored playlist names) plus a 'カスタム範囲' row that
// enters custom-preview selection. The picker modal multi-selects target
// playlists and/or creates a new one, then fans the item out through a single
// serialized replace-library command (v2 storage contract — the legacy code
// issued N independent writes; folding them keeps one receipt).
// Item metadata is scraped from the isolated-world DOM (#backInfo) and the
// validated partId URL param — the page bridge deliberately carries only
// bounded chapter data (docs/current-extension-behavior.md §8).

import type {
  LocalCommand,
  LocalItem,
  LocalPlaylist,
} from "../../../../packages/shared/src/local-model"
import { addItem, createPlaylist } from "../domain/playlist"
import { guessRangeName } from "../domain/range"
import type { CommandReply, PublicLocalState } from "../storage/repository"
import { decodeHtmlEntities, formatSec, isSystemPlaylist } from "../ui/format"
import { runMutation } from "../ui/storage-client"
import { ADD_POPUP_HIDE_DELAY_MS } from "./constants"
import type { EnforcedRange } from "./enforcement"
import type { CustomDraft, ModalRequest, NamedRange, PlayerVideo } from "./runtime"

export type AddMenuSession = {
  readonly partId: string | null
  readonly chapters: readonly EnforcedRange[] | null
}

export type AddMenuDeps = {
  readonly getVideo: () => PlayerVideo | undefined
  readonly getSession: () => AddMenuSession
  readonly readPublic: () => Promise<PublicLocalState>
  readonly dispatch: (command: LocalCommand) => Promise<CommandReply>
  readonly newId: () => string
  readonly showModal: (request: ModalRequest) => Promise<string | null>
  readonly beginCustomPreview: () => Promise<boolean>
  readonly getCustomDraft: () => CustomDraft | null
  readonly endCustomPreview: () => Promise<void>
  readonly currentUrl: () => string
  readonly schedule: (callback: () => void, ms: number) => unknown
  readonly cancelTimer: (timer: unknown) => void
  /** Marker/library refresh hook fired after a successful add. */
  readonly onChanged?: () => void
  readonly log?: (label: string, data?: unknown) => void
}

export type AddMenu = {
  /** Debounced-ish refresh: serializes and coalesces async rebuilds. */
  readonly refresh: () => void
  /** '追加' on the custom bar — validate the draft then open the picker. */
  readonly openCustomPicker: () => Promise<void>
  readonly dispose: () => void
}

/** Metadata scraped for a new playlist item (legacy addCurrentRangeToPlaylist
 *  fields: partId/workId/title/episodeTitle/episodeNumber/url). */
export function readPlayerPageInfo(
  doc: Document,
  href: string,
): {
  readonly partId: string | null
  readonly workId: string | undefined
  readonly workTitle: string
  readonly episodeNumber: string
  readonly episodeTitle: string
} {
  let partId: string | null = null
  let urlTitle = ""
  let urlEpisode = ""
  try {
    const params = new URL(href).searchParams
    partId = params.get("partId")
    urlTitle = decodeHtmlEntities(params.get("dopTitle") ?? "")
    urlEpisode = decodeHtmlEntities(params.get("dopEpisodeTitle") ?? "")
  } catch {
    // Malformed location — fall back to DOM only.
  }
  const backInfo = doc.getElementById("backInfo")
  const txt = (selector: string): string =>
    backInfo?.querySelector(selector)?.textContent?.trim() ?? ""
  let workId: string | undefined
  const anchor =
    backInfo instanceof HTMLAnchorElement
      ? backInfo
      : ((backInfo?.querySelector("a[href*='workId=']") ??
          doc.querySelector("a[href*='workId=']")) as HTMLAnchorElement | null)
  if (anchor !== null && anchor !== undefined) {
    try {
      workId = new URL(anchor.href, doc.baseURI).searchParams.get("workId") ?? undefined
    } catch {
      workId = undefined
    }
  }
  return {
    partId,
    workId,
    workTitle: urlTitle !== "" ? urlTitle : txt(".backInfoTxt1"),
    episodeNumber: txt(".backInfoTxt2"),
    episodeTitle: urlEpisode !== "" ? urlEpisode : txt(".backInfoTxt3"),
  }
}

export function createAddMenu(doc: Document, deps: AddMenuDeps): AddMenu {
  let popupHideTimer: unknown
  let refreshing = false
  let refreshQueued = false
  let disposed = false

  function createPopupRow(label: string, onClick: () => void): HTMLButtonElement {
    // Button rows (task 24): the div variant was unreachable by keyboard.
    const row = doc.createElement("button")
    row.type = "button"
    row.className = "d-op-popup-item"
    row.textContent = label
    row.addEventListener("click", (event) => {
      event.stopPropagation()
      onClick()
    })
    return row
  }

  function ensureWrapper(): HTMLElement | null {
    let wrapper = doc.getElementById("d-op-add-wrapper") as HTMLElement | null
    if (wrapper !== null) return wrapper
    wrapper = doc.createElement("div")
    wrapper.id = "d-op-add-wrapper"
    wrapper.className = "d-op-add-wrapper"

    const button = doc.createElement("button")
    button.type = "button"
    button.className = "d-op-add-button"
    button.textContent = "♪"
    button.title = "プレイリストに追加"
    button.setAttribute("aria-label", "プレイリストに追加")
    button.setAttribute("aria-haspopup", "true")
    button.setAttribute("aria-controls", "d-op-add-popup")
    button.setAttribute("aria-expanded", "false")

    const popup = doc.createElement("div")
    popup.id = "d-op-add-popup"
    popup.className = "d-op-popup"

    wrapper.appendChild(button)
    wrapper.appendChild(popup)

    const showPopup = (): void => {
      if (popupHideTimer !== undefined) {
        deps.cancelTimer(popupHideTimer)
        popupHideTimer = undefined
      }
      popup.classList.add("d-op-popup-visible")
      button.setAttribute("aria-expanded", "true")
    }
    const hidePopup = (): void => {
      popup.classList.remove("d-op-popup-visible")
      button.setAttribute("aria-expanded", "false")
    }
    const scheduleHide = (): void => {
      popupHideTimer = deps.schedule(() => {
        popupHideTimer = undefined
        hidePopup()
      }, ADD_POPUP_HIDE_DELAY_MS)
    }
    // Hover + focus keep the popup open while the pointer/cursor is inside
    // (content.js:641-644 adds focus parity via CSS :focus-within); explicit
    // focusin/focusout mirror it so aria-expanded stays truthful for
    // keyboard users even where :focus-within styling already shows it.
    wrapper.addEventListener("mouseenter", showPopup)
    wrapper.addEventListener("mouseleave", scheduleHide)
    popup.addEventListener("mouseenter", showPopup)
    popup.addEventListener("mouseleave", scheduleHide)
    wrapper.addEventListener("focusin", showPopup)
    wrapper.addEventListener("focusout", (event) => {
      const next = event.relatedTarget
      if (next instanceof Node && wrapper.contains(next)) return
      scheduleHide()
    })
    // Escape closes the popup and returns focus to the ♪ trigger.
    wrapper.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      if (popupHideTimer !== undefined) {
        deps.cancelTimer(popupHideTimer)
        popupHideTimer = undefined
      }
      hidePopup()
      button.focus()
    })
    return wrapper
  }

  /** Stored range-name overrides for this partId — legacy
   *  loadPlaylistRangeNames (content.js:587-600); last writer wins. */
  async function loadRangeNames(partId: string): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    const state = await deps.readPublic()
    for (const playlist of state.playlists) {
      for (const item of playlist.items) {
        if (item.partId === partId && item.range !== null && item.range.name !== undefined) {
          names.set(`${item.range.start}|${item.range.end}`, item.range.name)
        }
      }
    }
    return names
  }

  async function rebuild(): Promise<void> {
    const wrapper = ensureWrapper()
    if (wrapper === null) return
    const session = deps.getSession()
    const partId = session.partId
    const popup = wrapper.querySelector<HTMLElement>(".d-op-popup")
    // Legacy rebuilt only on partId change (content.js:637) — but chapters
    // land AFTER first paint via the bridge, so the rebuild key also covers
    // the chapter fingerprint: a part with chapters pending rebuilds once
    // they arrive, then stays put (no observer-driven rebuild churn).
    const chaptersKey =
      session.chapters === null
        ? "pending"
        : session.chapters.map((c) => `${c.startMs}-${c.endMs}`).join("|")
    const popupKey = `${partId}#${chaptersKey}`
    const shouldRebuild =
      popup !== null && partId !== null && wrapper.dataset["dopPopupKey"] !== popupKey
    if (shouldRebuild && popup !== null && partId !== null) {
      const names = await loadRangeNames(partId)
      if (disposed) return
      popup.replaceChildren()
      const video = deps.getVideo()
      const durationMs =
        video !== undefined && Number.isFinite(video.duration) && video.duration > 0
          ? video.duration * 1000
          : Number.POSITIVE_INFINITY
      const chapters = session.chapters ?? []
      const ranges: NamedRange[] = chapters.map((chapter, index) => ({
        startMs: chapter.startMs,
        endMs: chapter.endMs,
        name: guessRangeName({
          range: { start: chapter.startMs, end: chapter.endMs },
          index,
          total: chapters.length,
          durationMs,
        }),
      }))
      if (ranges.length === 0) {
        const emptyRow = createPopupRow("スキップ区間なし", () => {})
        emptyRow.disabled = true
        popup.appendChild(emptyRow)
      } else {
        for (const range of ranges) {
          const key = `${range.startMs}|${range.endMs}`
          const displayName = names.get(key) ?? range.name
          const label = `${displayName} (${formatSec(range.startMs)}-${formatSec(range.endMs)})`
          popup.appendChild(
            createPopupRow(`${label} を追加`, () => void openPlaylistModal(displayName, range)),
          )
        }
      }
      popup.appendChild(createPopupRow("カスタム範囲", () => void deps.beginCustomPreview()))
      wrapper.dataset["dopPopupKey"] = popupKey
    }

    // Anchor after `.buttonArea .time` on the native bar (content.js:672-680).
    const timeEl = doc.querySelector(".buttonArea .time")
    if (timeEl?.parentNode != null && wrapper.parentNode !== timeEl.parentNode) {
      const next = timeEl.nextElementSibling
      if (next !== null) timeEl.parentNode.insertBefore(wrapper, next)
      else timeEl.parentNode.appendChild(wrapper)
    }
  }

  /** Serialized rebuild — concurrent refresh() calls coalesce, never overlap
   *  (guards the async readPublic inside rebuild). */
  function refresh(): void {
    if (disposed) return
    if (refreshing) {
      refreshQueued = true
      return
    }
    refreshing = true
    void (async () => {
      try {
        do {
          refreshQueued = false
          await rebuild()
        } while (refreshQueued && !disposed)
      } catch (error) {
        deps.log?.("add-menu-refresh-failed", error)
      } finally {
        refreshing = false
      }
    })()
  }

  async function showError(body: string): Promise<void> {
    await deps.showModal({
      title: "エラー",
      body,
      buttons: [{ label: "OK", value: "ok", primary: true }],
    })
  }

  /** Port of openPlaylistModal (content.js:1138-1227): multi-select target
   *  playlists and/or create a new one; the add button enables when either
   *  path exists. */
  async function openPlaylistModal(defaultName: string, range: NamedRange): Promise<void> {
    let state: PublicLocalState
    try {
      state = await deps.readPublic()
    } catch (error) {
      deps.log?.("add-menu-read-failed", error)
      await showError("プレイリストの読み込みに失敗しました。")
      return
    }
    if (disposed) return
    const playlists = state.playlists.filter((playlist) => !isSystemPlaylist(playlist))

    const list = doc.createElement("div")
    list.className = "d-op-modal-playlist-list"
    const selectedIds = new Set<string>()

    if (playlists.length === 0) {
      const empty = doc.createElement("div")
      empty.className = "d-op-modal-playlist-empty"
      empty.textContent = "プレイリストがありません。以下から新規作成してください。"
      list.appendChild(empty)
    }

    let addButton: HTMLButtonElement | null = null
    const newInput = doc.createElement("input")
    const updateAddButton = (): void => {
      if (addButton !== null)
        addButton.disabled = selectedIds.size === 0 && newInput.value.trim() === ""
    }

    for (const playlist of playlists) {
      const row = doc.createElement("button")
      row.type = "button"
      row.className = "d-op-modal-playlist-item"
      row.textContent = `${playlist.name} (${playlist.items.length}曲)`
      // Toggle semantics for screen readers — the .selected class alone is
      // visual-only.
      row.setAttribute("aria-pressed", "false")
      row.addEventListener("click", () => {
        if (selectedIds.has(playlist.id)) {
          selectedIds.delete(playlist.id)
          row.classList.remove("selected")
          row.setAttribute("aria-pressed", "false")
        } else {
          selectedIds.add(playlist.id)
          row.classList.add("selected")
          row.setAttribute("aria-pressed", "true")
        }
        updateAddButton()
      })
      list.appendChild(row)
    }

    const newRow = doc.createElement("div")
    newRow.className = "d-op-modal-new-row"
    newInput.type = "text"
    newInput.placeholder = "新規プレイリスト名"
    newInput.setAttribute("aria-label", "新規プレイリスト名")
    newInput.addEventListener("input", updateAddButton)
    newRow.appendChild(newInput)

    const nameRow = doc.createElement("div")
    nameRow.className = "d-op-modal-new-row d-op-modal-name-row"
    const nameInput = doc.createElement("input")
    nameInput.type = "text"
    nameInput.placeholder = "区間名"
    nameInput.setAttribute("aria-label", "区間名")
    nameInput.value = defaultName
    nameRow.appendChild(nameInput)

    const content = doc.createElement("div")
    content.append(list, newRow, nameRow)

    const result = await deps.showModal({
      title: "プレイリストに追加",
      body: "",
      bodyNode: content,
      buttons: [
        { label: "キャンセル", value: "cancel" },
        { label: "追加", value: "add", primary: true, disabled: true },
      ],
      onReady: ({ root }) => {
        addButton = root.querySelector<HTMLButtonElement>(".d-op-modal-footer button.primary")
        updateAddButton()
      },
    })
    if (result !== "add" || disposed) return

    const newPlaylistName = newInput.value.trim()
    if (selectedIds.size === 0 && newPlaylistName === "") return

    const info = readPlayerPageInfo(doc, deps.currentUrl())
    if (info.partId === null || info.partId === "") {
      await showError("このページでは追加できません。")
      return
    }
    const itemName = nameInput.value.trim() || defaultName || "範囲"
    const draft: Omit<LocalItem, "id"> = {
      partId: info.partId,
      workId: info.workId,
      title: info.workTitle,
      episodeTitle: info.episodeTitle,
      episodeNumber: info.episodeNumber !== "" ? info.episodeNumber : undefined,
      url: deps.currentUrl(),
      range: { start: range.startMs, end: range.endMs, name: itemName },
    }

    const reply = await runMutation(
      { readPublic: deps.readPublic, dispatch: deps.dispatch },
      (fresh) => {
        let playlists: readonly LocalPlaylist[] = fresh.playlists
        for (const id of selectedIds) {
          if (!playlists.some((playlist) => playlist.id === id)) continue
          const added = addItem(playlists, {
            playlistId: id,
            item: draft,
            nextId: deps.newId,
          })
          if (added.kind !== "updated") return null
          playlists = added.playlists
        }
        if (newPlaylistName !== "") {
          const created = createPlaylist(playlists, newPlaylistName, deps.newId)
          if (created.kind !== "updated") return null
          playlists = created.playlists
          const createdPlaylist = playlists[playlists.length - 1]
          if (createdPlaylist === undefined) return null
          const added = addItem(playlists, {
            playlistId: createdPlaylist.id,
            item: draft,
            nextId: deps.newId,
          })
          if (added.kind !== "updated") return null
          playlists = added.playlists
        }
        return { kind: "replace-library", playlists: [...playlists] }
      },
      deps.newId,
    )
    if (disposed) return
    if (reply.kind === "committed") {
      deps.onChanged?.()
      await deps.showModal({
        title: "追加完了",
        body: "プレイリストに追加しました。",
        buttons: [{ label: "OK", value: "ok", primary: true }],
      })
      return
    }
    deps.log?.("add-menu-mutation-failed", reply)
    await showError("追加に失敗しました。もう一度お試しください。")
  }

  /** '追加' on the custom bar (content.js:1323-1338): validate the draft then
   *  open the picker; the bar stays open unless the add commits. */
  async function openCustomPicker(): Promise<void> {
    const draft = deps.getCustomDraft()
    if (
      draft === null ||
      draft.startMs === null ||
      draft.endMs === null ||
      draft.startMs >= draft.endMs
    ) {
      await showError("開始地点は終了地点より前に設定してください。")
      return
    }
    const defaultName = draft.name !== "" ? draft.name : "CUSTOM"
    await openPlaylistModal(defaultName, {
      startMs: draft.startMs,
      endMs: draft.endMs,
      name: defaultName,
    })
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (popupHideTimer !== undefined) deps.cancelTimer(popupHideTimer)
    popupHideTimer = undefined
    doc.getElementById("d-op-add-wrapper")?.remove()
  }

  return { refresh, openCustomPicker, dispose }
}
