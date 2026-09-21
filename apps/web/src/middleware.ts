import type { MiddlewareHandler } from "astro"
import { applySecurityHeaders } from "./server/security/headers"

// Applies the fixed security header set (CSP, Referrer-Policy: no-referrer,
// nosniff, frame denial, Permissions-Policy) to every response the Worker
// renders — SSR pages, API envelopes and error responses alike. Static assets
// are covered by the identical policy in public/_headers.
export const onRequest: MiddlewareHandler = async (_context, next) => {
  return applySecurityHeaders(await next())
}
