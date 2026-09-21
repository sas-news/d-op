// Drag reorder for the options page — ports options.js:277-390. FLIP
// transform animation on move, ghost clone follows the cursor, and mouseup
// persists the DOM order via replace-library. Document-level listeners are
// attached ONCE by the controller (the legacy per-render listener
// accumulation is a known leak we do not port).

import type { LocalItem } from "../../../../packages/shared/src/local-model"
import type { OptionsDeps } from "./options"
import { runMutation } from "./storage-client"

export type DragState = {
  readonly row: HTMLElement
  readonly clone: HTMLElement
  readonly itemsList: HTMLElement
  readonly playlistId: string
  readonly offsetY: number
}

export type DragDeps = Pick<OptionsDeps, "storage" | "newId" | "schedule" | "log">

export type DragController = {
  /** Called from a list's mousedown handler once the grip/row are resolved. */
  readonly begin: (state: DragState) => void
  readonly onMouseMove: (event: MouseEvent) => void
  readonly onMouseUp: () => void
  /** Abandon an in-flight drag (dispose path): drop the clone + row state. */
  readonly cancel: () => void
  /**
   * Keyboard alternative to drag (task 24): moves `row` one step inside its
   * list and persists the resulting order through the same revision-checked
   * replace-library path as a mouse drop. Returns false on a no-op (list
   * edge or missing list context) so callers can leave focus alone.
   */
  readonly moveByKey: (row: HTMLElement, delta: -1 | 1) => boolean
}

/** Reduced-motion check routed through the row's own window — the options
 *  page has no injected matchMedia dep and jsdom may lack the API. */
function prefersReducedMotion(element: HTMLElement): boolean {
  try {
    return (
      element.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")
        ?.matches === true
    )
  } catch {
    return false
  }
}

