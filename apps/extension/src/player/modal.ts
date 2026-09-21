// Custom modal host — ports showModal (content.js:1067-1115). No browser
// alert/confirm/prompt ever: a single #d-op-modal element replaced per call,
// Escape resolves null, backdrop click resolves null (unless disabled),
// button click resolves the button value. Rich bodies (bodyNode), disabled
// buttons and onReady wiring cover the playlist-picker/confirm variants.
//
// Accessibility contract (task 24): Tab/Shift+Tab cycle inside the panel so
// focus never escapes to the page behind the modal, and closing restores
// focus to the element that was active when the modal opened. A titled dialog
// names itself via aria-labelledby; untitled dialogs fall back to an
// aria-label built from the body text.
import { captureFocusOrigin, focusablesIn, restoreFocusOrigin, trapTabKey } from "./focus-trap"
import type { ModalRequest } from "./runtime"

export type ModalHost = {
  readonly show: (request: ModalRequest) => Promise<string | null>
  readonly dispose: () => void
}

const MODAL_ID = "d-op-modal"
const TITLE_ID = "d-op-modal-title"

export function createModalHost(doc: Document): ModalHost {
  let pending: ((value: string | null) => void) | undefined
  let keyListener: ((event: KeyboardEvent) => void) | undefined
  // Element focused before the current modal chain opened — restored on close.
  // Replacing one modal with another keeps the original outside element.
  let focusOrigin: HTMLElement | null = null

  const close = (value: string | null, restoreFocus = true): void => {
    doc.getElementById(MODAL_ID)?.remove()
    if (keyListener !== undefined) {
      doc.removeEventListener("keydown", keyListener, true)
      keyListener = undefined
    }
    const resolve = pending
    pending = undefined
    resolve?.(value)
    if (restoreFocus) {
      const origin = focusOrigin
      focusOrigin = null
      restoreFocusOrigin(origin)
    }
  }

  const show = (request: ModalRequest): Promise<string | null> => {
    // Capture the outside focus origin only when no modal is open — chained
    // dialogs (picker -> confirm) keep pointing at the original trigger.
    if (doc.getElementById(MODAL_ID) === null) focusOrigin = captureFocusOrigin(doc)
    close(null, false) // legacy replaces any open modal (content.js:1075)
    return new Promise<string | null>((resolve) => {
      pending = resolve
      const modal = doc.createElement("div")
      modal.id = MODAL_ID
      modal.className = "d-op-modal"

      const panel = doc.createElement("div")
      panel.className = "d-op-modal-panel"
      panel.setAttribute("role", "dialog")
      panel.setAttribute("aria-modal", "true")
      // Needed so the panel itself can take focus when a dialog has no
      // focusable controls (defensive — every shipped dialog has buttons).
      panel.tabIndex = -1

      if (request.title.length > 0) {
        const header = doc.createElement("h3")
        header.id = TITLE_ID
        header.textContent = request.title
        panel.appendChild(header)
        panel.setAttribute("aria-labelledby", TITLE_ID)
      } else {
        // Untitled dialogs (plain confirms/alerts) still need an accessible
        // name — the first body line describes the prompt best.
        const firstLine = request.body.split("\n", 1)[0]?.trim() ?? ""
        panel.setAttribute("aria-label", firstLine.length > 0 ? firstLine.slice(0, 80) : "確認")
      }

      if (request.body.length > 0) {
        const body = doc.createElement("div")
        body.className = "d-op-modal-body"
        body.textContent = request.body
        panel.appendChild(body)
      }
      if (request.bodyNode !== undefined) {
        const body = doc.createElement("div")
        body.className = "d-op-modal-body"
        body.appendChild(request.bodyNode)
        panel.appendChild(body)
      }

      const footer = doc.createElement("div")
      footer.className = "d-op-modal-footer"
      let primary: HTMLButtonElement | undefined
      for (const spec of request.buttons) {
        const button = doc.createElement("button")
        button.type = "button"
        button.textContent = spec.label
        button.value = spec.value
        if (spec.primary === true) {
          button.className = "primary"
          primary = button
        }
        if (spec.disabled === true) button.disabled = true
        button.addEventListener("click", () => close(spec.value))
        footer.appendChild(button)
      }
      panel.appendChild(footer)
      modal.appendChild(panel)
      ;(doc.body ?? doc.documentElement).appendChild(modal)

      if (request.cancelOnBackdrop !== false) {
        modal.addEventListener("mousedown", (event) => {
          if (event.target === modal) close(null)
        })
      }

      keyListener = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
          event.stopPropagation()
          close(null)
          return
        }
        trapTabKey(panel, event)
      }
      doc.addEventListener("keydown", keyListener, true)
      request.onReady?.({ root: modal, panel, close })
      const target = primary ?? focusablesIn(panel)[0] ?? panel
      target.focus()
    })
  }

  return { show, dispose: () => close(null) }
}
