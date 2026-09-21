// Task-15 publication management protocol between the privileged options page
// and the background worker. Requests carry intent only — the background
// builds the publish projection itself from canonical state, owns the vault
// record writes and performs every network call. Hand-validated (same
// convention as protocol.ts / ui/storage-client.ts); replies never carry
// manageSecret or snapshot internals.
import {
  SHARE_AUTHOR_MAX,
  SHARE_DESCRIPTION_MAX,
  SHARE_TAG_MAX,
  SHARE_TAGS_MAX,
  ShareIdSchema,
} from "../../../../packages/shared/src/limits"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value)

const isShareId = (value: unknown): value is string =>
  typeof value === "string" && ShareIdSchema.safeParse(value).success

const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1

// --- options page → background ------------------------------------------------

/** Publish metadata the options dialog may supply. Visibility is required on
 *  FIRST publish (explicit choice, no default) and optional on update —
 *  omitted fields preserve the acknowledged snapshot values. */
export type ShareManageMetadata = {
  readonly visibility?: "public" | "unlisted" | undefined
  readonly description?: string | undefined
  readonly author?: string | undefined
  readonly tags?: readonly string[] | undefined
}

export type ShareManagePublishRequest = {
  readonly kind: "share-manage-publish"
  /** UI-minted attempt id — also the durable pendingCreate key. */
  readonly operationId: string
  readonly playlistId: string
  readonly metadata: ShareManageMetadata & { readonly visibility: "public" | "unlisted" }
}

export type ShareManageActivateRequest = {
  readonly kind: "share-manage-activate"
  readonly shareId: string
  /** Idempotency-Key for the activate PATCH. */
  readonly operationId: string
}

export type ShareManageUpdateRequest = {
  readonly kind: "share-manage-update"
  readonly shareId: string
  /** Idempotency-Key for the replace PATCH; reused on lost-response retry. */
  readonly operationId: string
  readonly metadata?: ShareManageMetadata
  /** Explicit expectedRevision override after inspecting a conflict. */
  readonly expectedRevision?: number
}

export type ShareManageDeleteRequest = {
  readonly kind: "share-manage-delete"
  readonly shareId: string
  readonly operationId: string
  readonly expectedRevision?: number
}

export type ShareManageInspectRequest = {
  readonly kind: "share-manage-inspect"
  readonly shareId: string
}

export type ShareManageRequest =
  | ShareManagePublishRequest
  | ShareManageActivateRequest
  | ShareManageUpdateRequest
  | ShareManageDeleteRequest
  | ShareManageInspectRequest

function parseMetadata(input: unknown): ShareManageMetadata | undefined {
  if (!isRecord(input)) return undefined
  const out: Record<string, unknown> = {}
  for (const key of ["visibility", "description", "author", "tags"] as const) {
    const value = input[key]
    if (value === undefined) continue
    switch (key) {
      case "visibility":
        if (value !== "public" && value !== "unlisted") return undefined
        out["visibility"] = value
        break
      case "description":
        if (typeof value !== "string" || value.length > SHARE_DESCRIPTION_MAX) return undefined
        out["description"] = value
        break
      case "author":
        if (typeof value !== "string" || value.length > SHARE_AUTHOR_MAX) return undefined
        out["author"] = value
        break
      case "tags":
        if (
          !Array.isArray(value) ||
          value.length > SHARE_TAGS_MAX ||
          !value.every((tag) => typeof tag === "string" && tag.length <= SHARE_TAG_MAX)
        ) {
          return undefined
        }
        out["tags"] = value
        break
    }
  }
  return out as ShareManageMetadata
}

