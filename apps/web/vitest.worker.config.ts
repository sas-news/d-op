import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

// Task 5 worker D1 harness: suites run inside the workerd runtime with a real
// isolated per-file D1 database (Miniflare on SQLite). Fake repositories and
// in-memory fallbacks are forbidden; a missing binding stays a named error.
// Extra CLI args are forwarded by `bun run test:worker -- <filter>`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-09-01",
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        d1Databases: ["DB"],
      },
    }),
  ],
  root: import.meta.dirname,
  test: {
    include: ["tests/worker/**/*.test.ts"],
    reporters: ["default"],
    passWithNoTests: false,
  },
})
