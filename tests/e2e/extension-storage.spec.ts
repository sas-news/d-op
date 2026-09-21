import path from "node:path"
import { chromium, expect, test } from "@playwright/test"

const EXTENSION_PATH = path.resolve("apps/extension/.output/chrome-mv3")
const LEGACY_LIBRARY = [
  {
    id: "legacy-playlist",
    name: "Legacy",
    items: [
      {
        id: "legacy-item",
        partId: "part-1",
        title: "Work",
        episodeTitle: "Episode",
        episodeNumber: "7",
        range: { start: 1_003, end: 91_007, name: "Browser OP" },
      },
    ],
  },
] as const

test("persists and replays the canonical envelope in real Chromium storage", async ({
  browserName: _browserName,
}, testInfo) => {
  // Given: the actual unpacked WXT extension and legacy browser.storage.local data.
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  })
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 10_000 }))
    await worker.evaluate(`(async () => {
      await chrome.storage.local.clear()
      await chrome.storage.local.set({
        dop_playlists: ${JSON.stringify(LEGACY_LIBRARY)},
        dop_playback: { playlistId: "legacy-playlist", index: 0, windowId: 77 },
        dop_player_window: { id: 77 },
        dop_window_mode: "tab"
      })
    })()`)

    // When: background migration and one mutation run, then the mutation acknowledgement is lost and retried.
    expect(await worker.evaluate(`chrome.runtime.onMessage.hasListeners()`)).toBe(true)
    const extensionId = new URL(worker.url()).hostname
    const extensionPage = await context.newPage()
    await extensionPage.goto(`chrome-extension://${extensionId}/manifest.json`)
    const migrated = await extensionPage.evaluate(
      `chrome.runtime.sendMessage({ type: "DOP_STORAGE_READ_PUBLIC" })`,
    )
    const command = {
      type: "DOP_STORAGE_COMMAND",
      command: {
        kind: "rename-playlist",
        operationId: "00000000-0000-4000-8000-000000000701",
        expectedRevision: 0,
        playlistId: "legacy-playlist",
        name: "Migrated",
      },
    } as const
    const changedRevision = worker.evaluate(
      `new Promise((resolve) => {
        const listener = (changes, areaName) => {
          if (areaName !== "local" || changes.dop_v2_state === undefined) return
          chrome.storage.onChanged.removeListener(listener)
          resolve(changes.dop_v2_state.newValue.revision)
        }
        chrome.storage.onChanged.addListener(listener)
      })`,
    )
    const firstResult = await extensionPage.evaluate(
      `chrome.runtime.sendMessage(${JSON.stringify(command)})`,
    )
    const first = { result: firstResult, revision: await changedRevision }
    const replay = await extensionPage.evaluate(
      `chrome.runtime.sendMessage(${JSON.stringify(command)})`,
    )
    const stored = await worker.evaluate(
      `chrome.storage.local.get(["dop_v2_state", "dop_playlists", "dop_playback", "dop_player_window", "dop_v2_transient"])`,
    )

    // Then: migration, storage-change publication, atomic receipt replay, and stale-window exclusion are observable.
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      revision: 0,
      preferences: { windowMode: "tab" },
      playlists: [{ items: [{ episodeNumber: "7", range: { start: 1_003, end: 91_007 } }] }],
    })
    expect(first).toEqual({
      result: {
        kind: "committed",
        operationId: command.command.operationId,
        revision: 1,
      },
      revision: 1,
    })
    expect(replay).toEqual(first.result)
    expect(stored).toMatchObject({
      dop_playlists: LEGACY_LIBRARY,
      dop_playback: { windowId: 77 },
      dop_player_window: { id: 77 },
      dop_v2_state: {
        schemaVersion: 2,
        revision: 1,
        playlists: [{ name: "Migrated" }],
        appliedOperations: [{ operationId: command.command.operationId, resultingRevision: 1 }],
      },
    })
    expect(stored).not.toHaveProperty("dop_v2_transient")
  } finally {
    await context.close()
  }
})
