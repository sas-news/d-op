// Background-owned Share API mutation client (task 15). Companion to
// api-client.ts (which owns the public GET): POST create, PATCH
// activate/replace and DELETE all run here — never in a page or content
// script. Every call hits the fixed API origin with credentials omitted,
// redirects rejected, a caller-minted Idempotency-Key, and a response body
// streamed through the shared byte cap before strict zod validation. The
// manageSecret travels only as a Bearer header — never in URLs or bodies.
import type { CreateAck, PatchAck, PatchPlaylistBody } from "../../../../packages/shared/src/api"
import {
  API_BASE_PATH,
  ApiErrorSchema,
  apiSuccessSchema,
  CreateAckSchema,
  IDEMPOTENCY_KEY_HEADER,
  PatchAckSchema,
} from "../../../../packages/shared/src/api"
import { SHARE_REQUEST_BODY_MAX_BYTES, ShareIdSchema } from "../../../../packages/shared/src/limits"
import type { SharedPlaylist } from "../../../../packages/shared/src/share-model"
import { checkShareBodySize } from "../../../../packages/shared/src/share-projection"
import { type FetchLike, type FetchResponse, readBoundedBody } from "./api-client"

export type ShareMutationErrorReason =
  | "unauthorized"
  | "not-found"
  | "revision-conflict"
  | "idempotency-conflict"
  | "receipt-unavailable"
  | "schema-invalid"
  | "unpublishable"
  | "unsupported-media-type"
  | "too-large"
  | "rate-limited"
  | "unavailable"
  | "invalid-response"
  | "network"
  | "timeout"

export type ShareMutationError = {
  readonly kind: "error"
  readonly reason: ShareMutationErrorReason
  readonly status?: number
  /** Authenticated conflict revision disclosed in `details` (409 only). */
  readonly remoteRevision?: number
  readonly paths?: readonly string[]
}

export type CreatePublicationResult =
  | { readonly kind: "ok"; readonly ack: CreateAck }
  | ShareMutationError
export type PatchPublicationResult =
  | { readonly kind: "ok"; readonly ack: PatchAck }
  | ShareMutationError
export type DeletePublicationResult = { readonly kind: "ok" } | ShareMutationError

export type ShareMutationOptions = {
  readonly apiOrigin: string
  readonly fetchImpl?: FetchLike
  readonly maxBytes?: number
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

const CreateEnvelopeSchema = apiSuccessSchema(CreateAckSchema)
const PatchEnvelopeSchema = apiSuccessSchema(PatchAckSchema)

function invalidShareId(shareId: string): boolean {
  return !ShareIdSchema.safeParse(shareId).success
}

async function send(
  options: ShareMutationOptions,
  init: {
    readonly method: string
    readonly path: string
    readonly secret?: string
    readonly idempotencyKey: string
    readonly body?: string
  },
): Promise<
  | { readonly kind: "ok"; readonly response: FetchResponse; readonly text: string }
  | ShareMutationError
> {
  const fetchImpl = options.fetchImpl ?? (fetch as FetchLike)
  const maxBytes = options.maxBytes ?? SHARE_REQUEST_BODY_MAX_BYTES
  if (init.body !== undefined) {
    try {
      checkShareBodySize(new TextEncoder().encode(init.body).byteLength)
    } catch {
      return { kind: "error", reason: "too-large" }
    }
  }
  const headers: Record<string, string> = { [IDEMPOTENCY_KEY_HEADER]: init.idempotencyKey }
  if (init.secret !== undefined) headers["authorization"] = `Bearer ${init.secret}`
  if (init.body !== undefined) headers["content-type"] = "application/json"
  let response: FetchResponse
  try {
    response = await fetchImpl(`${options.apiOrigin}${init.path}`, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network"
    return { kind: "error", reason }
  }
  const body = await readBoundedBody(response, maxBytes)
  if (body.kind === "too-large") {
    return { kind: "error", reason: "too-large", status: response.status }
  }
  return { kind: "ok", response, text: body.text }
}

/** Map a failure status (+ parsed error envelope when present) to a bounded reason. */
function errorResult(response: FetchResponse, text: string): ShareMutationError {
  let code: string | undefined
  let remoteRevision: number | undefined
  try {
    const parsed = ApiErrorSchema.safeParse(JSON.parse(text))
    if (parsed.success) {
      code = parsed.data.error.code
      const details = parsed.data.error.details
      if (
        details !== undefined &&
        !Array.isArray(details) &&
        typeof details.revision === "number"
      ) {
        remoteRevision = details.revision
      }
    }
  } catch {
    // Non-JSON error body — fall through to status-only mapping.
  }
  const base = { kind: "error" as const, status: response.status }
  switch (response.status) {
    case 401:
      return { ...base, reason: "unauthorized" }
    case 404:
      return { ...base, reason: "not-found" }
    case 409:
      if (code === "IDEMPOTENCY_CONFLICT") return { ...base, reason: "idempotency-conflict" }
      if (code === "CREATE_RECEIPT_UNAVAILABLE") return { ...base, reason: "receipt-unavailable" }
      return {
        ...base,
        reason: "revision-conflict",
        ...(remoteRevision === undefined ? {} : { remoteRevision }),
      }
    case 413:
      return { ...base, reason: "too-large" }
    case 415:
      return { ...base, reason: "unsupported-media-type" }
    case 422:
      return { ...base, reason: code === "UNPUBLISHABLE" ? "unpublishable" : "schema-invalid" }
    case 429:
      return { ...base, reason: "rate-limited" }
    default:
      return response.status >= 500
        ? { ...base, reason: "unavailable" }
        : { ...base, reason: "invalid-response" }
  }
}

type SafeParse<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false
      readonly error: { readonly issues: readonly { readonly path: readonly PropertyKey[] }[] }
    }

function parseSuccess<T>(
  response: FetchResponse,
  text: string,
  schema: { readonly safeParse: (input: unknown) => SafeParse<T> },
): { readonly kind: "ok"; readonly data: T } | ShareMutationError {
  if (!response.ok) return errorResult(response, text)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { kind: "error", reason: "invalid-response", status: response.status }
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    return {
      kind: "error",
      reason: "invalid-response",
      status: response.status,
      paths: parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
    }
  }
  return { kind: "ok", data: parsed.data }
}

