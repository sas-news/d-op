import { describe, expect, it, vi } from "vitest"
import type { FetchInit, FetchLike } from "../../src/share/api-client"
import {
  createShareImportHandler,
  type ShareImportHandlerDeps,
  type ShareImportSender,
} from "../../src/share/import-handler"
import { InMemoryStorageDriver } from "../../src/storage/driver"
import type { LocalRepository } from "../../src/storage/repository"
import { createLocalRepository } from "../../src/storage/repository"
import {
  ALLOWED_ORIGINS,
  consentState,
  fetchJson,
  SHARE_ID,
  SHARE_ORIGIN,
  shareResponse,
} from "../share/fixtures"

// Task-18 confirm-path wiring: the aggregate notification fires ONLY after a
// successful local commit — failed and cancelled flows send nothing — and it
// is fire-and-forget, so a failing or hung notifier can never roll back or
// stall the saved playlist.

const EXT_ID = "test-extension-id"
const EXT_ORIGIN = "chrome-extension://test-extension-id"
const PAGE_URL = `${SHARE_ORIGIN}/p/${SHARE_ID}`

const relaySender: ShareImportSender = {
  id: EXT_ID,
  url: PAGE_URL,
  frameId: 0,
  tab: { id: 7, url: PAGE_URL },
}

const pageSender: ShareImportSender = {
  id: EXT_ID,
  url: `${EXT_ORIGIN}/import.html?t=x`,
  frameId: 0,
  tab: { id: 9, url: `${EXT_ORIGIN}/import.html?t=x` },
}

function setup(
  options: {
    readonly fetchImpl?: FetchLike
    readonly importNotifier?: (shareId: string) => Promise<unknown>
    readonly repository?: LocalRepository
  } = {},
) {
  // Task 22: confirm is consent-gated — seed the explicit grant so these
  // tests exercise the notification wiring, not the consent prompt.
  const driver = new InMemoryStorageDriver({ dop_v2_state: consentState("granted") })
  const repository =
    options.repository ??
    createLocalRepository({
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
    ...(options.importNotifier === undefined ? {} : { importNotifier: options.importNotifier }),
    fetchImpl: options.fetchImpl ?? (fetchJson({ data: shareResponse() }) as unknown as FetchLike),
  } satisfies ShareImportHandlerDeps)
  return { handler, opened, repository, driver }
}

type Handler = ReturnType<typeof createShareImportHandler>

async function beginAndConfirm(handler: Handler, opened: string[]): Promise<unknown> {
  await handler(
    { kind: "share-import-request", shareId: SHARE_ID, requestId: crypto.randomUUID() },
    relaySender,
  )
  const token = opened.at(-1) ?? ""
  return handler({ kind: "share-import-confirm", token }, pageSender)
}

describe("import completion notification hook", () => {
  it("fires the notifier once with the shareId after a committed confirm", async () => {
    const notified: string[] = []
    const { handler, opened } = setup({
      importNotifier: async (shareId) => {
        notified.push(shareId)
      },
    })
    const reply = (await beginAndConfirm(handler, opened)) as { status: string }
    expect(reply.status).toBe("committed")
    // Task 22: the fire-and-forget notify re-checks consent first, so the
    // notifier runs a microtask later — poll instead of asserting sync.
    await vi.waitFor(() => expect(notified).toEqual([SHARE_ID]))
  })

  it("sends nothing when the flow is cancelled or the commit fails", async () => {
    const notified: string[] = []
    const notifier = async (shareId: string) => {
      notified.push(shareId)
    }

    // Cancelled before confirm.
    const cancelled = setup({ importNotifier: notifier })
    await cancelled.handler(
      { kind: "share-import-request", shareId: SHARE_ID, requestId: crypto.randomUUID() },
      relaySender,
    )
    await cancelled.handler(
      { kind: "share-import-cancel", token: cancelled.opened.at(-1) ?? "" },
      pageSender,
    )
    expect(notified).toHaveLength(0)

    // Commit rejected by the repository -> failed reply, no notification.
    const driver = new InMemoryStorageDriver({ dop_v2_state: consentState("granted") })
    const base = createLocalRepository({
      driver,
      now: () => "2026-09-21T12:00:00.000Z",
      newId: () => crypto.randomUUID(),
    })
    const rejecting: LocalRepository = {
      ...base,
      dispatch: async () => ({ kind: "mutation-rejected", reason: "forced" }),
    }
    const failed = setup({ importNotifier: notifier, repository: rejecting })
    const reply = (await beginAndConfirm(failed.handler, failed.opened)) as { status: string }
    expect(reply.status).toBe("failed")
    expect(notified).toHaveLength(0)
  })

  it("never lets a failing notifier roll back the committed playlist", async () => {
    const { handler, opened, repository } = setup({
      importNotifier: async () => {
        throw new Error("notify exploded")
      },
    })
    const reply = (await beginAndConfirm(handler, opened)) as { status: string }
    expect(reply.status).toBe("committed")
    expect((await repository.readPublic()).playlists).toHaveLength(1)
  })

  it("returns committed without waiting for a hung notifier", async () => {
    const { handler, opened, repository } = setup({
      importNotifier: () => new Promise<never>(() => undefined),
    })
    const reply = (await beginAndConfirm(handler, opened)) as { status: string }
    expect(reply.status).toBe("committed")
    expect((await repository.readPublic()).playlists).toHaveLength(1)
  })

  it("default wiring POSTs a fresh eventId and retries the same id on failure", async () => {
    const posts: { url: string; init: FetchInit }[] = []
    const fetchImpl: FetchLike = (url, init) => {
      if (init.method === "POST") {
        posts.push({ url, init })
        return posts.length === 1
          ? Promise.reject(new TypeError("offline"))
          : Promise.resolve(new Response(null, { status: 204 }))
      }
      return fetchJson({ data: shareResponse() })()
    }
    const { handler, opened, repository } = setup({ fetchImpl })
    const reply = (await beginAndConfirm(handler, opened)) as { status: string }
    expect(reply.status).toBe("committed")
    expect((await repository.readPublic()).playlists).toHaveLength(1)

    await vi.waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[0]?.url).toBe(`${SHARE_ORIGIN}/api/v1/playlists/${SHARE_ID}/import`)
    expect(posts[0]?.init.credentials).toBe("omit")
    const firstId = JSON.parse(String(posts[0]?.init.body)) as { eventId: string }
    const retryId = JSON.parse(String(posts[1]?.init.body)) as { eventId: string }
    expect(firstId.eventId).toBe(retryId.eventId)
  })
})
