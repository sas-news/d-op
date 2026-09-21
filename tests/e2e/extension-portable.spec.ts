import fs from "node:fs"
import path from "node:path"
import {
  type BrowserContext,
  chromium,
  expect,
  type TestInfo,
  test,
  type Worker,
} from "@playwright/test"

// Task-11 portable-data + management-detach acceptance against the real
// unpacked WXT build (chrome-mv3). Modelled on extension-parity.spec.ts:
// synthetic fixtures via route interception, real service worker, real
// options page. No live d-Anime account exists — every assertion runs on
// fixtures and the extension's own pages only.
//
// Coverage: (1) export writes the versioned whitelist envelope with no url /
// secret / vault material, (2) replace-all import is atomic and reconciles
// stale transient playback, (3) merge import + same-name conflict choices,
// (4) local playlist delete DETACHES the publication record, the options UI
// lists it, and 管理情報を破棄 warns then issues discard-publication-management,
// (5) a network spy proves ZERO /api/v1 (Share API) requests during all of it.
const EXTENSION_PATH = path.resolve("apps/extension/.output/chrome-mv3")
const EVIDENCE_DIR = path.resolve(".omo/evidence/task-11-d-op-v2-share")
const PLAYER = "https://animestore.docomo.ne.jp/animestore/sc_d_pc"
const SHARE_ID = "e2eShareId000000000001" // ShareIdSchema: exactly 22 chars
const MANAGE_SECRET = "e2eManageSecret" + "0".repeat(27) + "1" // ManageSecretSchema: exactly 43 chars
const OWNER_TOKEN = "123e4567-e89b-42d3-a456-426614174000"
const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)

test.setTimeout(90_000)

type SeedItem = {
  id: string
  partId: string
  title: string
  episodeTitle: string
  episodeNumber?: string
  url?: string
  range: { start: number; end: number; name?: string } | null
}

function item(id: string, partId: string, episodeNumber: string): SeedItem {
  return {
    id,
    partId,
    title: "Fixture Work",
    episodeTitle: `第${episodeNumber}話`,
    episodeNumber,
    url: `${PLAYER}?partId=${partId}`,
    range: { start: 0, end: 90_000, name: "OP" },
  }
}

type SeedState = {
  playlists: { id: string; name: string; items: SeedItem[] }[]
  publications?: unknown[]
  transientPlayback?: unknown
}

function v2State(seed: SeedState): Record<string, unknown> {
  return {
    schemaVersion: 2,
    revision: 0,
    playlists: seed.playlists,
    publications: seed.publications ?? [],
    pendingCreates: [],
    preferences: { windowMode: "tab", collapsedPlaylists: {} },
    appliedOperations: [],
  }
}

function publicationRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shareId: SHARE_ID,
    localPlaylistId: "pl-1",
    manageSecret: MANAGE_SECRET,
    revision: 2,
    contentHash: HASH_A,
    sentSnapshot: JSON.stringify({ sent: true }),
    acknowledgedHash: HASH_B,
    visibility: "public",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    state: "active",
    ...overrides,
  }
}

type Launched = {
  readonly context: BrowserContext
  readonly worker: Worker
  readonly extensionId: string
  readonly shareRequests: string[]
}

async function launchExtension(testInfo: TestInfo, seed: SeedState): Promise<Launched> {
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  })
  const shareRequests: string[] = []
  // Share API spy registers LAST so it wins over the catch-all (routes consult
  // newest-first): any attempted /api/v1 call is counted, then aborted.
  await context.route(/\/api\/v1\//, (route) => {
    shareRequests.push(route.request().url())
    return route.abort()
  })
  await context.route("**/*", (route) => {
    const url = route.request().url()
    if (/^https?:\/\//.test(url)) return route.abort()
    return route.continue()
  })
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 10_000 }))
  await worker.evaluate(`(async () => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set({
      dop_v2_state: ${JSON.stringify(v2State(seed))},
      dop_v2_transient: {
        schemaVersion: 1,
        generation: 1,
        playback: ${JSON.stringify(
          seed.transientPlayback === undefined ? undefined : seed.transientPlayback,
        )},
      },
    })
  })()`)
  const extensionId = new URL(worker.url()).hostname
  return { context, worker, extensionId, shareRequests }
}

function evidence(name: string): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  return path.join(EVIDENCE_DIR, name)
}

async function readState(worker: Worker): Promise<{
  playlists: { id: string; name: string; items: { id: string }[] }[]
  publications: {
    shareId: string
    localPlaylistId: string | null
    manageSecret: string
    state: string
  }[]
}> {
  return worker.evaluate(
    `chrome.storage.local.get("dop_v2_state").then((r) => r.dop_v2_state)`,
  ) as Promise<never>
}

