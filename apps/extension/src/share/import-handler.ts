// Background orchestration for the web→extension import (task 17). Re-checks
// everything the content-script relay already checked (never trust a relay):
// exact sender origin/frame/tab sanity, strict message schema, dedupe of
// repeated requestIds. Only the extension-owned import page (identified by its
// extension origin URL) may read previews or confirm/cancel. The background
// fetches the FIXED API origin itself and commits fresh local ids — the web
// page learns nothing beyond the status ack.
import type { GetPlaylistResponse } from "../../../../packages/shared/src/api"
import type { StorageDriver } from "../storage/driver"
import type { LocalRepository } from "../storage/repository"
import { type FetchLike, fetchSharedPlaylist, type ShareFetchResult } from "./api-client"
import { type DataPermissions, effectiveShareConsent } from "./consent"
import { createVaultCommitter } from "./flow-helpers"
import { commitImport } from "./import-commit"
import { notifyImportCommitted } from "./import-notify"
import {
  createImportRequestBook,
  type ImportRequestBook,
  type PendingImport,
} from "./import-requests"
import { allowedShareOrigins, SHARE_ORIGIN, shareIdFromPageUrl } from "./origins"
import {
  parseShareImportMessage,
  type ShareImportBeginReply,
  type ShareImportBeginStatus,
  type ShareImportConfirmReply,
  type ShareImportConsentRequest,
  type ShareImportDetailsReply,
  type ShareImportPreview,
  type ShareImportRelayRequest,
} from "./protocol"

export type ShareImportSender = {
  readonly id?: string | undefined
  readonly url?: string | undefined
  readonly origin?: string | undefined
  readonly frameId?: number | undefined
  readonly tab?: { readonly id?: number | undefined; readonly url?: string | undefined } | undefined
}

export type ShareImportHandlerDeps = {
  readonly repository: LocalRepository
  readonly driver: StorageDriver
  readonly extensionId: string
  /** e.g. `new URL(browser.runtime.getURL("/")).origin` */
  readonly extensionOrigin: string
  readonly openConfirmation: (token: string) => Promise<void>
  readonly apiOrigin?: string
  readonly allowedOrigins?: readonly string[]
  /**
   * Task 22: Firefox ≥140 built-in data-consent probe (browser.permissions).
   * Absent → the persisted in-extension decision alone gates Share traffic.
   */
  readonly dataPermissions?: DataPermissions
  readonly fetchImpl?: FetchLike
  /**
   * Test hook replacing the fire-and-forget import notification (task 18).
   * Default: notifyImportCommitted bound to apiOrigin/fetchImpl/newId.
   */
  readonly importNotifier?: (shareId: string) => Promise<unknown>
  readonly now?: () => string
  readonly newId?: () => string
  readonly requests?: ImportRequestBook
}

type FetchErrorReason = Extract<ShareFetchResult, { kind: "error" }>["reason"]

const DETAIL_ERRORS: Record<FetchErrorReason, string> = {
  "not-found": "not-found",
  "rate-limited": "rate-limited",
  unavailable: "unavailable",
  "invalid-response": "invalid-response",
  "too-large": "too-large",
  network: "network",
  timeout: "network",
  "share-mismatch": "invalid-response",
}

function previewOf(response: GetPlaylistResponse): ShareImportPreview {
  return {
    shareId: response.shareId,
    title: response.playlist.title,
    author: response.playlist.author,
    itemCount: response.itemCount,
    totalDurationMs: response.totalDurationMs,
    revision: response.revision,
  }
}

