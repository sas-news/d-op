import { env } from "cloudflare:workers"
import type { APIRoute } from "astro"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { POST as importRoute } from "../../src/pages/api/v1/playlists/[shareId]/import.js"
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "../../src/pages/api/v1/playlists/[shareId].js"
import { POST as createRoute } from "../../src/pages/api/v1/playlists/index.js"
import type { RateLimiterBinding } from "../../src/server/security/rate-limit.js"
import { consultLimiter } from "../../src/server/security/rate-limit.js"
import { publishPlaylist } from "../publication-api/helpers.js"
import {
  call,
  errorOf,
  fakeLimiter,
  makePlaylist,
  migratedDb,
  overrideEnv,
  secureRequest,
  withLimiters,
} from "./helpers.js"

// Given: every API route consults its class rate-limit binding plus the
// route-wide protective binding, failing safe on limiter outage (503) or a
// missing binding in a required deployment (503) and refusing with
// 429+Retry-After when a limiter denies. Dev/test mode leaves absent bindings
// permissive so fakes can be injected explicitly — never silently disabled in
// production (wrangler.jsonc declares DOP_RATE_LIMIT_REQUIRED="true").
// Then: the cases below pin each verdict, the per-class binding selection and
// the privacy property that limiter keys never contain raw IPs.

const SENTINEL_IP = "203.0.113.77"

