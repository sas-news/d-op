// Task-23 real-browser retarget hook for the extension e2e suite.
//
// Default (unset env) behaviour is IDENTICAL to before: every launch uses the
// bundled Playwright Chromium via `channel: "chromium"`. Setting
// DOP_BROWSER_EXECUTABLE to an absolute browser binary path (real Google
// Chrome / Chrome for Testing — never the bundled chromium) retargets every
// launchPersistentContext/launch call at that binary; `executablePath` and
// `channel` are mutually exclusive in Playwright, so the helper returns one
// or the other. DOP_BROWSER_LABEL is a free-form evidence tag only.
export function browserLaunchTarget(): { channel: "chromium" } | { executablePath: string } {
  const executablePath = process.env["DOP_BROWSER_EXECUTABLE"]?.trim()
  if (executablePath === undefined || executablePath === "") return { channel: "chromium" }
  return { executablePath }
}

/** Evidence label for the run: executable basename or "chromium (bundled)". */
export function browserLaunchLabel(): string {
  const executablePath = process.env["DOP_BROWSER_EXECUTABLE"]?.trim()
  return executablePath === undefined || executablePath === ""
    ? "chromium (bundled)"
    : executablePath
}
