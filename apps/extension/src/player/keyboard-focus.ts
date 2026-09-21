// Keyboard focus guard — ports content.js:1533-1549. While an editable
// element (input/textarea/select/contenteditable) is focused, every keydown
// is stopPropagation'ed in the capture phase so the d-Anime player's own
// keyboard shortcuts (space/arrows) never fire while the user types a time
// or playlist name. focusout defers via a 0ms task because activeElement is
// still the old element during the blur turn.

export function isEditableElement(el: EventTarget | null): boolean {
  if (el === null || !(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  // Browsers expose isContentEditable; where it is missing (jsdom) fall back
  // to the attribute so the guard still works.
  if (el.isContentEditable === true) return true
  const attr = el.getAttribute("contenteditable")
  return attr !== null && attr !== "false"
}

/** Installs the guard; returns a disposer that removes all listeners. */
export function installKeyboardFocusGuard(doc: Document): () => void {
  let inputFocused = false

  const onFocusIn = (event: Event): void => {
    inputFocused = isEditableElement(event.target)
  }
  const onFocusOut = (): void => {
    // Legacy setTimeout(0): activeElement updates after the focusout turn.
    setTimeout(() => {
      inputFocused = isEditableElement(doc.activeElement)
    }, 0)
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!inputFocused) return
    event.stopPropagation()
    event.stopImmediatePropagation()
  }

  doc.addEventListener("focusin", onFocusIn)
  doc.addEventListener("focusout", onFocusOut)
  doc.addEventListener("keydown", onKeyDown, true)

  return () => {
    doc.removeEventListener("focusin", onFocusIn)
    doc.removeEventListener("focusout", onFocusOut)
    doc.removeEventListener("keydown", onKeyDown, true)
  }
}
