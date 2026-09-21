// Work/episode-list page decorator — ports content-store.js (legacy lines
// 1-203). Adds an 'OP/ED' button to each .itemModule; click fetches the
// player document, parses embedded chapter JSON (same regex contract —
// "chapters":[...] and "duration":N), and shows a range menu of type==='none'
// chapters named by guessRangeName. When the fetch fails or yields no
// chapters, the menu falls back to opening the player at dopRangeIndex=0 —
// the player page then applies its own chapter flow (first-range fallback).
// Dynamic items are decorated via a debounced MutationObserver; each item is
// marked once (data-dop-decorated) so observer ticks never rebuild the page.
import { PLAYBACK_URL_PATH } from "../../../../packages/shared/src/limits"
import { guessRangeName } from "../domain/range"
import {
  captureFocusOrigin,
  focusablesIn,
  restoreFocusOrigin,
  trapTabKey,
} from "../player/focus-trap"
import { decodeHtmlEntities, formatSec } from "./format"

export type StoreChapter = {
  readonly start: number
  readonly end: number
  readonly type?: string | undefined
}

export type ChapterFetchResult = {
  readonly chapters: readonly StoreChapter[]
  readonly durationMs: number | null
} | null

export type StorePageDeps = {
  /** Fetch + parse the player document for this partId (isolated fetch). */
  readonly fetchChapters: (partId: string) => Promise<ChapterFetchResult>
  /** Send the validated REQUEST_PLAYER message (background window manager). */
  readonly requestPlayer: (url: string) => Promise<unknown>
  readonly origin: () => string
  readonly schedule: (callback: () => void, ms: number) => unknown
  readonly cancelTimer: (timer: unknown) => void
  readonly debounceMs: number
  readonly log?: (label: string, data?: unknown) => void
}

export type StorePage = {
  readonly start: () => void
  readonly dispose: () => void
}

function findPartId(element: Element): string | null {
  const link = element.querySelector("a[href*='partId=']")
  if (link === null) return null
  const href = link.getAttribute("href")
  if (href === null) return null
  try {
    return new URL(href, "https://animestore.docomo.ne.jp").searchParams.get("partId")
  } catch {
    return null
  }
}

