import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

// Task 2 worker orchestration: suites run inside the workerd runtime.
// Extra CLI args are forwarded by `bun run test:worker -- <filter>`.
export default defineConfig({
  plugins: [cloudflareTest({ miniflare: { compatibilityDate: "2026-09-01" } })],
  root: import.meta.dirname,
  test: {
    include: ["tests/worker/**/*.test.ts"],
    reporters: ["default"],
  },
})
