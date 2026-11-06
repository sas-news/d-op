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

/** Reflect the current effective theme on a toggle button. */
export function syncThemeToggle(
  button: HTMLButtonElement,
  doc: Document,
  preference: ThemePreference,
): void {
  const dark = resolveTheme(doc, preference) === "dark"
  button.textContent = dark ? "☀" : "🌙"
  const label = dark ? "ライトモードに切り替え" : "ダークモードに切り替え"
  button.title = label
  button.setAttribute("aria-label", label)
  button.setAttribute("aria-pressed", String(dark))
}
