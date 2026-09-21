// Fixed-origin Share API fetch for the background worker (task 17). The URL is
// constructed from the validated shareId only — caller-supplied URLs are never
// accepted. Credentials are always omitted, redirects are errors, and the body
// is streamed through a hard byte cap before the strict zod schema runs.

import type { GetPlaylistResponse } from "../../../../packages/shared/src/api"
import { apiSuccessSchema, GetPlaylistResponseSchema } from "../../../../packages/shared/src/api"
import { SHARE_REQUEST_BODY_MAX_BYTES } from "../../../../packages/shared/src/limits"

export type FetchInit = {
  readonly method?: string
  readonly credentials?: RequestCredentials
  readonly redirect?: RequestRedirect
  readonly cache?: RequestCache
  readonly signal?: AbortSignal
  readonly headers?: HeadersInit
  readonly body?: BodyInit | null
}

export type FetchResponse = {
  readonly ok: boolean
  readonly status: number
  readonly headers: { readonly get: (name: string) => string | null }
  readonly body: ReadableStream<Uint8Array> | null
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>

export type ShareFetchResult =
  | { readonly kind: "ok"; readonly response: GetPlaylistResponse }
  | {
      readonly kind: "error"
      readonly reason:
        | "not-found"
        | "rate-limited"
        | "unavailable"
        | "invalid-response"
        | "too-large"
        | "network"
        | "timeout"
        | "share-mismatch"
      readonly status?: number
      readonly paths?: readonly string[]
    }

export type FetchSharedOptions = {
  readonly apiOrigin: string
  readonly shareId: string
  readonly fetchImpl?: FetchLike
  readonly maxBytes?: number
  readonly timeoutMs?: number
}

const ResponseEnvelopeSchema = apiSuccessSchema(GetPlaylistResponseSchema)

export async function readBoundedBody(
  response: FetchResponse,
  maxBytes: number,
): Promise<{ readonly kind: "ok"; readonly text: string } | { readonly kind: "too-large" }> {
  const declared = response.headers.get("content-length")
  if (declared !== null) {
    const parsed = Number.parseInt(declared, 10)
    if (Number.isFinite(parsed) && parsed > maxBytes) return { kind: "too-large" }
  }
  if (response.body === null) return { kind: "ok", text: "" }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel("share response exceeded the byte cap").catch(() => undefined)
        return { kind: "too-large" }
      }
      chunks.push(value)
    }
  } finally {
    void reader.cancel("done").catch(() => undefined)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { kind: "ok", text: new TextDecoder().decode(merged) }
}

export async function fetchSharedPlaylist(options: FetchSharedOptions): Promise<ShareFetchResult> {
  const fetchImpl = options.fetchImpl ?? (fetch as FetchLike)
  const maxBytes = options.maxBytes ?? SHARE_REQUEST_BODY_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? 15_000
  const url = `${options.apiOrigin}/api/v1/playlists/${options.shareId}`
  let response: FetchResponse
  try {
    response = await fetchImpl(url, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network"
    return { kind: "error", reason }
  }
  if (!response.ok) {
    const reason =
      response.status === 404
        ? "not-found"
        : response.status === 429
          ? "rate-limited"
          : response.status >= 500
            ? "unavailable"
            : "invalid-response"
    return { kind: "error", reason, status: response.status }
  }
  const body = await readBoundedBody(response, maxBytes)
  if (body.kind === "too-large") {
    return { kind: "error", reason: "too-large", status: response.status }
  }
  let json: unknown
  try {
    json = JSON.parse(body.text)
  } catch {
    return { kind: "error", reason: "invalid-response", status: response.status }
  }
  const parsed = ResponseEnvelopeSchema.safeParse(json)
  if (!parsed.success) {
    return {
      kind: "error",
      reason: "invalid-response",
      status: response.status,
      paths: parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
    }
  }
  if (parsed.data.data.shareId !== options.shareId) {
    return { kind: "error", reason: "share-mismatch", status: response.status }
  }
  return { kind: "ok", response: parsed.data.data }
}
