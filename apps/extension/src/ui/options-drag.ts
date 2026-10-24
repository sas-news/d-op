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
  /** Selected block being moved together (DOM order); defaults to [row]. */
  readonly blockRows?: readonly HTMLElement[]
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

/** Clone the row(s) being dragged. A multi-row selection becomes one floating
 *  block so the whole selected run visibly follows the cursor. */
export function createDragClone(
  doc: Document,
  rows: readonly HTMLElement[],
  rect: { readonly width: number; readonly left: number; readonly top: number },
): HTMLElement {
  let clone: HTMLElement
  if (rows.length <= 1) {
    clone = (rows[0] ?? doc.createElement("div")).cloneNode(true) as HTMLElement
    clone.classList.add("drag-clone")
  } else {
    clone = doc.createElement("div")
    clone.className = "drag-clone drag-clone-block"
    for (const row of rows) {
      const rowClone = row.cloneNode(true) as HTMLElement
      rowClone.classList.remove("dragging")
      clone.appendChild(rowClone)
    }
  }
  clone.style.width = `${rect.width}px`
  clone.style.left = `${rect.left}px`
  clone.style.top = `${rect.top}px`
  return clone
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
  function flipAnimate(listEl: HTMLElement, skipRows: readonly HTMLElement[]): () => void {
    if (prefersReducedMotion(listEl)) return () => {}
    const firsts = new Map<string, number>()
    for (const row of listEl.querySelectorAll<HTMLElement>(".item-row")) {
      const id = row.dataset["itemId"]
      if (id !== undefined) firsts.set(id, row.getBoundingClientRect().top)
    }
    return () => {
      for (const row of listEl.querySelectorAll<HTMLElement>(".item-row")) {
        if (skipRows.includes(row)) continue
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
    const block = state.blockRows ?? [state.row]
    const blockSet = new Set(block)
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
      if (blockSet.has(row)) continue
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
    const play = flipAnimate(itemsList, block)
    if (event.clientY < mid) {
      // Inserting each row before the same target preserves block order.
      for (const row of block) itemsList.insertBefore(row, target)
    } else {
      // Anchor after `target`, skipping over block rows that may sit next to it
      // so the block is inserted as one contiguous run.
      let ref: Node | null = target.nextSibling
      while (ref instanceof HTMLElement && blockSet.has(ref)) ref = ref.nextSibling
      for (const row of block) {
        if (ref === null) itemsList.appendChild(row)
        else itemsList.insertBefore(row, ref)
      }
    }
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
    for (const row of state.blockRows ?? [state.row]) row.classList.remove("dragging")
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
      for (const row of dragState.blockRows ?? [dragState.row]) row.classList.remove("dragging")
      dragState = null
    },
    moveByKey: (row, delta) => {
      const listEl = row.parentElement
      if (listEl === null || !listEl.classList.contains("items-list")) return false
      const playlistId = (listEl as HTMLElement).dataset["playlistId"]
      if (playlistId === undefined) return false
      const rows = [...listEl.querySelectorAll<HTMLElement>(".item-row")]
      // A checked row drags its whole checked block (same playlist only);
      // otherwise ↑/↓ keeps the single-row behaviour.
      const rowCheckbox = row.querySelector<HTMLInputElement>(".item-select")
      const block =
        rowCheckbox?.checked === true
          ? rows.filter(
              (candidate) => candidate.querySelector<HTMLInputElement>(".item-select")?.checked,
            )
          : [row]
      const first = block[0] ?? row
      const last = block[block.length - 1] ?? row
      if (delta === -1) {
        const previous = first.previousElementSibling
        if (previous === null || !previous.classList.contains("item-row")) return false
        for (const blockRow of block) listEl.insertBefore(blockRow, previous)
      } else {
        const next = last.nextElementSibling
        if (next === null || !next.classList.contains("item-row")) return false
        const ref = next.nextElementSibling
        for (const blockRow of block) {
          if (ref === null) listEl.appendChild(blockRow)
          else listEl.insertBefore(blockRow, ref)
        }
      }
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
