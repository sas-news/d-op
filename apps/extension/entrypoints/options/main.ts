import { browser } from "wxt/browser"
import { shareSiteUrl } from "../../src/share/origins"
import { createOptionsController } from "../../src/ui/options"
import { createUiStorageClient, subscribePublicState } from "../../src/ui/storage-client"

// Dev builds resolve share-site links (explore/privacy/…) to the local server.
for (const a of document.querySelectorAll<HTMLAnchorElement>("a[data-share-site]")) {
  const path = a.dataset["shareSite"]
  if (path !== undefined) a.href = shareSiteUrl(path as `/${string}`)
}

const storage = createUiStorageClient((message) => browser.runtime.sendMessage(message))

const controller = createOptionsController({
  doc: document,
  storage,
  sendMessage: (message) => browser.runtime.sendMessage(message),
  version: browser.runtime.getManifest().version,
  // Task 22: Firefox ≥140 native data-consent prompt surface. Chrome/older
  // Firefox return a getAll() without `data_collection` — the in-extension
  // decision alone then gates Share traffic.
  dataPermissions: {
    getAll: () =>
      browser.permissions.getAll() as Promise<{
        data_collection?: readonly string[]
      }>,
    request: (permissions: { readonly data_collection: readonly string[] }) =>
      browser.permissions.request(permissions as Parameters<typeof browser.permissions.request>[0]),
  },
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
  schedule: (callback, ms) => window.setTimeout(callback, ms),
  cancelTimer: (timer) => window.clearTimeout(timer as number),
  subscribe: (listener) => subscribePublicState(browser.storage.onChanged, listener),
  copyText: (text) =>
    navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    ),
  log: (label, data) => console.warn("[d-op options]", label, data ?? ""),
})
controller.start()
window.addEventListener("pagehide", () => controller.dispose(), { once: true })
