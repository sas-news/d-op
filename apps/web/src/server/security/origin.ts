// Fixed-origin transport policy for /api/v1/playlists (task 14).
//
// Callers legitimately arrive from three surfaces:
//   - the extension background/service worker, which sends NO Origin header
//     (or an extension-scheme Origin such as chrome-extension://...) and uses
//     fetch(..., {credentials:'omit'}) — there is no fixed extension id to
//     allowlist, so the scheme alone classifies the surface;
//   - the public web UI itself, whose same-origin page requests carry
//     `Origin: https://d-op.sasnews.dev` (or the preview/dev origin);
//   - non-browser callers (curl, wrangler, CI), which send no Origin.
//
// A browser cross-origin request cannot be distinguished from a non-browser
// caller merely by the Origin header, but it does not need to be: foreign
// origins are rejected on mutations only, reads stay public, and every caller
// still faces full capability/schema validation — Origin is transport policy,
// never authentication. No CORS response headers are ever emitted, so a
// foreign browser could not read a response anyway.
//
// "Same origin" is derived from the request URL itself rather than a compiled
// constant: the check is literally "did this request arrive on the origin the
// browser claims to call", which is correct for production, preview and dev
// alike and means no nonproduction origin override can leak into the
// production bundle.

export type OriginClass = "absent" | "extension" | "same-origin" | "foreign"

/**
 * Extension origins a WebExtension background page may legitimately carry.
 * Chrome and Firefox both use per-installation random ids, so only the scheme
 * is meaningful (a host allowlist is impossible by design).
 */
const EXTENSION_ORIGIN_SCHEMES: ReadonlySet<string> = new Set([
  "chrome-extension:",
  "moz-extension:",
  "safari-web-extension:",
])

export function classifyOrigin(request: Request): OriginClass {
  const header = request.headers.get("origin")
  // An empty Origin header carries no authority either; browsers never send
  // one, and treating it like an absent header keeps non-browser flows working.
  if (header === null || header.trim() === "") return "absent"
  const origin = URL.parse(header)
  // Unparseable or opaque origins ("null", "file://", multi-origin strings)
  // can never be proven same-origin — reject them on mutations.
  if (origin === null) return "foreign"
  if (EXTENSION_ORIGIN_SCHEMES.has(origin.protocol)) return "extension"
  if (origin.origin === new URL(request.url).origin) return "same-origin"
  return "foreign"
}

/**
 * Mutations (POST/PATCH/DELETE and import notification) are rejected when a
 * browser reports a foreign Origin. Status 400 keeps the failure inside the
 * fixed contract envelope (no dedicated code exists for transport rejections).
 */
export function foreignOriginMutation(request: Request): boolean {
  return classifyOrigin(request) === "foreign"
}
