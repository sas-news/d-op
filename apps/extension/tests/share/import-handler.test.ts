import { describe, expect, it } from "vitest"
import type { LocalV2State } from "../../../../packages/shared/src/local-model"
import type { FetchLike } from "../../src/share/api-client"
import { createShareImportHandler, type ShareImportSender } from "../../src/share/import-handler"
import { InMemoryStorageDriver } from "../../src/storage/driver"
import { createLocalRepository } from "../../src/storage/repository"
import {
  ALLOWED_ORIGINS,
  consentState,
  fetchJson,
  SHARE_ID,
  SHARE_ORIGIN,
  shareResponse,
} from "./fixtures"

const EXT_ID = "test-extension-id"
const EXT_ORIGIN = "chrome-extension://test-extension-id"
const PAGE_URL = `${SHARE_ORIGIN}/p/${SHARE_ID}`

function relaySender(overrides: Partial<ShareImportSender> = {}): ShareImportSender {
  return {
    id: EXT_ID,
    url: PAGE_URL,
    frameId: 0,
    tab: { id: 7, url: PAGE_URL },
    ...overrides,
  }
}

const pageSender: ShareImportSender = {
  id: EXT_ID,
  url: `${EXT_ORIGIN}/import.html?t=x`,
  frameId: 0,
  tab: { id: 9, url: `${EXT_ORIGIN}/import.html?t=x` },
}

function setup(options: { fetchImpl?: FetchLike; seed?: LocalV2State } = {}) {
  // Task 22: Share traffic requires the persisted consent record — default
  // the seed to granted so these tests exercise the import flow itself.
  const driver = new InMemoryStorageDriver({
    dop_v2_state: options.seed ?? consentState("granted"),
  })
  const repository = createLocalRepository({
    driver,
    now: () => "2026-09-21T12:00:00.000Z",
    newId: () => crypto.randomUUID(),
  })
  const opened: string[] = []
  const handler = createShareImportHandler({
    repository,
    driver,
    extensionId: EXT_ID,
    extensionOrigin: EXT_ORIGIN,
    allowedOrigins: ALLOWED_ORIGINS,
    apiOrigin: SHARE_ORIGIN,
    openConfirmation: async (token) => {
      opened.push(token)
    },
    ...(options.fetchImpl === undefined
      ? { fetchImpl: fetchJson({ data: shareResponse() }) }
      : { fetchImpl: options.fetchImpl }),
  })
  return { handler, opened, repository, driver }
}

const relayMessage = (requestId: string = crypto.randomUUID()) => ({
  kind: "share-import-request",
  shareId: SHARE_ID,
  requestId,
})

async function begin(handler: ReturnType<typeof createShareImportHandler>, requestId?: string) {
  return (await handler(relayMessage(requestId), relaySender())) as { status: string }
}

