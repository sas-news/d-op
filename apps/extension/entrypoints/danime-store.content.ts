import { defineContentScript } from "wxt/utils/define-content-script"
import "../src/ui/store.css"
import { PLAYBACK_URL_PATH } from "../../../packages/shared/src/limits"
import { STORE_DEBOUNCE_MS } from "../src/player/constants"
import { createStorePage, fetchChapterDocument } from "../src/ui/store-page"

export default defineContentScript({
  matches: [
    "https://animestore.docomo.ne.jp/animestore/*",
    "https://anime.dmkt-sp.jp/animestore/*",
  ],
  excludeMatches: [
    "https://animestore.docomo.ne.jp/animestore/sc_d_pc*",
    "https://anime.dmkt-sp.jp/animestore/sc_d_pc*",
  ],
  runAt: "document_idle",
  main() {
    // Belt + suspenders: the data attribute survives SPA soft-reloads where
    // the module itself may re-evaluate (legacy __dOpStoreInitialized flag).
    if (document.documentElement.hasAttribute("data-dop-store-init")) return
    document.documentElement.setAttribute("data-dop-store-init", "1")

    const page = createStorePage(document, {
      origin: () => window.location.origin,
      // v2 uses location.origin (not the hardcoded docomo host) so both
      // supported origins resolve their own player document.
      fetchChapters: (partId) =>
        fetchChapterDocument({
          url: `${window.location.origin}${PLAYBACK_URL_PATH}?partId=${encodeURIComponent(partId)}`,
        }),
      requestPlayer: (url) => browser.runtime.sendMessage({ kind: "REQUEST_PLAYER", url }),
      schedule: (callback, ms) => window.setTimeout(callback, ms),
      cancelTimer: (timer) => window.clearTimeout(timer as number),
      debounceMs: STORE_DEBOUNCE_MS,
      log: (label, data) => console.warn("[d-op store]", label, data ?? ""),
    })
    page.start()
    window.addEventListener("pagehide", () => page.dispose(), { once: true })
  },
})
