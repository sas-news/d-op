import type { ApiErrorCode, ApiErrorDetails } from "../../../../../packages/shared/src/index"

// Fixed response envelopes for /api/v1/playlists (task 13). Success is
// `{data}`; failure is `{error:{code,message,requestId,details?}}` where
// details carries validated field paths or the authenticated conflict
// revision only — never raw bodies, secrets or SQL. Every response is
// `Cache-Control: no-store`: capability responses must never be stored, and
// snapshots must not be shared-cached (unlisted links stay unlisted).

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const

const NO_STORE_HEADERS = { "cache-control": "no-store" } as const

export function newRequestId(): string {
  return crypto.randomUUID()
}

export function dataResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify({ data }), { status, headers: JSON_HEADERS })
}

export function errorResponse(input: {
  readonly status: number
  readonly code: ApiErrorCode
  readonly message: string
  readonly requestId: string
  readonly details?: ApiErrorDetails | undefined
}): Response {
  const error = {
    code: input.code,
    message: input.message,
    requestId: input.requestId,
    ...(input.details !== undefined ? { details: input.details } : {}),
  }
  return new Response(JSON.stringify({ error }), {
    status: input.status,
    headers: JSON_HEADERS,
  })
}

/** 204 No Content for DELETE and import acknowledgement — still no-store. */
export function noContentResponse(): Response {
  return new Response(null, { status: 204, headers: NO_STORE_HEADERS })
}

export function notFound(requestId: string): Response {
  return errorResponse({
    status: 404,
    code: "NOT_FOUND",
    message: "no such publication",
    requestId,
  })
}

export function unauthorized(requestId: string): Response {
  return errorResponse({
    status: 401,
    code: "UNAUTHORIZED",
    message: "missing or invalid manage capability",
    requestId,
  })
}

/** 405 for methods outside a route's contract surface, with Allow. */
export function methodNotAllowed(allow: readonly string[], requestId: string): Response {
  const body = JSON.stringify({
    error: {
      code: "METHOD_NOT_ALLOWED" satisfies ApiErrorCode,
      message: "method not allowed on this resource",
      requestId,
    },
  })
  return new Response(body, {
    status: 405,
    headers: { ...JSON_HEADERS, allow: allow.join(", ") },
  })
}

/**
 * Uniform 503 for repository/storage-layer failures and unexpected throws.
 * The thrown error is deliberately not logged here: application logging with
 * redacted fields is task-14 scope, and error objects may contain SQL text.
 */
export function transientFailure(requestId: string): Response {
  return errorResponse({
    status: 503,
    code: "TRANSIENT_FAILURE",
    message: "temporary storage failure; retry the request",
    requestId,
  })
}