describe("rate-limit admission", () => {
  let restore: (() => void) | undefined

  beforeAll(async () => {
    await migratedDb()
  })

  afterEach(() => {
    restore?.()
    restore = undefined
  })

  it("consults the route-wide then per-class binding on create", async () => {
    const api = fakeLimiter(true)
    const create = fakeLimiter(true)
    restore = withLimiters({ api: api.binding, create: create.binding })
    const response = await call(
      createRoute as APIRoute,
      secureRequest({
        method: "POST",
        path: "",
        body: makePlaylist({}),
        idempotencyKey: crypto.randomUUID(),
        ip: SENTINEL_IP,
      }),
    )
    expect(response.status).toBe(201)
    expect(api.calls).toHaveLength(1)
    expect(create.calls).toHaveLength(1)
    expect(api.calls[0]).toMatch(/^api:[0-9a-f]{64}$/)
    expect(create.calls[0]).toMatch(/^create:[0-9a-f]{64}$/)
    // Keys must never contain the raw client IP.
    expect(api.calls[0]).not.toContain(SENTINEL_IP)
    expect(create.calls[0]).not.toContain(SENTINEL_IP)
  })

  it("returns 429 with Retry-After when a class limiter refuses", async () => {
    const api = fakeLimiter(true)
    const create = fakeLimiter(false)
    restore = withLimiters({ api: api.binding, create: create.binding })
    const response = await call(
      createRoute as APIRoute,
      secureRequest({
        method: "POST",
        path: "",
        body: makePlaylist({}),
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("60")
    const error = await errorOf(response)
    expect(error.code).toBe("RATE_LIMITED")
  })

  it("returns 429 on route-wide refusal without reaching the class limiter", async () => {
    const api = fakeLimiter(false)
    const create = fakeLimiter(true)
    restore = withLimiters({ api: api.binding, create: create.binding })
    const response = await call(
      createRoute as APIRoute,
      secureRequest({
        method: "POST",
        path: "",
        body: makePlaylist({}),
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    expect(response.status).toBe(429)
    expect(create.calls).toHaveLength(0)
  })

  it("fails safe with 503 when the limiter throws (outage)", async () => {
    const api = fakeLimiter(() => Promise.reject(new Error("limiter backend down")))
    restore = withLimiters({ api: api.binding, create: fakeLimiter(true).binding })
    const response = await call(
      createRoute as APIRoute,
      secureRequest({
        method: "POST",
        path: "",
        body: makePlaylist({}),
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    expect(response.status).toBe(503)
    const error = await errorOf(response)
    expect(error.code).toBe("TRANSIENT_FAILURE")
    // The outage detail must not leak internals.
    expect(error.message).not.toContain("limiter backend")
  })

  it("fails safe with 503 when bindings are missing and protection is required", async () => {
    restore = overrideEnv({ DOP_RATE_LIMIT_REQUIRED: "true" })
    const response = await call(
      createRoute as APIRoute,
      secureRequest({
        method: "POST",
        path: "",
        body: makePlaylist({}),
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    expect(response.status).toBe(503)
    const error = await errorOf(response)
    expect(error.code).toBe("TRANSIENT_FAILURE")
  })

  it("allows a request in explicit non-required mode with no bindings", async () => {
    restore = overrideEnv({ DOP_RATE_LIMIT_REQUIRED: undefined })
    const response = await call(
      createRoute as APIRoute,
      secureRequest({
        method: "POST",
        path: "",
        body: makePlaylist({}),
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    expect(response.status).toBe(201)
  })

  it("limits authenticated mutations per share, not per actor", async () => {
    const api = fakeLimiter(true)
    const mutation = fakeLimiter(true)
    restore = withLimiters({ api: api.binding, mutation: mutation.binding })
    const published = await publishPlaylist(makePlaylist({}))
    // publishPlaylist's own activate PATCH already consulted the limiter;
    // only the calls from this point belong to the assertion.
    const baseline = mutation.calls.length
    const response = await call(
      patchRoute as APIRoute,
      secureRequest({
        method: "PATCH",
        path: `/${published.shareId}`,
        body: { operation: "activate", expectedRevision: 1 },
        bearer: published.manageSecret,
        idempotencyKey: crypto.randomUUID(),
        ip: SENTINEL_IP,
      }),
      { shareId: published.shareId },
    )
    expect(response.status).toBe(200)
    expect(mutation.calls.slice(baseline)).toEqual([`mutation:${published.shareId}`])
  })

  it("bounds repeated auth failures: wrong secrets 401 until the limiter 429s", async () => {
    // publishPlaylist's activate is the first consult; allow setup + two
    // auth-failed attempts, then refuse.
    const mutation = fakeLimiter((_key, callIndex) => callIndex < 3)
    restore = withLimiters({ api: fakeLimiter(true).binding, mutation: mutation.binding })
    const published = await publishPlaylist(makePlaylist({}))
    const wrongSecret = `${"A".repeat(43)}`
    const attempt = () =>
      call(
        patchRoute as APIRoute,
        secureRequest({
          method: "PATCH",
          path: `/${published.shareId}`,
          body: { operation: "activate", expectedRevision: 1 },
          bearer: wrongSecret,
          idempotencyKey: crypto.randomUUID(),
        }),
        { shareId: published.shareId },
      )
    const first = await attempt()
    const second = await attempt()
    const third = await attempt()
    expect(first.status).toBe(401)
    expect(second.status).toBe(401)
    expect(third.status).toBe(429)
    const error = await errorOf(third)
    expect(JSON.stringify(error)).not.toContain(wrongSecret)
    expect(JSON.stringify(error)).not.toContain(published.manageSecret)
    expect(JSON.stringify(error)).not.toContain(SENTINEL_IP)
  })

  it("consults the read binding on GET and the import binding on notify", async () => {
    const api = fakeLimiter(true)
    const read = fakeLimiter(true)
    const importLimiter = fakeLimiter(true)
    restore = withLimiters({
      api: api.binding,
      read: read.binding,
      import: importLimiter.binding,
    })
    const published = await publishPlaylist(makePlaylist({}))
    const getResponse = await call(
      getRoute as APIRoute,
      secureRequest({ method: "GET", path: `/${published.shareId}` }),
      { shareId: published.shareId },
    )
    expect(getResponse.status).toBe(200)
    expect(read.calls).toHaveLength(1)
    const importResponse = await call(
      importRoute as APIRoute,
      secureRequest({
        method: "POST",
        path: `/${published.shareId}/import`,
        body: { eventId: crypto.randomUUID() },
      }),
      { shareId: published.shareId },
    )
    expect(importResponse.status).toBe(204)
    expect(importLimiter.calls).toHaveLength(1)
    expect(importLimiter.calls[0]).toMatch(/^import:[0-9a-f]{64}$/)
  })

  it("delete also passes through the mutation limiter", async () => {
    // Allow the setup activate (call 0), refuse the DELETE (call 1).
    const mutation = fakeLimiter((_key, callIndex) => callIndex === 0)
    restore = withLimiters({ api: fakeLimiter(true).binding, mutation: mutation.binding })
    const published = await publishPlaylist(makePlaylist({}))
    const response = await call(
      deleteRoute as APIRoute,
      secureRequest({
        method: "DELETE",
        path: `/${published.shareId}`,
        body: { expectedRevision: 2 },
        bearer: published.manageSecret,
        idempotencyKey: crypto.randomUUID(),
      }),
      { shareId: published.shareId },
    )
    expect(response.status).toBe(429)
  })

  it("uses HMAC keys when RATE_LIMIT_HMAC_KEY is provisioned", async () => {
    const api = fakeLimiter(true)
    const create = fakeLimiter(true)
    restore = withLimiters(
      { api: api.binding, create: create.binding },
      { RATE_LIMIT_HMAC_KEY: "test-only-hmac-key" },
    )
    const response = await call(
      createRoute as APIRoute,
      secureRequest({
        method: "POST",
        path: "",
        body: makePlaylist({}),
        idempotencyKey: crypto.randomUUID(),
        ip: SENTINEL_IP,
      }),
    )
    expect(response.status).toBe(201)
    expect(create.calls[0]).toMatch(/^create:[0-9a-f]{64}$/)
    expect(create.calls[0]).not.toContain(SENTINEL_IP)
  })
})

describe("real Miniflare rate-limit binding", () => {
  it("RATE_LIMIT_PROBE returns success then refuses within the window", async () => {
    const probe = (env as unknown as Record<string, unknown>)["RATE_LIMIT_PROBE"] as
      | RateLimiterBinding
      | undefined
    expect(probe, "test ratelimits binding must be declared").toBeDefined()
    if (probe === undefined) return
    const key = `probe:${crypto.randomUUID()}`
    const first = await consultLimiter(probe, key)
    const second = await consultLimiter(probe, key)
    expect(first).toEqual({ allowed: true })
    // The probe binding is configured limit:1/period:60 — the second consult
    // in the same window is refused by the real workerd limiter.
    expect(second).toEqual({ allowed: false, reason: "limited" })
  })
})
