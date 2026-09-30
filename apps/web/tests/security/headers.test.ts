import type { APIContext, MiddlewareNext } from "astro"
import { describe, expect, it } from "vitest"
import staticHeaders from "../../public/_headers?raw"
import { onRequest } from "../../src/middleware.js"
import {
  applySecurityHeaders,
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
} from "../../src/server/security/headers.js"
import { errorResponse, methodNotAllowed, newRequestId } from "../../src/server/services/respond.js"

// Given: the fixed security header set is applied to every Worker-rendered
// response (SSR, API envelopes, errors) via middleware, and the identical
// policy ships in public/_headers for Cloudflare-served static assets.
// Then: CSP is strict (self-hosted assets only, no unsafe-eval/unsafe-inline,
// object-src/base-uri/frame-ancestors restricted), Referrer-Policy is
// no-referrer, nosniff is set, and existing response headers are preserved.

describe("security header set", () => {
  it("applies the full set to a plain response", () => {
    const response = applySecurityHeaders(new Response("<html></html>", { status: 200 }))
    const csp = response.headers.get("content-security-policy")
    expect(csp).toBe(CONTENT_SECURITY_POLICY)
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp).toContain(directive)
    }
    expect(csp).not.toContain("unsafe-eval")
    expect(csp).not.toContain("unsafe-inline")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains",
    )
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
    expect(response.headers.get("permissions-policy")).not.toBeNull()
    // No CORS surface is ever emitted.
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("preserves existing headers like no-store and Allow", () => {
    const base = errorResponse({
      status: 400,
      code: "BAD_REQUEST",
      message: "probe",
      requestId: newRequestId(),
    })
    const response = applySecurityHeaders(base)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY)

    const notAllowed = applySecurityHeaders(methodNotAllowed(["POST"], newRequestId()))
    expect(notAllowed.headers.get("allow")).toBe("POST")
    expect(notAllowed.status).toBe(405)
  })

  it("handles immutable-header responses (204, asset-style) without throwing", () => {
    const response = applySecurityHeaders(new Response(null, { status: 204 }))
    expect(response.status).toBe(204)
    expect(response.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY)
  })

  it("middleware applies the set to SSR and API-shaped responses", async () => {
    const context = {
      request: new Request("https://d-op.sasnews.dev/"),
    } as unknown as APIContext
    const next: MiddlewareNext = () => Promise.resolve(new Response("{}", { status: 200 }))
    // MiddlewareHandler's public type allows `void`; this handler always returns.
    const response = (await onRequest(context, next)) as Response
    expect(response.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY)
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  })
})

describe("static asset _headers parity", () => {
  it("public/_headers carries the identical CSP and companion headers", () => {
    expect(staticHeaders).toContain(`Content-Security-Policy: ${CONTENT_SECURITY_POLICY}`)
    expect(staticHeaders).toContain("Referrer-Policy: no-referrer")
    expect(staticHeaders).toContain(
      `Strict-Transport-Security: ${SECURITY_HEADERS["strict-transport-security"]}`,
    )
    expect(staticHeaders).toContain("X-Content-Type-Options: nosniff")
    expect(staticHeaders).toContain("X-Frame-Options: DENY")
    expect(staticHeaders).toContain(SECURITY_HEADERS["permissions-policy"] ?? "")
  })
})
