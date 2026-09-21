import { BackgroundRequestSchema, StorageRequestSchema } from "../../../packages/shared/src/index"
import { createPlayerWindowManager, dispatchLifecycleRequest } from "../src/player/window-manager"
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

  // Single message router: storage envelopes go to the repository (the only
  // persistent writer); lifecycle envelopes go to the window manager. Anything
  // else returns undefined so other listeners are not broken.
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (StorageRequestSchema.safeParse(message).success) {
      return handleStorageMessage(message, sender, {
        repository,
        driver,
        extensionId: browser.runtime.id,
      })
    }
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