export function parseShareManageMessage(input: unknown): ShareManageRequest | undefined {
  if (!isRecord(input)) return undefined
  switch (input["kind"]) {
    case "share-manage-publish": {
      const metadata = parseMetadata(input["metadata"])
      if (
        !isUuid(input["operationId"]) ||
        typeof input["playlistId"] !== "string" ||
        input["playlistId"].length === 0 ||
        input["playlistId"].length > 256 ||
        metadata === undefined ||
        metadata.visibility === undefined
      ) {
        return undefined
      }
      return input as unknown as ShareManagePublishRequest
    }
    case "share-manage-activate":
      if (!isShareId(input["shareId"]) || !isUuid(input["operationId"])) return undefined
      return input as unknown as ShareManageActivateRequest
    case "share-manage-update": {
      const metadata = input["metadata"] === undefined ? {} : parseMetadata(input["metadata"])
      if (
        !isShareId(input["shareId"]) ||
        !isUuid(input["operationId"]) ||
        metadata === undefined ||
        (input["expectedRevision"] !== undefined && !isRevision(input["expectedRevision"]))
      ) {
        return undefined
      }
      return input as unknown as ShareManageUpdateRequest
    }
    case "share-manage-delete":
      if (
        !isShareId(input["shareId"]) ||
        !isUuid(input["operationId"]) ||
        (input["expectedRevision"] !== undefined && !isRevision(input["expectedRevision"]))
      ) {
        return undefined
      }
      return input as unknown as ShareManageDeleteRequest
    case "share-manage-inspect":
      if (!isShareId(input["shareId"])) return undefined
      return input as unknown as ShareManageInspectRequest
    default:
      return undefined
  }
}

// --- background → options page -------------------------------------------------

export type ShareManageRemoteState = "active" | "absent" | "unknown"

export type ShareManageStatus =
  | "published"
  | "activated"
  | "updated"
  | "unchanged"
  | "deleted"
  | "already-absent"
  | "activate-pending"
  | "persist-failed"
  | "receipt-unavailable"
  | "unpublishable"
  | "conflict"
  | "not-found"
  | "offline"
  | "invalid-state"
  | "forbidden"
  | "failed"
  | "inspect"

export const SHARE_MANAGE_STATUSES: readonly ShareManageStatus[] = [
  "published",
  "activated",
  "updated",
  "unchanged",
  "deleted",
  "already-absent",
  "activate-pending",
  "persist-failed",
  "receipt-unavailable",
  "unpublishable",
  "conflict",
  "not-found",
  "offline",
  "invalid-state",
  "forbidden",
  "failed",
  "inspect",
]

export type ShareManageReason = { readonly path: string; readonly message: string }

/** Bounded reply — the secret, sentSnapshot and hashes never cross. */
export type ShareManageReply = {
  readonly kind: "share-manage-result"
  readonly status: ShareManageStatus
  readonly shareId?: string
  readonly url?: string
  readonly revision?: number
  readonly remoteRevision?: number
  readonly remote?: ShareManageRemoteState
  readonly remoteUpdatedAt?: string
  /** Remote snapshot differs from the acknowledged hash (inspect only). */
  readonly diverged?: boolean
  readonly reasons?: readonly ShareManageReason[]
  readonly message?: string
}

export function isShareManageReply(input: unknown): input is ShareManageReply {
  if (!isRecord(input) || input["kind"] !== "share-manage-result") return false
  const status = input["status"]
  return typeof status === "string" && (SHARE_MANAGE_STATUSES as readonly string[]).includes(status)
}

// --- options-page client --------------------------------------------------------

type SendMessage = (message: unknown) => Promise<unknown>

export type ShareManageClient = {
  readonly publish: (request: Omit<ShareManagePublishRequest, "kind">) => Promise<ShareManageReply>
  readonly activate: (
    request: Omit<ShareManageActivateRequest, "kind">,
  ) => Promise<ShareManageReply>
  readonly update: (request: Omit<ShareManageUpdateRequest, "kind">) => Promise<ShareManageReply>
  readonly deleteRemote: (
    request: Omit<ShareManageDeleteRequest, "kind">,
  ) => Promise<ShareManageReply>
  readonly inspect: (request: Omit<ShareManageInspectRequest, "kind">) => Promise<ShareManageReply>
}

const MALFORMED: ShareManageReply = { kind: "share-manage-result", status: "failed" }

async function call(
  sendMessage: SendMessage,
  request: ShareManageRequest,
): Promise<ShareManageReply> {
  try {
    const reply = await sendMessage(request)
    return isShareManageReply(reply) ? reply : MALFORMED
  } catch {
    return MALFORMED
  }
}

export function createShareManageClient(sendMessage: SendMessage): ShareManageClient {
  return {
    publish: (request) => call(sendMessage, { kind: "share-manage-publish", ...request }),
    activate: (request) => call(sendMessage, { kind: "share-manage-activate", ...request }),
    update: (request) => call(sendMessage, { kind: "share-manage-update", ...request }),
    deleteRemote: (request) => call(sendMessage, { kind: "share-manage-delete", ...request }),
    inspect: (request) => call(sendMessage, { kind: "share-manage-inspect", ...request }),
  }
}
