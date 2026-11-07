// Appearance preference shared by every extension surface. The canonical value
// lives in preferences.theme (set-preferences); this module only resolves and
// applies it to the DOM. "system" leaves the choice to prefers-color-scheme,
// with CSS media queries covering the pre-hydration paint.

import type { LocalPreferences } from "../../../../packages/shared/src/local-model"

export type ThemePreference = "system" | "light" | "dark"
export type ResolvedTheme = "light" | "dark"

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system"
export const THEME_DATA_ATTRIBUTE = "dopTheme"
const DARK_QUERY = "(prefers-color-scheme: dark)"

export function themePreferenceOf(preferences: LocalPreferences): ThemePreference {
  return preferences.theme ?? DEFAULT_THEME_PREFERENCE
}

/** Write the preference to <html data-dop-theme>; CSS owns the palette. */
export function applyThemePreference(doc: Document, preference: ThemePreference): void {
  doc.documentElement.dataset[THEME_DATA_ATTRIBUTE] = preference
}

export function prefersDark(doc: Document): boolean {
  try {
    return doc.defaultView?.matchMedia?.(DARK_QUERY)?.matches === true
  } catch {
    return false
  }
}

export function resolveTheme(doc: Document, preference: ThemePreference): ResolvedTheme {
  if (preference === "dark") return "dark"
  if (preference === "light") return "light"
  return prefersDark(doc) ? "dark" : "light"
}

/** The quick toggle always lands on an explicit theme (never back to system). */
export function nextTogglePreference(doc: Document, preference: ThemePreference): ResolvedTheme {
  return resolveTheme(doc, preference) === "dark" ? "light" : "dark"
}

const SVG_NS = "http://www.w3.org/2000/svg"

/** Moon/sun icon as inline SVG — the UI never uses emoji icons. */
function themeIcon(doc: Document, moon: boolean): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("width", "16")
  svg.setAttribute("height", "16")
  svg.setAttribute("fill", "none")
  svg.setAttribute("stroke", "currentColor")
  svg.setAttribute("stroke-width", "2")
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("focusable", "false")
  const path = doc.createElementNS(SVG_NS, "path")
  path.setAttribute(
    "d",
    moon
      ? "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"
      : "M12 2v2m0 16v2m8-10h2M2 12h2m13.66-5.66 1.42-1.42M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  )
  svg.appendChild(path)
  return svg
}

/** Reflect the current effective theme on a toggle button. */
export function syncThemeToggle(
  button: HTMLButtonElement,
  doc: Document,
  preference: ThemePreference,
): void {
  const dark = resolveTheme(doc, preference) === "dark"
  button.replaceChildren(themeIcon(doc, !dark))
  const label = dark ? "ライトモードに切り替え" : "ダークモードに切り替え"
  button.title = label
  button.setAttribute("aria-label", label)
  button.setAttribute("aria-pressed", String(dark))
}
