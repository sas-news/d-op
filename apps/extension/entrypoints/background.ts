import {
  createBrowserStorageDriver,
  createLocalRepository,
  handleStorageMessage,
} from "../src/storage"

export default defineBackground(() => {
  const driver = createBrowserStorageDriver(browser.storage.local)
  const repository = createLocalRepository({
    driver,
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
  })
  browser.runtime.onMessage.addListener((message, sender) =>
    handleStorageMessage(message, sender, {
      repository,
      driver,
      extensionId: browser.runtime.id,
    }),
  )
})
