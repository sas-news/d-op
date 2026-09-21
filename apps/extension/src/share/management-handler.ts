// Background entry point for publication management (task 15). Only the
// privileged options page may initiate management — content scripts, web
// pages and other extension surfaces get `forbidden`. The handler parses the
// typed message, delegates to the flow, and converts any internal throw into
// a bounded `failed` reply so sendMessage never rejects into the page.
import type { StorageDriver } from "../storage/driver"
import type { LocalRepository } from "../storage/repository"
import type { FetchLike } from "./api-client"
import { type DataPermissions, effectiveShareConsent } from "./consent"
import { createShareManagementFlow } from "./management-flow"
import { parseShareManageMessage, type ShareManageReply } from "./management-protocol"

export type ShareManageSender = {
  readonly id?: string | undefined
  readonly url?: string | undefined
  readonly origin?: string | undefined
  readonly frameId?: number | undefined
  readonly tab?: { readonly id?: number | undefined; readonly url?: string | undefined } | undefined
}

export type ShareManagementHandlerDeps = {
  readonly repository: LocalRepository
  readonly extensionId: string
  /** e.g. `new URL(browser.runtime.getURL("/")).origin` */
  readonly extensionOrigin: string
  /** Pathname of the privileged management surface (default /options.html). */
  readonly optionsPath?: string
  /** Import-provenance store — enables derivedFrom resolution on publish. */
  readonly driver?: StorageDriver
  /**
   * Task 22: Firefox ≥140 built-in data-consent probe (browser.permissions).
   * Absent → the persisted in-extension decision alone gates Share traffic.
   */
  readonly dataPermissions?: DataPermissions
  readonly apiOrigin?: string
  readonly fetchImpl?: FetchLike
  readonly now?: () => string
  readonly newId?: () => string
}

const FORBIDDEN: ShareManageReply = { kind: "share-manage-result", status: "forbidden" }
const FAILED: ShareManageReply = { kind: "share-manage-result", status: "failed" }
const CONSENT: ShareManageReply = { kind: "share-manage-result", status: "consent-required" }

export function createShareManagementHandler(deps: ShareManagementHandlerDeps) {
  const flow = createShareManagementFlow(deps)
  const optionsPath = deps.optionsPath ?? "/options.html"

  // chrome-extension:// is a non-special scheme — URL.parse reports origin
  // "null" under Node/Bun but the extension origin inside Chromium. Compare
  // by prefix instead: identical across runtimes and equally strict.
  const optionsUrl = `${deps.extensionOrigin}${optionsPath}`
  const isOptionsSender = (sender: ShareManageSender | undefined): boolean => {
    if (sender === undefined || sender.id !== deps.extensionId) return false
    if (sender.frameId !== undefined && sender.frameId !== 0) return false
    if (typeof sender.url !== "string") return false
    return (
      sender.url === optionsUrl ||
      sender.url.startsWith(`${optionsUrl}?`) ||
      sender.url.startsWith(`${optionsUrl}#`)
    )
  }

  return (
    message: unknown,
    sender: ShareManageSender | undefined,
  ): Promise<ShareManageReply> | undefined => {
    const parsed = parseShareManageMessage(message)
    if (parsed === undefined) return undefined
    if (!isOptionsSender(sender)) return Promise.resolve(FORBIDDEN)
    const run = async (): Promise<ShareManageReply> => {
      // Task 22 consent gate: EVERY management operation touches the Share
      // API (even the provenance preview can issue a parent GET). Until the
      // user explicitly grants — and on Firefox ≥140 keeps the declared data
      // categories granted — the privileged page gets a bounded
      // consent-required reply and zero bytes leave the browser.
      if ((await effectiveShareConsent(deps.repository, deps.dataPermissions)) !== "granted") {
        return CONSENT
      }
      switch (parsed.kind) {
        case "share-manage-publish":
          return flow.publish(parsed)
        case "share-manage-activate":
          return flow.activate(parsed)
        case "share-manage-update":
          return flow.update(parsed)
        case "share-manage-delete":
          return flow.deleteRemote(parsed)
        case "share-manage-inspect":
          return flow.inspect(parsed.shareId)
        case "share-manage-source":
          return flow.source(parsed.playlistId)
      }
    }
    return run().catch(() => FAILED)
  }
}
