// Shared modal focus management for the generated d-OP overlays (player modal
// host, store-page status modal). A modal traps Tab/Shift+Tab inside its own
// subtree and returns focus to the element that opened it so keyboard users
// never lose their place when a dialog replaces the page context.
//
// Focusable lookup uses the plain selector approach (no visibility walk) —
// the generated dialogs never keep hidden-but-mounted controls around, and
// offsetParent checks would break under jsdom in unit tests.

export const FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
  "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"

/** Focusable descendants of `container` in DOM order. */
export function focusablesIn(container: HTMLElement): readonly HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled") && !el.hasAttribute("hidden"),
  )
}

/**
 * Redirects Tab/Shift+Tab so focus cycles inside `container`. Call from a
 * capture-phase keydown listener; Escape handling stays with the caller.
 * Returns true when the event was consumed (focus redirected or no focusable
 * target exists).
 */
export function trapTabKey(container: HTMLElement, event: KeyboardEvent): boolean {
  if (event.key !== "Tab") return false
  const doc = container.ownerDocument
  const focusables = focusablesIn(container)
  const active = doc.activeElement
  const inside = active instanceof HTMLElement && container.contains(active)
  if (focusables.length === 0) {
    event.preventDefault()
    event.stopPropagation()
    return true
  }
  const first = focusables[0] as HTMLElement
  const last = focusables[focusables.length - 1] as HTMLElement
  const redirect = !inside || (event.shiftKey ? active === first : active === last)
  if (!redirect) return false
  event.preventDefault()
  event.stopPropagation()
  // Shift+Tab from the first control wraps to the last; every other redirect
  // (Tab on last, or focus that somehow ended up outside) lands on first.
  const target = event.shiftKey && inside ? last : first
  target.focus()
  return true
}

/**
 * Records the element that should regain focus when a dialog closes. Safe to
 * call with any active element — non-HTMLElements (e.g. SVG nodes) become null.
 */
export function captureFocusOrigin(doc: Document): HTMLElement | null {
  const active = doc.activeElement
  return active instanceof HTMLElement && active !== doc.body && active !== doc.documentElement
    ? active
    : null
}

/**
 * Restores focus to a previously captured origin if it is still mounted and
 * focusable. No-op when the element was removed while the dialog was open.
 */
export function restoreFocusOrigin(origin: HTMLElement | null): void {
  if (origin === null || !origin.isConnected) return
  if (origin.hasAttribute("disabled") || origin.getAttribute("aria-hidden") === "true") return
  try {
    origin.focus()
  } catch {
    // Non-focusable element (e.g. a plain div) — nothing to restore to.
  }
}
