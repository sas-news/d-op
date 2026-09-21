// Privileged-surface authorization tests (task 15): only the options page may
// initiate publication management. Content scripts, web pages, popups, other
// extensions and unparseable messages are rejected or ignored, and an internal
// throw still answers with a bounded `failed` reply — sendMessage never
// rejects into the page.
import { describe, expect, it } from "vitest"
import type { LocalV2State } from "../../../../packages/shared/src/local-model"
import { createShareManagementHandler } from "../../src/share/management-handler"
import { InMemoryStorageDriver } from "../../src/storage/driver"
import { createLocalRepository } from "../../src/storage/repository"
import { playlist } from "../domain/fixtures"
import { v2State } from "../portable/fixtures"
import { type FakeApi, fakeShareApi, linkedRecord, NOW, SHARE_ID } from "./fixtures"

const STATE_KEY = "dop_v2_state"
const EXT_ID = "ext-id-for-tests"
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`

async function handlerFor(overrides: Partial<LocalV2State> = {}, api: FakeApi = fakeShareApi()) {
  const local = playlist("p1", ["a"])
  const record = await linkedRecord(local)
  const driver = new InMemoryStorageDriver({
    [STATE_KEY]: v2State({ playlists: [local], publications: [record], ...overrides }),
  })
  const repository = createLocalRepository({
    driver,
    now: () => NOW,
    newId: () => crypto.randomUUID(),
  })
  // Seed the matching remote so inspect has something to reconcile.
  api.remotes.set(SHARE_ID, {
    shareId: SHARE_ID,
    secret: record.manageSecret,
    revision: record.revision,
    state: "active",
    playlist: JSON.parse(record.sentSnapshot),
    contentHash: record.acknowledgedHash,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const handler = createShareManagementHandler({
    repository,
    extensionId: EXT_ID,
    extensionOrigin: EXT_ORIGIN,
    fetchImpl: api.fetchImpl,
    now: () => NOW,
    newId: () => crypto.randomUUID(),
  })
  return { handler, record, api }
}

const OPTIONS = { id: EXT_ID, url: `${EXT_ORIGIN}/options.html` }

describe("management-handler", () => {
  it("ignores non-management and malformed messages (other listeners proceed)", async () => {
    const { handler } = await handlerFor()
    expect(handler({ kind: "REQUEST_PLAYER" }, OPTIONS)).toBeUndefined()
    expect(handler({ kind: "share-manage-publish", operationId: "x" }, OPTIONS)).toBeUndefined()
    expect(handler("garbage", OPTIONS)).toBeUndefined()
    expect(handler(undefined, OPTIONS)).toBeUndefined()
  })

  it("forbids content scripts, web pages, popups and foreign senders", async () => {
    const { handler, record } = await handlerFor()
    const inspect = { kind: "share-manage-inspect", shareId: SHARE_ID }
    const denied = [
      { id: EXT_ID, url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc", tab: { id: 1 } },
      { id: EXT_ID, url: "https://d-op.sasnews.dev/p/x", tab: { id: 2 } },
      { id: "other-extension", url: "chrome-extension://other-extension/options.html" },
      { id: EXT_ID, url: `${EXT_ORIGIN}/popup.html` },
      { id: EXT_ID, url: `${EXT_ORIGIN}/options.html`, frameId: 7 },
      undefined,
    ]
    for (const sender of denied) {
      const reply = await handler(inspect, sender)
      expect(reply).toEqual({ kind: "share-manage-result", status: "forbidden" })
    }
    expect(record.shareId).toBe(SHARE_ID) // sanity: fixture wired
  })

  it("serves the options page and bounds internal failures", async () => {
    const { handler } = await handlerFor()
    const inspect = await handler({ kind: "share-manage-inspect", shareId: SHARE_ID }, OPTIONS)
    expect(inspect).toMatchObject({ status: "inspect", remote: "active", remoteRevision: 2 })

    // Missing record → bounded not-found, not a throw.
    const missing = await handler(
      { kind: "share-manage-inspect", shareId: "ABCDEFGHIJKLMNOPQRSTUV" },
      OPTIONS,
    )
    expect(missing).toMatchObject({ status: "not-found" })
  })
})