export function createShareImportHandler(deps: ShareImportHandlerDeps) {
  const origins = deps.allowedOrigins ?? allowedShareOrigins()
  const apiOrigin = deps.apiOrigin ?? SHARE_ORIGIN
  const requests =
    deps.requests ??
    createImportRequestBook({ newToken: deps.newId ?? (() => crypto.randomUUID()) })
  const inflight = new Map<string, Promise<ShareFetchResult>>()

  const newId = deps.newId ?? (() => crypto.randomUUID())
  const now = deps.now ?? (() => new Date().toISOString())
  const vault = createVaultCommitter(deps.repository, newId)
  const consent = (): Promise<"granted" | "declined" | "undecided"> =>
    effectiveShareConsent(deps.repository, deps.dataPermissions)
  const notifyImport =
    deps.importNotifier ??
    ((shareId: string) =>
      notifyImportCommitted({
        apiOrigin,
        shareId,
        newId,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      }))

  /** Sender of the page relay must be our CS in a TOP frame on the share page. */
  const isRelaySender = (sender: ShareImportSender | undefined, shareId: string): boolean => {
    if (sender === undefined || sender.id !== deps.extensionId) return false
    if (sender.frameId !== 0) return false
    if (sender.origin !== undefined && !origins.includes(sender.origin)) return false
    if (shareIdFromPageUrl(sender.url, origins) !== shareId) return false
    const tab = sender.tab
    if (tab === undefined || typeof tab.id !== "number" || tab.id < 0) return false
    // The tab document must itself be that share page — a CS cannot relay
    // for a shareId the tab is not displaying.
    return shareIdFromPageUrl(tab.url, origins) === shareId
  }

  const isExtensionPageSender = (sender: ShareImportSender | undefined): boolean =>
    sender !== undefined &&
    sender.id === deps.extensionId &&
    typeof sender.url === "string" &&
    sender.url.startsWith(`${deps.extensionOrigin}/`) &&
    (sender.frameId === undefined || sender.frameId === 0)

  const ensureSnapshot = async (token: string, entry: PendingImport): Promise<ShareFetchResult> => {
    if (entry.response !== undefined) return { kind: "ok", response: entry.response }
    const existing = inflight.get(token)
    if (existing !== undefined) return existing
    const running = fetchSharedPlaylist({
      apiOrigin,
      shareId: entry.shareId,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    })
    inflight.set(token, running)
    try {
      const result = await running
      if (result.kind === "ok") requests.attachPreview(token, result.response)
      return result
    } finally {
      inflight.delete(token)
    }
  }

  const begin = async (
    message: ShareImportRelayRequest,
    sender: ShareImportSender | undefined,
  ): Promise<ShareImportBeginReply> => {
    if (!isRelaySender(sender, message.shareId)) {
      return { kind: "share-import-begin", status: "rejected" }
    }
    // Task 22 consent gate, enforced BEFORE any network or window work:
    // a persisted "declined" rejects the relay outright — no token, no
    // confirmation window, zero Share traffic. "undecided" admits the
    // request and opens the privileged import page, which prompts for the
    // explicit choice first; the snapshot prefetch stays skipped until
    // consent is granted so not even the preview GET can leak out.
    const state = await consent()
    if (state === "declined") {
      return { kind: "share-import-begin", status: "rejected" }
    }
    const admitted = requests.admit({
      shareId: message.shareId,
      requestId: message.requestId,
      ...(sender?.tab?.id === undefined ? {} : { tabId: sender.tab.id }),
    })
    const status: ShareImportBeginStatus =
      admitted.kind === "accepted"
        ? "opened"
        : admitted.kind === "duplicate"
          ? "duplicate"
          : "rejected"
    if (admitted.kind !== "accepted") return { kind: "share-import-begin", status }
    const entry = requests.get(admitted.token)
    if (entry !== undefined && state === "granted") {
      void ensureSnapshot(admitted.token, entry)
    }
    try {
      await deps.openConfirmation(admitted.token)
    } catch {
      requests.settle(admitted.token, "failed")
      return { kind: "share-import-begin", status: "rejected" }
    }
    return { kind: "share-import-begin", status: "opened" }
  }

  const details = async (
    token: string,
    sender: ShareImportSender | undefined,
  ): Promise<ShareImportDetailsReply> => {
    if (!isExtensionPageSender(sender)) {
      return { kind: "share-import-error", reason: "forbidden" }
    }
    const entry = requests.get(token)
    if (entry === undefined || entry.state !== "awaiting-confirm") {
      return { kind: "share-import-error", reason: "expired" }
    }
    // No preview fetch before explicit consent — the page renders its own
    // consent prompt for "consent-required" instead of preview data.
    if ((await consent()) !== "granted") {
      return { kind: "share-import-error", reason: "consent-required" }
    }
    const result = await ensureSnapshot(token, entry)
    if (result.kind === "error") {
      return { kind: "share-import-error", reason: DETAIL_ERRORS[result.reason] }
    }
    return { kind: "share-import-preview", preview: previewOf(result.response) }
  }

  /**
   * Task 22: the privileged import page reports the user's consent decision.
   * The background persists it through the single-writer repository — the
   * page never touches storage — then either settles the request cancelled
   * (declined: no fetch ever ran, nothing transmits) or continues into the
   * preview fetch exactly as `details` does (granted).
   */
  const onConsent = async (
    request: ShareImportConsentRequest,
    sender: ShareImportSender | undefined,
  ): Promise<ShareImportDetailsReply> => {
    if (!isExtensionPageSender(sender)) {
      return { kind: "share-import-error", reason: "forbidden" }
    }
    const entry = requests.get(request.token)
    if (entry === undefined || entry.state !== "awaiting-confirm") {
      return { kind: "share-import-error", reason: "expired" }
    }
    const written = await vault.try(newId(), () => ({
      kind: "set-share-consent",
      choice: request.decision,
      decidedAt: now(),
    }))
    if (!written) return { kind: "share-import-error", reason: "unavailable" }
    if (request.decision === "declined") {
      requests.settle(request.token, "cancelled")
      return { kind: "share-import-error", reason: "consent-declined" }
    }
    // The grant must also hold on the native layer (Firefox ≥140 can revoke
    // via about:addons at any time) before any fetch is allowed.
    if ((await consent()) !== "granted") {
      return { kind: "share-import-error", reason: "consent-required" }
    }
    const result = await ensureSnapshot(request.token, entry)
    if (result.kind === "error") {
      return { kind: "share-import-error", reason: DETAIL_ERRORS[result.reason] }
    }
    return { kind: "share-import-preview", preview: previewOf(result.response) }
  }

  const confirm = async (
    token: string,
    sender: ShareImportSender | undefined,
  ): Promise<ShareImportConfirmReply> => {
    if (!isExtensionPageSender(sender)) {
      return { kind: "share-import-result", status: "failed", reason: "forbidden" }
    }
    const entry = requests.get(token)
    if (entry === undefined || entry.state !== "awaiting-confirm") {
      return { kind: "share-import-result", status: "failed", reason: "expired" }
    }
    if ((await consent()) !== "granted") {
      return { kind: "share-import-result", status: "failed", reason: "consent-required" }
    }
    const result = await ensureSnapshot(token, entry)
    if (result.kind === "error") {
      return { kind: "share-import-result", status: "failed", reason: DETAIL_ERRORS[result.reason] }
    }
    const committed = await commitImport({
      repository: deps.repository,
      driver: deps.driver,
      response: result.response,
      operationId: entry.requestId,
      newId,
      now,
    })
    if (committed.kind === "committed") {
      requests.settle(token, "committed")
      // Task 18: fire-and-forget aggregate notification AFTER the local commit
      // only. It must never block the reply or undo the saved playlist.
      // Task 22: re-check consent first — a revocation raced in during the
      // commit must stop even this anonymous POST.
      void (async () => {
        if ((await consent()) !== "granted") return
        await notifyImport(entry.shareId)
      })().catch(() => undefined)
      return {
        kind: "share-import-result",
        status: "committed",
        playlistId: committed.playlistId,
        title: result.response.playlist.title,
      }
    }
    requests.settle(token, "failed")
    return { kind: "share-import-result", status: "failed", reason: committed.reason }
  }

  const cancel = async (
    token: string,
    sender: ShareImportSender | undefined,
  ): Promise<ShareImportConfirmReply> => {
    if (!isExtensionPageSender(sender)) {
      return { kind: "share-import-result", status: "failed", reason: "forbidden" }
    }
    requests.settle(token, "cancelled")
    return { kind: "share-import-result", status: "cancelled" }
  }

  return (
    message: unknown,
    sender: ShareImportSender | undefined,
  ): Promise<unknown> | undefined => {
    const parsed = parseShareImportMessage(message)
    if (parsed === undefined) return undefined
    switch (parsed.kind) {
      case "share-import-request":
        return begin(parsed, sender)
      case "share-import-details":
        return details(parsed.token, sender)
      case "share-import-confirm":
        return confirm(parsed.token, sender)
      case "share-import-cancel":
        return cancel(parsed.token, sender)
      case "share-import-consent":
        return onConsent(parsed, sender)
    }
  }
}
