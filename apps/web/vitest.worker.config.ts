import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

// Task 5 worker D1 harness: suites run inside the workerd runtime with a real
// isolated per-file D1 database (Miniflare on SQLite). Fake repositories and
// in-memory fallbacks are forbidden; a missing binding stays a named error.
// Extra CLI args are forwarded by `bun run test:worker -- <filter>`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Minimal test-only wrangler config: the production wrangler.jsonc's
      // `assets: ./dist` made workerd hold a directory handle on dist, which
      // broke concurrent `astro build` runs (EPERM on rmdirSync) whenever a
      // Playwright webServer built the site during a worker-test session.
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        compatibilityDate: "2026-09-01",
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        d1Databases: ["DB"],
        // Real rate-limit binding for the security suite: no route consults
        // RATE_LIMIT_PROBE directly — tests pass it to consultLimiter() to
        // prove the binding wiring against real Miniflare, and inject fakes
        // into env for the failure paths.
        ratelimits: {
          RATE_LIMIT_PROBE: { namespace_id: "dop-test-probe", simple: { limit: 1, period: 60 } },
        },
      },
    }),
  ],
  root: import.meta.dirname,
  test: {
    include: [
      "tests/worker/**/*.test.ts",
      "tests/repository/**/*.test.ts",
      "tests/publication-api/**/*.test.ts",
      "tests/security/**/*.test.ts",
      "tests/share-page/**/*.test.ts",
    ],
    reporters: ["default"],
    passWithNoTests: false,
  },
})
