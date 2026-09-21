import { env } from "cloudflare:workers"
import type { RateLimiterBinding } from "../../src/server/security/rate-limit.js"

// Security-suite helpers: env overrides (Miniflare env is a mutable bindings
// object — verified at runtime), fake rate-limit bindings that record the
// keys they were consulted with, and request builders carrying Origin /
// cf-connecting-ip headers. Route handlers are invoked directly, the same way
// the publication-api suite does; middleware/header composition is tested via
// applySecurityHeaders + onRequest directly.
export {
  API,
  apiRequest,
  call,
  dataOf,
  db,
  envelopeOf,
  errorOf,
  makePlaylist,
  migratedDb,
  publishPlaylist,
} from "../publication-api/helpers.js"

/** Temporarily set/remove env bindings; returns a restore function. */
export function overrideEnv(overrides: Record<string, unknown>): () => void {
  const record = env as unknown as Record<string, unknown>
  const saved = new Map<string, unknown>()
  for (const key of Object.keys(overrides)) {
    saved.set(key, record[key])
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete record[key]
    else record[key] = value
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete record[key]
      else record[key] = value
    }
  }
}

export type RecordedLimitCall = { readonly key: string }

export type FakeLimiter = {
  readonly binding: RateLimiterBinding
  readonly calls: string[]
}

/**
 * A rate-limit binding stand-in that records every key it was consulted with
 * and answers per `plan`: a fixed success flag or a function (which may throw
 * to simulate a limiter outage).
 */
export function fakeLimiter(
  plan: boolean | ((key: string, callIndex: number) => boolean | Promise<boolean>),
): FakeLimiter {
  const calls: string[] = []
  const binding: RateLimiterBinding = {
    limit: async ({ key }) => {
      calls.push(key)
      const success = typeof plan === "function" ? await plan(key, calls.length - 1) : plan
      return { success }
    },
  }
  return { binding, calls }
}

/** Sets every binding the admission path may consult in one override. */
export function withLimiters(
  limiters: Partial<{
    api: RateLimiterBinding
    create: RateLimiterBinding
    mutation: RateLimiterBinding
    import: RateLimiterBinding
    read: RateLimiterBinding
  }>,
  extra: Record<string, unknown> = {},
): () => void {
  return overrideEnv({
    RATE_LIMIT_API: limiters.api,
    RATE_LIMIT_CREATE: limiters.create,
    RATE_LIMIT_MUTATION: limiters.mutation,
    RATE_LIMIT_IMPORT: limiters.import,
    RATE_LIMIT_READ: limiters.read,
    ...extra,
  })
}

export type RequestOptions = {
  readonly method: string
  readonly path: string
  readonly body?: unknown
  readonly origin?: string
  readonly ip?: string
  readonly bearer?: string | null
  readonly idempotencyKey?: string | null
}

/** Builds an API request with explicit Origin / client-IP headers. */
export function secureRequest(init: RequestOptions): Request {
  const headers = new Headers()
  if (init.bearer != null) headers.set("authorization", `Bearer ${init.bearer}`)
  if (init.idempotencyKey != null) headers.set("idempotency-key", init.idempotencyKey)
  if (init.origin !== undefined) headers.set("origin", init.origin)
  if (init.ip !== undefined) headers.set("cf-connecting-ip", init.ip)
  let body: string | undefined
  if (init.body !== undefined) {
    headers.set("content-type", "application/json")
    body = typeof init.body === "string" ? init.body : JSON.stringify(init.body)
  }
  return new Request(`https://d-op.sasnews.dev/api/v1/playlists${init.path}`, {
    method: init.method,
    headers,
    body: body ?? null,
  })
}
