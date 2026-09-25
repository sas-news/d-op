import type { MiddlewareHandler } from "astro"
import { applySecurityHeaders } from "./server/security/headers"

// Applies the fixed security header set (CSP, Referrer-Policy: no-referrer,
// nosniff, frame denial, Permissions-Policy) to every response the Worker
// renders — SSR pages, API envelopes and error responses alike. Static assets
// are covered by the identical policy in public/_headers.

// Plaintext HTTP is upgraded to HTTPS at the app edge. workers.dev serves
// both schemes and "Always Use HTTPS" is a zone toggle that cannot be relied
// on before the domain cutover — the Worker answers the upgrade itself.
// 308 keeps the method and body semantics on API mutations; loopback/local
// preview hosts are exempt (wrangler dev speaks plain http).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

export const onRequest: MiddlewareHandler = async (context, next) => {
  const url = new URL(context.request.url)
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) {
    url.protocol = "https:"
    return Response.redirect(url.toString(), 308)
  }
  return applySecurityHeaders(await next())
}