/** POST /api/v1/playlists — provisional create; the only call that returns a key. */
export async function createPublication(
  options: ShareMutationOptions & {
    readonly playlist: SharedPlaylist
    readonly idempotencyKey: string
  },
): Promise<CreatePublicationResult> {
  const sent = await send(options, {
    method: "POST",
    path: API_BASE_PATH,
    idempotencyKey: options.idempotencyKey,
    body: JSON.stringify(options.playlist),
  })
  if (sent.kind === "error") return sent
  const parsed = parseSuccess(sent.response, sent.text, CreateEnvelopeSchema)
  if (parsed.kind === "error") return parsed
  return { kind: "ok", ack: parsed.data.data }
}

/** PATCH /api/v1/playlists/:shareId — activate or replace. */
export async function patchPublication(
  options: ShareMutationOptions & {
    readonly shareId: string
    readonly secret: string
    readonly operation: PatchPlaylistBody
    readonly idempotencyKey: string
  },
): Promise<PatchPublicationResult> {
  if (invalidShareId(options.shareId)) return { kind: "error", reason: "invalid-response" }
  const sent = await send(options, {
    method: "PATCH",
    path: `${API_BASE_PATH}/${options.shareId}`,
    secret: options.secret,
    idempotencyKey: options.idempotencyKey,
    body: JSON.stringify(options.operation),
  })
  if (sent.kind === "error") return sent
  const parsed = parseSuccess(sent.response, sent.text, PatchEnvelopeSchema)
  if (parsed.kind === "error") return parsed
  return { kind: "ok", ack: parsed.data.data }
}

/** DELETE /api/v1/playlists/:shareId — conditional remote delete (204). */
export async function deletePublication(
  options: ShareMutationOptions & {
    readonly shareId: string
    readonly secret: string
    readonly expectedRevision: number
    readonly idempotencyKey: string
  },
): Promise<DeletePublicationResult> {
  if (invalidShareId(options.shareId)) return { kind: "error", reason: "invalid-response" }
  const sent = await send(options, {
    method: "DELETE",
    path: `${API_BASE_PATH}/${options.shareId}`,
    secret: options.secret,
    idempotencyKey: options.idempotencyKey,
    body: JSON.stringify({ expectedRevision: options.expectedRevision }),
  })
  if (sent.kind === "error") return sent
  if (sent.response.status === 204) return { kind: "ok" }
  return errorResult(sent.response, sent.text)
}
