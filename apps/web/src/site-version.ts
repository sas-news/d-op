import pkg from "../package.json"

/**
 * Site-facing version string — the single source is apps/web/package.json,
 * which the release flow keeps equal to apps/extension/package.json
 * (scripts/verify-artifacts.mjs asserts manifest/package equality). Used by
 * the brand badge and the JSON-LD softwareVersion.
 */
export const SITE_VERSION = pkg.version
