import { BackgroundRequestSchema, StorageRequestSchema } from "../../../packages/shared/src/index"
import { createPlayerWindowManager, dispatchLifecycleRequest } from "../src/player/window-manager"
import { createShareImportHandler, type ShareImportSender } from "../src/share/import-handler"
import {
  createBrowserStorageDriver,
  createLocalRepository,
  handleStorageMessage,
} from "../src/storage"
import { readTransientState, writeTransientState } from "../src/storage/transient"

export default defineBackground(() => {
  const driver = createBrowserStorageDriver(browser.storage.local)
  const repository = createLocalRepository({
    driver,
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
  })
  const windows = createPlayerWindowManager({
    tabs: {
      get: (tabId) => browser.tabs.get(tabId),
      query: (query) => browser.tabs.query(query),
      update: (tabId, props) => browser.tabs.update(tabId, props),
      create: (props) => browser.tabs.create(props),
      remove: (tabId) => browser.tabs.remove(tabId),
      sendMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
    },
    windows: {
      get: (windowId) => browser.windows.get(windowId),
      create: (props) => browser.windows.create(props),
    },
    readTransient: () => readTransientState(driver),
    writeTransient: (state) => writeTransientState(driver, state),
    windowMode: async () => (await repository.readPublic()).preferences.windowMode,
    newOwnerToken: () => crypto.randomUUID(),
  })

  // Share import (task 17): the share-site content-script relay forwards only
  // {shareId, requestId}; this handler re-validates sender origin/frame/tab,
  // debounces repeats, opens the extension-owned confirmation window, fetches
  // the fixed API origin itself, and commits fresh local ids on confirm.
  const shareImport = createShareImportHandler({
    repository,
    driver,
    extensionId: browser.runtime.id,
    extensionOrigin: new URL(browser.runtime.getURL("/")).origin,
    openConfirmation: async (token) => {
      const url = browser.runtime.getURL(`/import.html?t=${token}`)
      try {
        await browser.windows.create({ url, type: "popup", width: 480, height: 620 })
      } catch {
        // Popup windows are unsupported on some surfaces — fall back to a tab.
        await browser.tabs.create({ url, active: true })
      }
    },
  })

  // Single message router: storage envelopes go to the repository (the only
  // persistent writer); share-import envelopes go to the import handler;
  // lifecycle envelopes go to the window manager. Anything else returns
  // undefined so other listeners are not broken.
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (StorageRequestSchema.safeParse(message).success) {
      return handleStorageMessage(message, sender, {
        repository,
        driver,
        extensionId: browser.runtime.id,
      })
    }
    const importReply = shareImport(message, sender as ShareImportSender)
    if (importReply !== undefined) return importReply
    const lifecycle = BackgroundRequestSchema.safeParse(message)
    if (lifecycle.success) return dispatchLifecycleRequest(lifecycle.data, windows)
    return undefined
  })

  browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
    void windows.onTabRemoved(tabId, removeInfo.isWindowClosing)
  })
  browser.windows.onRemoved.addListener((windowId) => {
    void windows.onWindowRemoved(windowId)
  })

  // Service-worker restart: rebuild the player singleton from the transient
  // envelope — never from legacy dop_playback/dop_player_window keys.
  void windows.recover()
})
