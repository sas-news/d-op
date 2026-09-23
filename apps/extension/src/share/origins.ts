// Canonical share-site origins for the task-17 import relay. The production
// origin is fixed — never derived from page data, URLs, or messages. Localhost
// dev origins exist ONLY inside `import.meta.env.MODE !== "production"`
// blocks: Vite statically replaces MODE, the minifier drops the dead block,
// and no localhost literal ever ships in a release bundle or manifest.

export const SHARE_ORIGIN = "https://d-op.sasnews.dev" as const
export const SHARE_PAGE_PATH_PREFIX = "/p/" as const

/** Exact origins the share relay/background accept (exact match, no prefix). */
export function allowedShareOrigins(): readonly string[] {
  const origins: string[] = [SHARE_ORIGIN]
  if (import.meta.env.MODE !== "production") {
    // Dev-server origins for local share-site development only. Dead-code
    // eliminated from release bundles — keep the literals inside this block.
    origins.push("http://localhost:4321", "http://127.0.0.1:4321")
  }
  return origins
}

/** Manifest `matches` for the share-site content script. */
export function shareContentScriptMatches(): string[] {
  return allowedShareOrigins().map((origin) => `${origin}${SHARE_PAGE_PATH_PREFIX}*`)
}

/**
 * Origin the background calls for Share API traffic. Production is fixed;
 * development builds (`wxt dev`, `wxt build --mode development`) point at the
 * local share site (wrangler dev / e2e webServer on :4321) so publish → /p/ →
 * import runs fully offline. Unit tests run under MODE="test" and keep the
 * production origin. The localhost literal stays inside the MODE guard —
 * dead-code eliminated from release bundles.
 */
export function shareApiOrigin(): string {
  if (import.meta.env.MODE === "development") return "http://127.0.0.1:4321"
  return SHARE_ORIGIN
}

/**
 * Absolute URL for a share-site page (`/explore`, `/privacy`, …) on the same
 * origin the API uses — dev builds link to the local site, release to prod.
 */
export function shareSiteUrl(path: `/${string}`): string {
  return `${shareApiOrigin()}${path}`
}

/** Public snapshot page URL for a shareId — shareable link, never carries keys. */
export function sharePageUrl(shareId: string, origin: string = shareApiOrigin()): string {
  return `${origin}${SHARE_PAGE_PATH_PREFIX}${shareId}`
}

/**
 * Parse `url` as a share page (`<origin>/p/<shareId>`). Returns the embedded
 * shareId when the origin is exactly an allowed share origin and the path is
 * `/p/<shareId>` (trailing slash tolerated, extra segments rejected);
 * otherwise undefined.
 */
export function shareIdFromPageUrl(
  url: string | undefined,
  origins: readonly string[] = allowedShareOrigins(),
): string | undefined {
  if (url === undefined) return undefined
  const parsed = URL.parse(url)
  if (parsed === null || !origins.includes(parsed.origin)) return undefined
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "")
  if (segments[0] !== "p" || segments.length !== 2) return undefined
  return segments[1]
}