export function createDragController(deps: DragDeps): DragController {
  let dragState: DragState | null = null

  /** flipAnimate (options.js:277-298) — FLIP transform on reorder. Skipped
   *  under prefers-reduced-motion (no-op animator keeps call sites intact). */
  function flipAnimate(listEl: HTMLElement, skipRow: HTMLElement): () => void {
    if (prefersReducedMotion(listEl)) return () => {}
    const firsts = new Map<string, number>()
    for (const row of listEl.querySelectorAll<HTMLElement>(".item-row")) {
      const id = row.dataset["itemId"]
      if (id !== undefined) firsts.set(id, row.getBoundingClientRect().top)
    }
    return () => {
      for (const row of listEl.querySelectorAll<HTMLElement>(".item-row")) {
        if (row === skipRow) continue
        const prev = firsts.get(row.dataset["itemId"] ?? "")
        if (prev === undefined) continue
        const diff = prev - row.getBoundingClientRect().top
        if (Math.abs(diff) > 0.5) {
          row.style.transform = `translateY(${diff}px)`
          row.style.transition = "none"
          void row.offsetHeight
          row.style.transition = "transform 120ms ease-out"
          row.style.transform = ""
        }
      }
    }
  }

  function onMouseMove(event: MouseEvent): void {
    const state = dragState
    if (state === null) return
    const itemsList = state.itemsList
    const listRect = itemsList.getBoundingClientRect()
    const rowH = state.row.getBoundingClientRect().height
    const minY = listRect.top
    const maxY = listRect.bottom - rowH
    const clampedY = Math.max(minY, Math.min(maxY, event.clientY - state.offsetY))
    state.clone.style.left = `${state.row.getBoundingClientRect().left}px`
    state.clone.style.top = `${clampedY}px`

    const rows = [...itemsList.querySelectorAll<HTMLElement>(".item-row")]
    let target: HTMLElement | null = null
    let minDist = Number.POSITIVE_INFINITY
    for (const row of rows) {
      if (row === state.row) continue
      const mid = row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2
      const d = Math.abs(event.clientY - mid)
      if (d < minDist) {
        minDist = d
        target = row
      }
    }
    if (target === null) return
    const rect = target.getBoundingClientRect()
    const mid = rect.top + rect.height / 2
    const play = flipAnimate(itemsList, state.row)
    if (event.clientY < mid) itemsList.insertBefore(state.row, target)
    else itemsList.insertBefore(state.row, target.nextSibling)
    play()
  }

  function onMouseUp(): void {
    const state = dragState
    if (state === null) return
    dragState = null
    if (prefersReducedMotion(state.clone)) {
      // No fade transition under reduced motion — remove the clone at once so
      // no orphan survives when transitionend can never fire.
      state.clone.remove()
    } else {
      const finalRect = state.row.getBoundingClientRect()
      state.clone.style.transition =
        "left 150ms ease-out, top 150ms ease-out, opacity 150ms ease-out"
      state.clone.style.left = `${finalRect.left}px`
      state.clone.style.top = `${finalRect.top}px`
      state.clone.style.opacity = "0"
      state.clone.addEventListener(
        "transitionend",
        () => {
          state.clone.parentNode?.removeChild(state.clone)
        },
        { once: true },
      )
      // jsdom never fires transitionend — also clear via timer so no orphan
      // clone survives when the animation cannot run.
      deps.schedule(() => state.clone.remove(), 400)
    }
    state.row.classList.remove("dragging")
    for (const row of state.itemsList.querySelectorAll<HTMLElement>(".item-row")) {
      row.style.transition = ""
      row.style.transform = ""
    }
    const newOrder = [...state.itemsList.querySelectorAll<HTMLElement>(".item-row")]
      .map((row) => row.dataset["itemId"])
      .filter((id): id is string => id !== undefined)
    void persistReorder(state.playlistId, newOrder)
  }

  async function persistReorder(playlistId: string, newOrder: readonly string[]): Promise<void> {
    const reply = await runMutation(
      deps.storage,
      (fresh) => {
        const playlist = fresh.playlists.find((candidate) => candidate.id === playlistId)
        if (playlist === undefined || playlist.items.length !== newOrder.length) return null
        // Build the reordered playlist directly — same end state the legacy
        // `pl.items = ordered` write produced (options.js:386-390).
        const ordered = newOrder
          .map((id) => playlist.items.find((item) => item.id === id))
          .filter((item): item is LocalItem => item !== undefined)
        if (ordered.length !== playlist.items.length) return null
        const mutated = fresh.playlists.map((candidate) =>
          candidate.id === playlistId ? { ...candidate, items: ordered } : candidate,
        )
        return { kind: "replace-library", playlists: [...mutated] }
      },
      deps.newId,
    )
    if (reply.kind !== "committed") deps.log?.("reorder-failed", reply)
  }

  return {
    begin: (state) => {
      dragState = state
    },
    onMouseMove,
    onMouseUp,
    cancel: () => {
      if (dragState === null) return
      dragState.clone.remove()
      dragState.row.classList.remove("dragging")
      dragState = null
    },
    moveByKey: (row, delta) => {
      const listEl = row.parentElement
      if (listEl === null || !listEl.classList.contains("items-list")) return false
      const playlistId = (listEl as HTMLElement).dataset["playlistId"]
      if (playlistId === undefined) return false
      const sibling = delta === -1 ? row.previousElementSibling : row.nextElementSibling
      if (sibling === null || !sibling.classList.contains("item-row")) return false
      if (delta === -1) listEl.insertBefore(row, sibling)
      else listEl.insertBefore(row, sibling.nextElementSibling)
      // insertBefore runs remove+insert, which unfocuses the moved row's
      // control — re-focus it so repeated Arrow presses keep working until
      // the commit-driven re-render takes over (task 24).
      const doc = row.ownerDocument
      if (doc.activeElement === doc.body || doc.activeElement === null) {
        row.querySelector<HTMLElement>(".drag-grip")?.focus()
      }
      const newOrder = [...listEl.querySelectorAll<HTMLElement>(".item-row")]
        .map((candidate) => candidate.dataset["itemId"])
        .filter((id): id is string => id !== undefined)
      void persistReorder(playlistId, newOrder)
      return true
    },
  }
}