export function createStorePage(doc: Document, deps: StorePageDeps): StorePage {
  let observer: MutationObserver | null = null
  let decorateTimer: unknown
  let menu: HTMLElement | null = null
  let menuAnchor: HTMLElement | null = null
  let menuClose: ((event: Event) => void) | null = null
  let disposed = false

  function findWorkTitle(): string {
    return doc.querySelector("h1")?.textContent?.trim() ?? ""
  }

  function findEpisodeTitle(element: Element): string {
    return element.querySelector("h3")?.textContent?.trim() ?? ""
  }

  async function playEpisode(
    partId: string,
    rangeIndex: number,
    episodeTitle: string,
  ): Promise<void> {
    try {
      const params = new URLSearchParams()
      params.set("partId", partId)
      params.set("dopRangeIndex", String(rangeIndex))
      params.set("dopTitle", findWorkTitle())
      params.set("dopEpisodeTitle", episodeTitle)
      await deps.requestPlayer(`${deps.origin()}${PLAYBACK_URL_PATH}?${params.toString()}`)
    } catch (error) {
      deps.log?.("store-play-failed", error)
      await showError("再生の準備に失敗しました。")
    }
  }

  function closeMenu(): void {
    menu?.remove()
    menu = null
    menuAnchor?.setAttribute("aria-expanded", "false")
    menuAnchor = null
    if (menuClose !== null) {
      doc.removeEventListener("click", menuClose)
      menuClose = null
    }
  }

  function showRangeMenu(
    item: Element,
    chapters: readonly StoreChapter[],
    durationMs: number | null,
    episodeTitle: string,
    anchor: HTMLElement,
  ): void {
    closeMenu()
    const none = chapters
      .filter((chapter) => chapter.type === "none")
      .slice()
      .sort((a, b) => a.start - b.start)

    const el = doc.createElement("div")
    el.id = "d-op-store-range-menu"
    el.className = "d-op-store-range-menu"
    // Menu semantics (task 24): items are real buttons so the list is
    // Tab/Enter operable; Escape closes and returns focus to the trigger.
    el.setAttribute("role", "menu")
    el.setAttribute("aria-label", "スキップ区間")

    if (none.length === 0) {
      const row = doc.createElement("button")
      row.type = "button"
      row.className = "d-op-store-range-item d-op-store-range-disabled"
      row.setAttribute("role", "menuitem")
      row.textContent = "スキップ区間なし"
      row.disabled = true
      el.appendChild(row)
    } else {
      for (const [index, chapter] of none.entries()) {
        const name = guessRangeName({
          range: { start: chapter.start, end: chapter.end },
          index,
          total: none.length,
          durationMs: durationMs ?? Number.POSITIVE_INFINITY,
        })
        const row = doc.createElement("button")
        row.type = "button"
        row.className = "d-op-store-range-item"
        row.setAttribute("role", "menuitem")
        row.textContent = `${name} (${formatSec(chapter.start)}-${formatSec(chapter.end)})`
        row.addEventListener("click", (event) => {
          event.stopPropagation()
          closeMenu()
          const partId = findPartId(item)
          if (partId !== null) void playEpisode(partId, index, episodeTitle)
        })
        el.appendChild(row)
      }
    }

    ;(doc.body ?? doc.documentElement).appendChild(el)
    menu = el
    menuAnchor = anchor
    el.tabIndex = -1 // focusable fallback when the menu has no enabled items
    const rect = anchor.getBoundingClientRect()
    el.style.top = `${rect.bottom + (doc.defaultView?.scrollY ?? 0) + 4}px`
    el.style.left = `${rect.left + (doc.defaultView?.scrollX ?? 0)}px`

    el.addEventListener("click", (event) => event.stopPropagation())
    el.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        closeMenu()
        anchor.focus()
        return
      }
      // Menu keyboard contract (task 24): ↑/↓ cycle items with wrap,
      // Home/End jump to the edges, Tab dismisses like a native menu.
      const items = focusablesIn(el)
      if (event.key === "Tab") {
        closeMenu()
        return
      }
      if (items.length === 0) return
      const index = items.indexOf(doc.activeElement as HTMLElement)
      let next = -1
      if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % items.length
      else if (event.key === "ArrowUp") next = index <= 0 ? items.length - 1 : index - 1
      else if (event.key === "Home") next = 0
      else if (event.key === "End") next = items.length - 1
      else return
      event.preventDefault()
      items[next]?.focus()
    })
    menuClose = () => closeMenu()
    doc.addEventListener("click", menuClose)
    anchor.setAttribute("aria-expanded", "true")
    // Move focus into the menu so keyboard users land on the first range.
    ;(focusablesIn(el)[0] ?? el).focus()
  }

  /** Custom error modal — never native alert/confirm (styles-store.css
   *  parity: #d-op-store-modal). Task 24: real dialog semantics — labelled,
   *  Tab-trapped, and focus returns to the element that had it on open. */
  function showError(message: string): Promise<null> {
    return new Promise<null>((resolve) => {
      doc.getElementById("d-op-store-modal")?.remove()
      const focusOrigin = captureFocusOrigin(doc)
      const modal = doc.createElement("div")
      modal.id = "d-op-store-modal"
      modal.className = "d-op-store-modal"
      const panel = doc.createElement("div")
      panel.className = "d-op-store-modal-panel"
      panel.setAttribute("role", "dialog")
      panel.setAttribute("aria-modal", "true")
      panel.setAttribute("aria-labelledby", "d-op-store-modal-title")
      panel.tabIndex = -1
      const title = doc.createElement("h3")
      title.id = "d-op-store-modal-title"
      title.textContent = "エラー"
      const body = doc.createElement("p")
      body.textContent = message
      const footer = doc.createElement("div")
      footer.className = "d-op-store-modal-footer"
      const ok = doc.createElement("button")
      ok.type = "button"
      ok.textContent = "OK"
      const close = (): void => {
        modal.remove()
        doc.removeEventListener("keydown", onKey)
        resolve(null)
        restoreFocusOrigin(focusOrigin)
      }
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
          event.stopPropagation()
          close()
          return
        }
        trapTabKey(panel, event)
      }
      ok.addEventListener("click", close)
      doc.addEventListener("keydown", onKey)
      footer.appendChild(ok)
      panel.append(title, body, footer)
      modal.appendChild(panel)
      modal.addEventListener("click", (event) => {
        if (event.target === modal) close()
      })
      ;(doc.body ?? doc.documentElement).appendChild(modal)
      ok.focus()
    })
  }

  /** Decorate every undecorated .itemModule — idempotent via
   *  data-dop-decorated (content-store.js:151-191). */
  function decorate(): void {
    if (disposed) return
    for (const item of doc.querySelectorAll<HTMLElement>(".itemModule")) {
      if (item.dataset["dopDecorated"] !== undefined) continue
      const partId = findPartId(item)
      if (partId === null) continue
      const episodeTitle = findEpisodeTitle(item)

      const controls = doc.createElement("div")
      controls.className = "d-op-store-controls"
      const button = doc.createElement("button")
      button.type = "button"
      button.className = "d-op-store-btn"
      button.textContent = "OP/ED"
      button.title = "スキップ区間を選択して再生"
      button.setAttribute("aria-label", `${episodeTitle || "この話"}のスキップ区間を選択`)
      button.setAttribute("aria-haspopup", "menu")
      button.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (button.disabled) return
        const original = button.textContent
        button.disabled = true
        button.textContent = "読込"
        button.classList.add("d-op-store-btn-loading")
        void (async () => {
          try {
            const data = await deps.fetchChapters(partId)
            if (disposed) return
            if (data !== null && data.chapters.length > 0) {
              showRangeMenu(item, data.chapters, data.durationMs, episodeTitle, button)
            } else {
              // First-range fallback: open the player at dopRangeIndex=0 and
              // let the player page's own chapter flow decide
              // (content-store.js:174-179).
              await playEpisode(partId, 0, episodeTitle)
            }
          } finally {
            button.disabled = false
            button.textContent = original
            button.classList.remove("d-op-store-btn-loading")
          }
        })()
      })
      controls.appendChild(button)
      item.style.position = "relative"
      item.appendChild(controls)
      item.dataset["dopDecorated"] = "true"
    }
  }

  function scheduleDecorate(): void {
    if (disposed) return
    if (decorateTimer !== undefined) deps.cancelTimer(decorateTimer)
    decorateTimer = deps.schedule(() => {
      decorateTimer = undefined
      decorate()
    }, deps.debounceMs)
  }

  return {
    start: () => {
      decorate()
      observer = new MutationObserver(() => scheduleDecorate())
      observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true })
    },
    dispose: () => {
      disposed = true
      observer?.disconnect()
      observer = null
      if (decorateTimer !== undefined) deps.cancelTimer(decorateTimer)
      decorateTimer = undefined
      closeMenu()
      doc.getElementById("d-op-store-modal")?.remove()
      for (const item of doc.querySelectorAll<HTMLElement>(".itemModule[data-dop-decorated]")) {
        item.querySelector(".d-op-store-controls")?.remove()
        delete item.dataset["dopDecorated"]
      }
    },
  }
}

