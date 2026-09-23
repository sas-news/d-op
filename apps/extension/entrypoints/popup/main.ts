import { browser } from "wxt/browser"
import { shareSiteUrl } from "../../src/share/origins"
import { createPopupController } from "../../src/ui/popup"
import {
  createUiStorageClient,
  subscribePublicState,
  subscribeTransientState,
} from "../../src/ui/storage-client"

// Dev builds resolve share-site links (explore/privacy) to the local server.
for (const a of document.querySelectorAll<HTMLAnchorElement>("a[data-share-site]")) {
  const path = a.dataset["shareSite"]
  if (path !== undefined) a.href = shareSiteUrl(path as `/${string}`)
}

const storage = createUiStorageClient((message) => browser.runtime.sendMessage(message))

const controller = createPopupController({
  doc: document,
  storage,
  sendMessage: (message) => browser.runtime.sendMessage(message),
  openOptionsPage: () => void browser.runtime.openOptionsPage(),
  version: browser.runtime.getManifest().version,
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
  random: () => Math.random(),
  // Both canonical and transient writes re-render — the popup shows
  // now-playing state plus playlist contents (popup.js:364-368 parity,
  // widened to public changes since playlists render too).
  subscribe: (listener) => {
    const a = subscribePublicState(browser.storage.onChanged, listener)
    const b = subscribeTransientState(browser.storage.onChanged, listener)
    return () => {
      a()
      b()
    }
  },
  log: (label, data) => console.warn("[d-op popup]", label, data ?? ""),
})
controller.start()
window.addEventListener("pagehide", () => controller.dispose(), { once: true })
