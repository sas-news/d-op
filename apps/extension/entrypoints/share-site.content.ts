import { defineContentScript } from "wxt/utils/define-content-script"
import { shareContentScriptMatches } from "../src/share/origins"
import { installShareRelay } from "../src/share/relay"

// Task-17 share-site relay. Same entrypoint ships to Chrome AND Firefox MV3 —
// no externally_connectable. `matches` is production-only
// (https://d-op.sasnews.dev/p/*); localhost is appended by
// shareContentScriptMatches() only in non-production builds.
export default defineContentScript({
  matches: shareContentScriptMatches(),
  runAt: "document_start",
  main() {
    // Advertise presence before page scripts can act (document_start). The
    // marker is the ONLY thing the page reads — it learns nothing else.
    const mark = (): boolean => {
      if (document.documentElement === null) return false
      document.documentElement.setAttribute("data-dop-extension", "installed")
      return true
    }
    if (!mark()) {
      const observer = new MutationObserver(() => {
        if (mark()) observer.disconnect()
      })
      observer.observe(document, { childList: true, subtree: true })
      document.addEventListener("DOMContentLoaded", () => observer.disconnect(), { once: true })
    }

    installShareRelay(window, {
      forward: (request) =>
        browser.runtime.sendMessage({
          kind: "share-import-request",
          shareId: request.shareId,
          requestId: request.requestId,
        }),
    })
  },
})
