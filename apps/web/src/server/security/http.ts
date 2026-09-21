import {
  IdempotencyKeySchema,
  SHARE_REQUEST_BODY_MAX_BYTES,
  ShareIdSchema,
} from "../../../../../packages/shared/src/index"

// Request-intake guards for /api/v1/playlists (task 13): fixed JSON content
// type, a bounded byte stream read BEFORE JSON.parse, Idempotency-Key and
// shareId shape checks. Every failure maps to a fixed contract status; raw
// bodies are never echoed back into errors or logs.

export type IntakeFailure = {
  readonly status: 400 | 413 | 415
  readonly code: "BAD_REQUEST" | "BODY_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE"
  readonly message: string
}

export type JsonBodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly failure: IntakeFailure }

export type IdempotencyKeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly failure: IntakeFailure }

/** Requests carrying a JSON document must declare exactly application/json. */
export function jsonContentTypeFailure(request: Request): IntakeFailure | null {
  const contentType = request.headers.get("content-type")
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase()
  if (mediaType !== "application/json") {
    return {
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "request body must use content type application/json",
    }
  }
  return null
}

/**
 * Reads at most `maxBytes` from the request body stream — the cap is enforced
 * while reading, before any parse. A declared Content-Length over the cap fails
 * early, but the stream counter is authoritative (a lying header cannot
 * smuggle a larger body).
 */
export async function readBoundedUtf8(
  request: Request,
  maxBytes: number,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }> {
  const declared = request.headers.get("content-length")
  if (declared !== null) {
    const parsed = Number(declared)
    if (Number.isFinite(parsed) && parsed > maxBytes) return { ok: false }
  }
  const stream = request.body
  if (stream === null) return { ok: true, text: "" }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { ok: false }
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, text: new TextDecoder().decode(merged) }
}

/** Full intake pipeline for JSON routes: 415 -> 413 -> 400, in that order. */
export async function readJsonBody(request: Request): Promise<JsonBodyResult> {
  const typeFailure = jsonContentTypeFailure(request)
  if (typeFailure !== null) return { ok: false, failure: typeFailure }
  const body = await readBoundedUtf8(request, SHARE_REQUEST_BODY_MAX_BYTES)
  if (!body.ok) {
    return {
      ok: false,
      failure: {
        status: 413,
        code: "BODY_TOO_LARGE",
        message: "request body exceeds the share size limit",
      },
    }
  }
  try {
    return { ok: true, value: JSON.parse(body.text) as unknown }
  } catch {
    return {
      ok: false,
      failure: { status: 400, code: "BAD_REQUEST", message: "request body is not valid JSON" },
    }
  }
}

/** Idempotency-Key header: required UUID on every mutation route. */
export function readIdempotencyKey(request: Request): IdempotencyKeyResult {
  const parsed = IdempotencyKeySchema.safeParse(request.headers.get("idempotency-key"))
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        status: 400,
        code: "BAD_REQUEST",
        message: "Idempotency-Key header is required and must be a UUID",
      },
    }
  }
  return { ok: true, key: parsed.data }
}

/**
 * shareId route parameter: 22-char base64url. A malformed id can never match a
 * stored row, so callers map failure to 404 — an absent resource, not a
 * schema error (no existence oracle distinction is possible anyway).
 */
export function parseShareIdParam(param: string | undefined): string | null {
  const parsed = ShareIdSchema.safeParse(param)
  return parsed.success ? parsed.data : null
}
