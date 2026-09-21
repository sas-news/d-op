// Task-17 web→extension import protocol. Two surfaces, both one-way and
// minimal: (a) the share PAGE posts a typed request carrying ONLY shareId +
// correlation fields — never playlist JSON; (b) the content script replies
// with a status-only ack bound to requestId — never local library or
// publication state. Extension-internal messages (content script and the
// extension-owned import page → background) are validated by hand because
// they are not shared contracts (same convention as ui/storage-client.ts);
// zod is not resolvable from this workspace package.
import { ShareIdSchema } from "../../../../packages/shared/src/limits"

export const SHARE_PAGE_MESSAGE_SOURCE = "d-op-share-page" as const
export const SHARE_EXTENSION_MESSAGE_SOURCE = "d-op-extension" as const
export const SHARE_RELAY_VERSION = 1 as const

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

/** Strict-key check: the record must have exactly the expected keys. */
function hasOnlyKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(input)
  return actual.length === keys.length && keys.every((key) => key in input)
}

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value)

const isShareId = (value: unknown): value is string =>
  typeof value === "string" && ShareIdSchema.safeParse(value).success

// --- share page → content script (window.postMessage) ----------------------

export type SharePageImportRequest = {
  readonly source: typeof SHARE_PAGE_MESSAGE_SOURCE
  readonly type: "DOP_SHARE_IMPORT_REQUEST"
  readonly version: typeof SHARE_RELAY_VERSION
  readonly shareId: string
  readonly requestId: string
}

export function parseSharePageRequest(input: unknown): SharePageImportRequest | undefined {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["source", "type", "version", "shareId", "requestId"])
  ) {
    return undefined
  }
  if (
    input["source"] !== SHARE_PAGE_MESSAGE_SOURCE ||
    input["type"] !== "DOP_SHARE_IMPORT_REQUEST" ||
    input["version"] !== SHARE_RELAY_VERSION ||
    !isShareId(input["shareId"]) ||
    !isUuid(input["requestId"])
  ) {
    return undefined
  }
  return input as unknown as SharePageImportRequest
}

// --- content script → share page ack (window.postMessage) ------------------

export const SHARE_IMPORT_ACK_STATUSES = ["opened", "duplicate", "rejected", "unavailable"] as const
export type ShareImportAckStatus = (typeof SHARE_IMPORT_ACK_STATUSES)[number]

export type ShareImportAck = {
  readonly source: typeof SHARE_EXTENSION_MESSAGE_SOURCE
  readonly type: "DOP_SHARE_IMPORT_ACK"
  readonly version: typeof SHARE_RELAY_VERSION
  readonly requestId: string
  readonly status: ShareImportAckStatus
}

export function shareImportAck(requestId: string, status: ShareImportAckStatus): ShareImportAck {
  return {
    source: SHARE_EXTENSION_MESSAGE_SOURCE,
    type: "DOP_SHARE_IMPORT_ACK",
    version: SHARE_RELAY_VERSION,
    requestId,
    status,
  }
}

// --- extension-internal messages (content script / import page → background)

export type ShareImportRelayRequest = {
  readonly kind: "share-import-request"
  readonly shareId: string
  readonly requestId: string
}

export type ShareImportPageRequest = {
  readonly kind: "share-import-details" | "share-import-confirm" | "share-import-cancel"
  readonly token: string
}

export type ShareImportMessage = ShareImportRelayRequest | ShareImportPageRequest

export function parseShareImportMessage(input: unknown): ShareImportMessage | undefined {
  if (!isRecord(input)) return undefined
  const kind = input["kind"]
  if (kind === "share-import-request") {
    if (
      !hasOnlyKeys(input, ["kind", "shareId", "requestId"]) ||
      !isShareId(input["shareId"]) ||
      !isUuid(input["requestId"])
    ) {
      return undefined
    }
    return input as unknown as ShareImportRelayRequest
  }
  if (
    kind === "share-import-details" ||
    kind === "share-import-confirm" ||
    kind === "share-import-cancel"
  ) {
    if (!hasOnlyKeys(input, ["kind", "token"]) || !isUuid(input["token"])) return undefined
    return input as unknown as ShareImportPageRequest
  }
  return undefined
}

// --- background → callers ---------------------------------------------------

export type ShareImportBeginStatus = "opened" | "duplicate" | "rejected"
export type ShareImportBeginReply = {
  readonly kind: "share-import-begin"
  readonly status: ShareImportBeginStatus
}

export type ShareImportPreview = {
  readonly shareId: string
  readonly title: string
  readonly author: string
  readonly itemCount: number
  readonly totalDurationMs: number
  readonly revision: number
}

export type ShareImportDetailsReply =
  | { readonly kind: "share-import-preview"; readonly preview: ShareImportPreview }
  | { readonly kind: "share-import-error"; readonly reason: string }

export type ShareImportConfirmReply =
  | {
      readonly kind: "share-import-result"
      readonly status: "committed"
      readonly playlistId: string
      readonly title: string
    }
  | { readonly kind: "share-import-result"; readonly status: "failed"; readonly reason: string }
  | { readonly kind: "share-import-result"; readonly status: "cancelled" }

/** Validate the background→content-script reply before it becomes a page ack. */
export function parseShareImportBeginReply(input: unknown): ShareImportBeginStatus | undefined {
  if (!isRecord(input) || input["kind"] !== "share-import-begin") return undefined
  const status = input["status"]
  return status === "opened" || status === "duplicate" || status === "rejected" ? status : undefined
}
