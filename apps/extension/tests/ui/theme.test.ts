// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import {
  applyThemePreference,
  nextTogglePreference,
  resolveTheme,
  themePreferenceOf,
} from "../../src/ui/theme"

const originalMatchMedia = window.matchMedia

function stubPrefersDark(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) =>
      ({
        matches: query.includes("dark") ? matches : false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  })
}

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: originalMatchMedia,
  })
  delete document.documentElement.dataset["dopTheme"]
})

describe("ui/theme", () => {
  it("defaults missing preferences to system and writes the data attribute", () => {
    expect(themePreferenceOf({ windowMode: "window", collapsedPlaylists: {} })).toBe("system")
    applyThemePreference(document, "dark")
    expect(document.documentElement.dataset["dopTheme"]).toBe("dark")
  })

  it("resolves system from prefers-color-scheme and toggles to an explicit theme", () => {
    stubPrefersDark(true)
    expect(resolveTheme(document, "system")).toBe("dark")
    expect(nextTogglePreference(document, "system")).toBe("light")
    stubPrefersDark(false)
    expect(resolveTheme(document, "system")).toBe("light")
    expect(nextTogglePreference(document, "light")).toBe("dark")
  })
})
