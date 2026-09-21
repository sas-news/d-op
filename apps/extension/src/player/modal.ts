// Custom modal host — ports showModal (content.js:1067-1115). No browser
// alert/confirm/prompt ever: a single #d-op-modal element replaced per call,
// Escape resolves null, backdrop click resolves null (unless disabled),
// button click resolves the button value. Rich bodies (bodyNode), disabled
// buttons and onReady wiring cover the playlist-picker/confirm variants.
import type { ModalRequest } from "./runtime"

export type ModalHost = {
  readonly show: (request: ModalRequest) => Promise<string | null>
  readonly dispose: () => void
}

const MODAL_ID = "d-op-modal"

export function createModalHost(doc: Document): ModalHost {
  let pending: ((value: string | null) => void) | undefined
  let keyListener: ((event: KeyboardEvent) => void) | undefined

  const close = (value: string | null): void => {
    doc.getElementById(MODAL_ID)?.remove()
    if (keyListener !== undefined) {
      doc.removeEventListener("keydown", keyListener, true)
      keyListener = undefined
    }
    const resolve = pending
    pending = undefined
    resolve?.(value)
  }

  const show = (request: ModalRequest): Promise<string | null> => {
    close(null) // legacy replaces any open modal (content.js:1075)
    return new Promise<string | null>((resolve) => {
      pending = resolve
      const modal = doc.createElement("div")
      modal.id = MODAL_ID
      modal.className = "d-op-modal"

      const panel = doc.createElement("div")
      panel.className = "d-op-modal-panel"
      panel.setAttribute("role", "dialog")
      panel.setAttribute("aria-modal", "true")

      if (request.title.length > 0) {
        const header = doc.createElement("h3")
        header.textContent = request.title
        panel.appendChild(header)
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
        }
      }
      doc.addEventListener("keydown", keyListener, true)
      request.onReady?.({ root: modal, panel, close })
      primary?.focus()
    })
  }

  return { show, dispose: () => close(null) }
}
