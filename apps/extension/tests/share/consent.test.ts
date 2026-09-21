// Task 22 consent gate unit coverage. The persisted ShareConsent record lives
// in dop_v2_state (single-writer repository); effectiveShareConsent combines
// it with the Firefox ≥140 native data-collection layer when that exists.
// The gates are enforced in the background handlers — the UI consent prompts
// are conveniences, never the enforcement boundary.
import { describe, expect, it, vi } from "vitest"
import type { LocalCommand, LocalV2State } from "../../../../packages/shared/src/local-model"
import type { FetchLike } from "../../src/share/api-client"
import {
  type DataPermissions,
  effectiveShareConsent,
  NATIVE_CONSENT_REQUEST_TIMEOUT_MS,
  requestShareDataPermissions,
  writeShareConsent,
} from "../../src/share/consent"
import { createShareImportHandler, type ShareImportSender } from "../../src/share/import-handler"
import { createShareManagementHandler } from "../../src/share/management-handler"
import { InMemoryStorageDriver } from "../../src/storage/driver"
import { createLocalRepository, type LocalRepository } from "../../src/storage/repository"
import {
  ALLOWED_ORIGINS,
  consentState,
  fetchJson,
  NOW,
  SHARE_ID,
  SHARE_ORIGIN,
  shareResponse,
} from "./fixtures"

