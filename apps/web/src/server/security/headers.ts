// Security response headers for every Worker-produced response (task 14):
// SSR pages, API envelopes and error paths all pass through here. Static
// assets get the identical policy from public/_headers, which Cloudflare's
// asset server applies itself — the two policies must stay identical, and a
// worker test pins that parity.
//
// CSP choice, honestly: the current surface ships no inline scripts and no
// inline style attributes, and astro.config.mjs forces
// `build.inlineStylesheets: "never"`, so every script/style is a self-hosted
// external file and strict `script-src 'self'` / `style-src 'self'` suffice —
// no 'unsafe-inline' or 'unsafe-eval' anywhere. Astro only emits inline
// <script> for `is:inline`/`define:vars` authoring, which this surface does
// not use; if a future page needs one, it must be a hashed script added to
// this policy, never unsafe-inline. `upgrade-insecure-requests` is deliberately
// omitted: it is not required by the plan and it would break plain-HTTP
// preview/e2e origins unnecessarily.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ")

// Referrer-Policy: no-referrer keeps share URLs (incl. unlisted shareIds) out
// of outbound referrers; nosniff prevents content sniffing of JSON/text
// payloads; frame-ancestors 'none' + X-Frame-Options DENY refuse embedding;
// Permissions-Policy turns off every feature surface this site never uses;
// HSTS pins the canonical https origin for two years so a first plaintext
// visit cannot be stripped. The `preload` token is deliberately absent —
// submission is a separate, permanent decision.
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=(), browsing-topics=()",
}

/**
 * Returns a copy of `response` with the security header set applied. The
 * response is always rebuilt: headers on fetch/asset Responses are immutable,
 * and existing headers (e.g. Cache-Control: no-store on API envelopes, Allow
 * on 405s) are preserved verbatim. No CORS headers are ever added.
 */
export function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