describe("share import background handler", () => {
  it("ignores unrelated messages so other routers still see them", async () => {
    const { handler } = setup()
    expect(await handler({ kind: "REQUEST_PLAYER" }, relaySender())).toBeUndefined()
    expect(await handler("garbage", relaySender())).toBeUndefined()
    expect(await handler(null, relaySender())).toBeUndefined()
  })

  it("accepts a valid relayed request, opens confirmation, and replies opened", async () => {
    const { handler, opened } = setup()
    const reply = await begin(handler)
    expect(reply).toEqual({ kind: "share-import-begin", status: "opened" })
    expect(opened).toHaveLength(1)
  })

  it("rejects forged senders: wrong id, iframe frame, foreign origin, wrong tab", async () => {
    const { handler } = setup()
    const forged: (ShareImportSender | undefined)[] = [
      relaySender({ id: "other-extension" }),
      relaySender({ frameId: 3 }),
      relaySender({ frameId: undefined }),
      relaySender({ url: `https://evil.example/p/${SHARE_ID}` }),
      relaySender({ url: `${SHARE_ORIGIN}/p/ABCDEFGHIJKLMNOPQRSTUV` }), // different shareId
      relaySender({ url: `${SHARE_ORIGIN}/explore` }),
      relaySender({ url: undefined }),
      relaySender({ tab: undefined }),
      relaySender({ tab: { url: `https://evil.example/p/${SHARE_ID}` } }),
      relaySender({ origin: "https://evil.example" }),
      relaySender({ origin: `${SHARE_ORIGIN}.evil.example` }),
      undefined,
    ]
    for (const sender of forged) {
      const reply = await handler(relayMessage(), sender)
      expect(reply).toEqual({ kind: "share-import-begin", status: "rejected" })
    }
  })

  it("dedupes a repeated requestId and throttles rapid distinct requests", async () => {
    const { handler, opened } = setup()
    const id = crypto.randomUUID()
    expect((await begin(handler, id)).status).toBe("opened")
    expect((await begin(handler, id)).status).toBe("duplicate")
    expect((await begin(handler)).status).toBe("rejected") // throttled
    expect(opened).toHaveLength(1)
  })

  it("blocks page messages from non-extension senders and serves the preview to the page", async () => {
    const { handler, opened } = setup()
    await begin(handler)
    const token = opened[0] ?? ""
    // A web page cannot reach the confirmation surface.
    expect(await handler({ kind: "share-import-details", token }, relaySender())).toEqual({
      kind: "share-import-error",
      reason: "forbidden",
    })
    // The extension page gets only the preview fields — no vault/library data.
    const reply = await handler({ kind: "share-import-details", token }, pageSender)
    expect(reply).toEqual({
      kind: "share-import-preview",
      preview: {
        shareId: SHARE_ID,
        title: "共有リスト",
        author: "公開者",
        itemCount: 2,
        totalDurationMs: 180_500,
        revision: 2,
      },
    })
  })

  it("surfaces a fetch failure as a bounded error, not a throw", async () => {
    const { handler, opened } = setup({
      fetchImpl: async () => {
        throw new TypeError("offline")
      },
    })
    await begin(handler)
    const reply = await handler(
      { kind: "share-import-details", token: opened[0] ?? "" },
      pageSender,
    )
    expect(reply).toEqual({ kind: "share-import-error", reason: "network" })
  })

  it("commits on confirm, rejects double-confirm, and late cancel cannot un-commit", async () => {
    const { handler, opened, repository } = setup()
    await begin(handler)
    const token = opened[0] ?? ""
    await handler({ kind: "share-import-details", token }, pageSender)
    const committed = (await handler({ kind: "share-import-confirm", token }, pageSender)) as {
      status: string
      playlistId?: string
    }
    expect(committed.status).toBe("committed")
    expect((await repository.readPublic()).playlists).toHaveLength(1)
    // Double confirm / cancel-after-commit are refused by the settled state.
    const second = (await handler({ kind: "share-import-confirm", token }, pageSender)) as {
      status: string
    }
    expect(second).toMatchObject({ status: "failed", reason: "expired" })
    await handler({ kind: "share-import-cancel", token }, pageSender)
    expect((await repository.readPublic()).playlists).toHaveLength(1)
  })

  it("cancel before confirm leaves state untouched", async () => {
    const { handler, opened, repository } = setup()
    await begin(handler)
    const token = opened[0] ?? ""
    const reply = await handler({ kind: "share-import-cancel", token }, pageSender)
    expect(reply).toMatchObject({ status: "cancelled" })
    expect((await repository.readPublic()).playlists).toHaveLength(0)
    const after = (await handler({ kind: "share-import-confirm", token }, pageSender)) as {
      status: string
    }
    expect(after).toMatchObject({ status: "failed" })
  })

  it("replies rejected when the confirmation window cannot open", async () => {
    const driver = new InMemoryStorageDriver()
    const repository = createLocalRepository({
      driver,
      now: () => "2026-09-21T12:00:00.000Z",
      newId: () => crypto.randomUUID(),
    })
    const handler = createShareImportHandler({
      repository,
      driver,
      extensionId: EXT_ID,
      extensionOrigin: EXT_ORIGIN,
      allowedOrigins: ALLOWED_ORIGINS,
      fetchImpl: fetchJson({ data: shareResponse() }),
      openConfirmation: async () => {
        throw new Error("popup blocked")
      },
    })
    expect(await handler(relayMessage(), relaySender())).toEqual({
      kind: "share-import-begin",
      status: "rejected",
    })
  })
})