async function readPlayback(worker: Worker): Promise<unknown> {
  return worker.evaluate(
    `chrome.storage.local.get("dop_v2_transient").then((r) => r.dop_v2_transient?.playback)`,
  )
}

async function downloadText(download: {
  createReadStream(): Promise<import("node:stream").Readable | null>
}): Promise<string> {
  const stream = await download.createReadStream()
  if (stream === null) throw new Error("download stream unavailable")
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("options: safe export envelope, replace-all reconcile, merge conflict, zero share-api traffic", async ({}, testInfo) => {
  const { context, worker, extensionId, shareRequests } = await launchExtension(testInfo, {
    playlists: [
      { id: "pl-1", name: "E2E Alpha", items: [item("a", "p1", "1"), item("b", "p2", "2")] },
      { id: "__dop__pending", name: "__dop__pending", items: [item("sys-1", "p9", "9")] },
    ],
    // Transient playback points at pl-1 so the replace-all import must
    // reconcile it away (pl-1 disappears entirely).
    transientPlayback: {
      playlistId: "pl-1",
      index: 0,
      updatedAt: 1_700_000_000_000,
      ownerToken: OWNER_TOKEN,
      ownerGeneration: 1,
    },
  })
  try {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/options.html`)
    // __dop__pending is a system playlist: only E2E Alpha renders.
    await expect(page.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })

    // --- Export: versioned whitelist envelope, zero secrets -----------------
    const downloadPromise = page.waitForEvent("download")
    await page.locator("#exportBtn").click()
    const text = await downloadText(await downloadPromise)
    fs.writeFileSync(evidence("exported.json"), text)
    const envelope = JSON.parse(text) as {
      schemaVersion: number
      playlists: Record<string, unknown>[]
    }
    // The portable envelope is exactly {schemaVersion, playlists}.
    expect(Object.keys(envelope).sort()).toEqual(["playlists", "schemaVersion"])
    expect(envelope.schemaVersion).toBe(2)
    // Only the user playlist is exported — never the __dop__ system playlist.
    expect(envelope.playlists).toHaveLength(1)
    expect(Object.keys(envelope.playlists[0] ?? {}).sort()).toEqual(["id", "items", "name"])
    const firstItem =
      (envelope.playlists[0]?.["items"] as Record<string, unknown>[] | undefined)?.[0] ?? {}
    for (const key of Object.keys(firstItem)) {
      expect([
        "id",
        "partId",
        "title",
        "episodeTitle",
        "episodeNumber",
        "workId",
        "range",
      ]).toContain(key)
    }
    // Raw-text privacy scan: no playback urls, no management material, no
    // storage internals anywhere in the file.
    for (const forbidden of [
      '"url"',
      "manageSecret",
      "publications",
      "pendingCreates",
      "dop_v2",
      "appliedOperations",
      SHARE_ID,
      MANAGE_SECRET,
      "animestore.docomo.ne.jp",
    ]) {
      expect(text).not.toContain(forbidden)
    }

    // --- Replace-all import: atomic swap, system playlist preserved, -------
    // --- stale playback reconciled ------------------------------------------
    const replacement = {
      schemaVersion: 2,
      playlists: [
        {
          id: "imp-1",
          name: "E2E Import",
          items: [
            {
              id: "i1",
              partId: "p3",
              title: "Imported",
              episodeTitle: "第1話",
              range: { start: 0, end: 60_000 },
            },
          ],
        },
      ],
    }
    await page.locator("#importFile").setInputFiles({
      name: "dop-library.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(replacement)),
    })
    // Import mode dialog → 上書き (destructive replacement is explicit).
    await page.locator("#d-op-modal .d-op-modal-footer button", { hasText: "上書き" }).click()
    await expect
      .poll(async () => (await readState(worker)).playlists.map((p) => p.id).sort())
      .toEqual(["__dop__pending", "imp-1"])
    // Stale playback reconciliation: pl-1 vanished → transient playback cleared.
    await expect.poll(async () => readPlayback(worker)).toBeUndefined()

    // --- Merge import: same-name conflict → 別名で追加 -----------------------
    const mergeFile = {
      schemaVersion: 2,
      playlists: [
        {
          id: "other-id",
          name: "E2E Import",
          items: [
            { id: "m1", partId: "p4", title: "Imported", episodeTitle: "第2話", range: null },
          ],
        },
      ],
    }
    await page.locator("#importFile").setInputFiles({
      name: "merge.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(mergeFile)),
    })
    await page.locator("#d-op-modal .d-op-modal-footer button", { hasText: "マージ" }).click()
    // Same-name conflict dialog lists 'E2E Import'.
    await expect(page.locator("#d-op-modal .d-op-modal-body")).toContainText("E2E Import")
    await page.locator("#d-op-modal .d-op-modal-footer button", { hasText: "別名で追加" }).click()
    await expect
      .poll(async () => (await readState(worker)).playlists.map((p) => p.name).sort())
      .toEqual(["E2E Import", "E2E Import (2)", "__dop__pending"])
    // Fresh id — the conflict copy never reuses the existing playlist id.
    const stateAfterSeparate = await readState(worker)
    const separate = stateAfterSeparate.playlists.find((p) => p.name === "E2E Import (2)")
    expect(separate?.id).not.toBe("imp-1")
    expect(separate?.items.map((i) => i.id)).toEqual(["m1"])

    // --- Merge import again: same-name conflict → マージ ---------------------
    await page.locator("#importFile").setInputFiles({
      name: "merge2.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(mergeFile)),
    })
    await page.locator("#d-op-modal .d-op-modal-footer button", { hasText: "マージ" }).click()
    await page
      .locator("#d-op-modal .d-op-modal-footer button", { hasText: "マージ（重複スキップ）" })
      .click()
    await expect
      .poll(async () => {
        const state = await readState(worker)
        return state.playlists.find((p) => p.id === "imp-1")?.items.length
      })
      .toBe(2)

    // Ordinary local rename stays network-free as well.
    const nameInput = page.locator(".playlist-name-input").first()
    await nameInput.fill("E2E Renamed")
    await nameInput.dispatchEvent("change")
    await expect
      .poll(async () => (await readState(worker)).playlists.find((p) => p.id === "imp-1")?.name)
      .toBe("E2E Renamed")

    // The whole flow — export, replace, two merges, rename — issued ZERO
    // Share API requests.
    expect(shareRequests).toEqual([])
    await page.screenshot({ path: evidence("options-portable.png"), fullPage: true })
  } finally {
    await context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("options: playlist delete detaches the publication record; destroy warns then discards", async ({}, testInfo) => {
  const { context, worker, extensionId, shareRequests } = await launchExtension(testInfo, {
    playlists: [{ id: "pl-1", name: "E2E Shared", items: [item("a", "p1", "1")] }],
    publications: [publicationRecord()],
  })
  try {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/options.html`)
    await expect(page.locator(".playlist-card")).toHaveCount(1, { timeout: 15_000 })
    // Nothing detached yet → the empty-state note renders.
    await expect(page.locator("#managementList .management-empty")).toBeVisible()

    // Local-only delete: the record DETACHES (not dropped) and surfaces.
    await page.locator(".playlist-actions button", { hasText: "削除" }).click()
    await page.locator("#d-op-modal .d-op-modal-footer button", { hasText: "削除" }).click()
    await expect(page.locator(".playlist-card")).toHaveCount(0)
    const row = page.locator("#managementList .management-row")
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(SHARE_ID)
    // Key material is NEVER rendered.
    const managementText = await page.locator("#managementList").textContent()
    expect(managementText).not.toContain(MANAGE_SECRET)
    expect(managementText).not.toContain(HASH_A)
    const vault = await readState(worker)
    expect(vault.publications).toHaveLength(1)
    expect(vault.publications[0]?.localPlaylistId).toBeNull()
    expect(vault.publications[0]?.state).toBe("local-deleted")
    // The management key stays in the vault until the explicit destroy.
    expect(vault.publications[0]?.manageSecret).toBe(MANAGE_SECRET)
    await page.screenshot({ path: evidence("management-detached.png"), fullPage: true })

    // 管理情報を破棄 → irreversible-loss warning; cancel keeps the record.
    await page.locator("#managementList .management-destroy").click()
    await expect(page.locator("#d-op-modal .d-op-modal-body")).toContainText("管理キー")
    await expect(page.locator("#d-op-modal .d-op-modal-body")).toContainText("取り消せません")
    await page.locator("#d-op-modal .d-op-modal-footer button", { hasText: "キャンセル" }).click()
    await expect(row).toHaveCount(1)
    expect((await readState(worker)).publications).toHaveLength(1)

    // Confirm → distinct discard-publication-management command; vault empties.
    await page.locator("#managementList .management-destroy").click()
    await page.locator("#d-op-modal .d-op-modal-footer button", { hasText: "破棄する" }).click()
    await expect(page.locator("#managementList .management-row")).toHaveCount(0)
    await expect(page.locator("#managementList .management-empty")).toBeVisible()
    await expect.poll(async () => (await readState(worker)).publications).toHaveLength(0)
    expect(shareRequests).toEqual([])
  } finally {
    await context.close()
  }
})
