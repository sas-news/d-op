import type { BrowserContext, Page } from "@playwright/test"

// Task-23: `context.waitForEvent("page", { predicate: url })` is racy on real
// Chrome binaries — the event can fire before the target's URL commits, so a
// URL predicate evaluated at event time permanently misses the page (bundled
// headless-shell chromium commits earlier, which is why it passes there).
// Polling context.pages() instead is immune to that ordering and behaves
// identically on bundled chromium, Chrome for Testing and Firefox channels.
export async function waitForContextPage(
  context: BrowserContext,
  urlPrefix: string,
  timeoutMs = 15_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = context.pages().find((page) => page.url().startsWith(urlPrefix))
    if (found !== undefined) return found
    if (Date.now() > deadline) {
      const open = context
        .pages()
        .map((page) => page.url())
        .join(", ")
      throw new Error(`timed out waiting for page ${urlPrefix}; open pages: ${open}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
