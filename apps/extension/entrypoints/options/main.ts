import { browser } from "wxt/browser"
import { createOptionsController } from "../../src/ui/options"
import { createUiStorageClient, subscribePublicState } from "../../src/ui/storage-client"

const storage = createUiStorageClient((message) => browser.runtime.sendMessage(message))

const controller = createOptionsController({
  doc: document,
  storage,
  sendMessage: (message) => browser.runtime.sendMessage(message),
  version: browser.runtime.getManifest().version,
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
  schedule: (callback, ms) => window.setTimeout(callback, ms),
  cancelTimer: (timer) => window.clearTimeout(timer as number),
  subscribe: (listener) => subscribePublicState(browser.storage.onChanged, listener),
  log: (label, data) => console.warn("[d-op options]", label, data ?? ""),
})
controller.start()
window.addEventListener("pagehide", () => controller.dispose(), { once: true })