const STATE_KEY = "dop_v2_state"
const EXT_ID = "test-extension-id"
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`
const OPTIONS = { id: EXT_ID, url: `${EXT_ORIGIN}/options.html` }

function repo(seed?: LocalV2State) {
  const driver = new InMemoryStorageDriver(seed === undefined ? {} : { [STATE_KEY]: seed })
  const repository = createLocalRepository({
    driver,
    now: () => NOW,
    newId: () => crypto.randomUUID(),
  })
  return { driver, repository }
}

const grantedCategories = {
  getAll: async () => ({
    data_collection: ["websiteContent", "personallyIdentifyingInfo", "technicalAndInteraction"],
  }),
}

describe("effectiveShareConsent", () => {
  it("treats an absent record as undecided — never a grant", async () => {
    const { repository } = repo()
    expect(await effectiveShareConsent(repository)).toBe("undecided")
    expect(await effectiveShareConsent(repository, grantedCategories)).toBe("undecided")
  })

  it("returns the stored choice when no native layer exists", async () => {
    const granted = repo(consentState("granted"))
    expect(await effectiveShareConsent(granted.repository)).toBe("granted")
    const declined = repo(consentState("declined"))
    expect(await effectiveShareConsent(declined.repository)).toBe("declined")
    // getAll() without a data_collection key = no native consent layer.
    const noNative: DataPermissions = { getAll: async () => ({}) }
    expect(await effectiveShareConsent(granted.repository, noNative)).toBe("granted")
  })

  it("downgrades to undecided when Firefox revokes a declared category", async () => {
    const { repository } = repo(consentState("granted"))
    expect(await effectiveShareConsent(repository, grantedCategories)).toBe("granted")
    const partial: DataPermissions = {
      getAll: async () => ({ data_collection: ["websiteContent"] }),
    }
    expect(await effectiveShareConsent(repository, partial)).toBe("undecided")
    const empty: DataPermissions = { getAll: async () => ({ data_collection: [] }) }
    expect(await effectiveShareConsent(repository, empty)).toBe("undecided")
  })

  it("fails closed when the permissions read throws", async () => {
    const { repository } = repo(consentState("granted"))
    const broken: DataPermissions = {
      getAll: async () => {
        throw new Error("permissions read failed")
      },
    }
    expect(await effectiveShareConsent(repository, broken)).toBe("undecided")
  })
})

describe("requestShareDataPermissions", () => {
  it("resolves true when the native API is absent or unsupported", async () => {
    expect(await requestShareDataPermissions(undefined)).toBe(true)
    expect(await requestShareDataPermissions({})).toBe(true)
    expect(await requestShareDataPermissions({ getAll: async () => ({}) })).toBe(true)
  })

  it("requests the declared categories when the native layer exists", async () => {
    let requested: readonly string[] | undefined
    const perms: DataPermissions = {
      ...grantedCategories,
      request: async (input) => {
        requested = input.data_collection
        return true
      },
    }
    expect(await requestShareDataPermissions(perms)).toBe(true)
    expect(requested).toEqual([
      "websiteContent",
      "personallyIdentifyingInfo",
      "technicalAndInteraction",
    ])
    const denied: DataPermissions = {
      ...grantedCategories,
      request: async () => false,
    }
    expect(await requestShareDataPermissions(denied)).toBe(false)
  })

  it("fails closed when the native request never settles (headless/hung prompt)", async () => {
    vi.useFakeTimers()
    try {
      const hung: DataPermissions = {
        ...grantedCategories,
        request: () => new Promise<boolean>(() => {}),
      }
      const outcome = requestShareDataPermissions(hung)
      await vi.advanceTimersByTimeAsync(NATIVE_CONSENT_REQUEST_TIMEOUT_MS)
      expect(await outcome).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("writeShareConsent", () => {
  function uiStorage(repository: LocalRepository) {
    return {
      readPublic: () => repository.readPublic(),
      dispatch: (command: LocalCommand) => repository.dispatch(command),
    }
  }

  it("persists declined without touching the native prompt", async () => {
    const { repository } = repo()
    let prompted = false
    const perms: DataPermissions = {
      ...grantedCategories,
      request: async () => {
        prompted = true
        return true
      },
    }
    const result = await writeShareConsent(
      uiStorage(repository),
      perms,
      "declined",
      () => crypto.randomUUID(),
      () => NOW,
    )
    expect(result).toBe("written")
    expect(prompted).toBe(false)
    expect((await repository.readVault()).shareConsent).toEqual({
      choice: "declined",
      decidedAt: NOW,
    })
  })

  it("persists granted only after the native prompt grants", async () => {
    const { repository } = repo()
    const perms: DataPermissions = { ...grantedCategories, request: async () => true }
    expect(
      await writeShareConsent(uiStorage(repository), perms, "granted", () => crypto.randomUUID()),
    ).toBe("written")
    expect((await repository.readVault()).shareConsent?.choice).toBe("granted")
  })

  it("writes nothing when the native prompt denies", async () => {
    const { repository } = repo()
    const perms: DataPermissions = { ...grantedCategories, request: async () => false }
    expect(
      await writeShareConsent(uiStorage(repository), perms, "granted", () => crypto.randomUUID()),
    ).toBe("native-denied")
    expect((await repository.readVault()).shareConsent).toBeUndefined()
  })
})

describe("management handler consent gate", () => {
  function manageHandler(seed?: LocalV2State, dataPermissions?: DataPermissions) {
    const { repository } = repo(seed)
    const calls: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      calls.push(String(url))
      return new Response("{}", { status: 404 })
    }
    const handler = createShareManagementHandler({
      repository,
      extensionId: EXT_ID,
      extensionOrigin: EXT_ORIGIN,
      fetchImpl,
      ...(dataPermissions === undefined ? {} : { dataPermissions }),
    })
    return { handler, calls }
  }

  const publish = {
    kind: "share-manage-publish",
    operationId: crypto.randomUUID(),
    playlistId: "p1",
    metadata: { visibility: "public" },
  }

  it("answers consent-required for every management kind while undecided — zero fetches", async () => {
    const { handler, calls } = manageHandler()
    for (const message of [
      publish,
      {
        kind: "share-manage-activate",
        shareId: SHARE_ID,
        operationId: crypto.randomUUID(),
      },
      {
        kind: "share-manage-update",
        shareId: SHARE_ID,
        operationId: crypto.randomUUID(),
      },
      {
        kind: "share-manage-delete",
        shareId: SHARE_ID,
        operationId: crypto.randomUUID(),
      },
      { kind: "share-manage-inspect", shareId: SHARE_ID },
      { kind: "share-manage-source", playlistId: "p1" },
    ]) {
      expect(await handler(message, OPTIONS)).toEqual({
        kind: "share-manage-result",
        status: "consent-required",
      })
    }
    expect(calls).toEqual([])
  })

  it("answers consent-required while declined", async () => {
    const { handler, calls } = manageHandler(consentState("declined"))
    expect(await handler(publish, OPTIONS)).toEqual({
      kind: "share-manage-result",
      status: "consent-required",
    })
    expect(calls).toEqual([])
  })

  it("foreign senders get forbidden regardless of consent", async () => {
    const { handler, calls } = manageHandler()
    const webSender = { id: EXT_ID, url: `${SHARE_ORIGIN}/p/${SHARE_ID}`, tab: { id: 1 } }
    expect(await handler(publish, webSender)).toEqual({
      kind: "share-manage-result",
      status: "forbidden",
    })
    const granted = manageHandler(consentState("granted"))
    expect(await granted.handler(publish, webSender)).toEqual({
      kind: "share-manage-result",
      status: "forbidden",
    })
    expect(calls).toEqual([])
    expect(granted.calls).toEqual([])
  })
})

describe("import handler consent gate", () => {
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

  function importHandler(seed?: LocalV2State) {
    const { driver, repository } = repo(seed)
    const fetches: string[] = []
    const opened: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      fetches.push(String(url))
      return fetchJson({ data: shareResponse() })()
    }
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
      fetchImpl,
    })
    return { handler, repository, fetches, opened }
  }

  const relay = () => ({
    kind: "share-import-request",
    shareId: SHARE_ID,
    requestId: crypto.randomUUID(),
  })

  it("declined rejects the relay outright — no window, no fetch", async () => {
    const { handler, fetches, opened } = importHandler(consentState("declined"))
    expect(await handler(relay(), relaySender)).toEqual({
      kind: "share-import-begin",
      status: "rejected",
    })
    expect(opened).toEqual([])
    expect(fetches).toEqual([])
  })

  it("undecided opens the consent surface but never prefetches the snapshot", async () => {
    const { handler, fetches, opened } = importHandler()
    expect(await handler(relay(), relaySender)).toEqual({
      kind: "share-import-begin",
      status: "opened",
    })
    expect(opened).toHaveLength(1)
    // The preview GET must not have run before an explicit choice.
    expect(fetches).toEqual([])
    const token = opened[0] ?? ""
    expect(await handler({ kind: "share-import-details", token }, pageSender)).toEqual({
      kind: "share-import-error",
      reason: "consent-required",
    })
    expect(await handler({ kind: "share-import-confirm", token }, pageSender)).toMatchObject({
      status: "failed",
      reason: "consent-required",
    })
    expect(fetches).toEqual([])
  })

  it("share-import-consent granted persists the decision and returns the preview", async () => {
    const { handler, repository, fetches, opened } = importHandler()
    await handler(relay(), relaySender)
    const token = opened[0] ?? ""
    const reply = await handler(
      { kind: "share-import-consent", token, decision: "granted" },
      pageSender,
    )
    expect(reply).toMatchObject({ kind: "share-import-preview" })
    expect((await repository.readVault()).shareConsent?.choice).toBe("granted")
    expect(fetches).toEqual([`${SHARE_ORIGIN}/api/v1/playlists/${SHARE_ID}`])
    // Confirm now works.
    expect(await handler({ kind: "share-import-confirm", token }, pageSender)).toMatchObject({
      status: "committed",
    })
  })

  it("share-import-consent declined persists declined and cancels the request", async () => {
    const { handler, repository, fetches, opened } = importHandler()
    await handler(relay(), relaySender)
    const token = opened[0] ?? ""
    expect(
      await handler({ kind: "share-import-consent", token, decision: "declined" }, pageSender),
    ).toEqual({ kind: "share-import-error", reason: "consent-declined" })
    expect((await repository.readVault()).shareConsent?.choice).toBe("declined")
    expect(fetches).toEqual([])
    // The request is settled — a later confirm gets expired, not data.
    expect(await handler({ kind: "share-import-confirm", token }, pageSender)).toMatchObject({
      status: "failed",
      reason: "expired",
    })
  })

  it("consent and confirm from foreign senders are forbidden", async () => {
    const { handler, opened } = importHandler()
    await handler(relay(), relaySender)
    const token = opened[0] ?? ""
    for (const message of [
      { kind: "share-import-consent", token, decision: "granted" },
      { kind: "share-import-details", token },
      { kind: "share-import-confirm", token },
    ]) {
      const reply = (await handler(message, relaySender)) as { reason?: string }
      expect(reply?.reason ?? reply).toMatch(/forbidden/)
    }
  })

  it("revocation blocks a previously-granted confirm path", async () => {
    const { handler, repository, fetches, opened } = importHandler(consentState("granted"))
    await handler(relay(), relaySender)
    const token = opened[0] ?? ""
    // Snapshot prefetch ran under grant.
    expect(fetches).toEqual([`${SHARE_ORIGIN}/api/v1/playlists/${SHARE_ID}`])
    // Revoke via the repository command.
    const vault = await repository.readVault()
    await repository.dispatch({
      kind: "set-share-consent",
      choice: "declined",
      decidedAt: NOW,
      operationId: crypto.randomUUID(),
      expectedRevision: vault.revision,
    })
    fetches.length = 0
    expect(await handler({ kind: "share-import-confirm", token }, pageSender)).toMatchObject({
      status: "failed",
      reason: "consent-required",
    })
    expect(fetches).toEqual([])
  })
})