/**
 * Legacy chapter fetch: GET the player document and regex out the embedded
 * `"chapters":[…]` array + `"duration":N` (content-store.js:21-40). The regex
 * contract is deliberately unchanged — if d-Anime alters the markup the
 * caller falls back to the first-range open.
 */
export async function fetchChapterDocument(options: {
  readonly url: string
  readonly fetchImpl?: typeof fetch
}): Promise<ChapterFetchResult> {
  try {
    const fetchImpl = options.fetchImpl ?? fetch
    const response = await fetchImpl(options.url, { credentials: "same-origin" })
    if (!response.ok) return null
    const text = await response.text()
    const chapterMatch = text.match(/"chapters"\s*:\s*(\[[^\]]*\])/)
    if (chapterMatch === null || chapterMatch[1] === undefined) return null
    const parsed: unknown = JSON.parse(chapterMatch[1])
    if (!Array.isArray(parsed)) return null
    const chapters: StoreChapter[] = []
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue
      const record = entry as Record<string, unknown>
      if (typeof record["start"] !== "number" || typeof record["end"] !== "number") continue
      chapters.push({
        start: record["start"],
        end: record["end"],
        type: typeof record["type"] === "string" ? record["type"] : undefined,
      })
    }
    const durationMatch = text.match(/"duration"\s*:\s*(\d+)/)
    const durationMs =
      durationMatch?.[1] !== undefined ? Number.parseInt(durationMatch[1], 10) : null
    return { chapters, durationMs: Number.isSafeInteger(durationMs) ? durationMs : null }
  } catch {
    return null
  }
}

/** decodeHtmlEntities is re-exported for the entrypoint's title decoding. */
export { decodeHtmlEntities }
