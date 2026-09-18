import { defineConfig } from "vitest/config"

// Task 2 unit orchestration: real selected checks over shared + extension + web unit suites.
// Extra CLI args (e.g. a filename filter) are forwarded by `bun run test:unit -- <filter>`,
// and a filter matching nothing must exit nonzero (no silent green).
export default defineConfig({
  test: {
    include: [
      "packages/shared/tests/**/*.test.ts",
      "apps/extension/tests/**/*.test.ts",
      "apps/web/tests/unit/**/*.test.ts",
    ],
    environment: "node",
    passWithNoTests: false,
  },
})
