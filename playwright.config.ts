import { defineConfig } from "@playwright/test"

// Task-5 Playwright harness plus task-4 Web shell coverage. web-chromium and
// web-firefox run the synthetic fixture suite plus the Astro SSR shell spec;
// extension-chromium is scaffolding for later extension specs (tasks 9/10) and
// matches no files yet.
// Retries stay 0 so flakes surface instead of hiding; a missing browser binary
// is an explicit launch failure, never a skip (no test.skip on browser absence).
const FIXTURE_URL = "http://127.0.0.1:8123/harness.html"
const WEB_PORT = process.env["DOP_WEB_PORT"] ?? "4321"
const WEB_URL = `http://127.0.0.1:${WEB_PORT}/`

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "web-chromium",
      testMatch: /web-shell\.spec\.ts|harness\.spec\.ts/,
      use: { browserName: "chromium" },
    },
    {
      name: "web-firefox",
      testMatch: /web-shell\.spec\.ts|harness\.spec\.ts/,
      use: { browserName: "firefox" },
    },
    {
      name: "extension-chromium",
      testMatch: /extension-.*\.spec\.ts/,
      use: { browserName: "chromium" },
    },
  ],
  webServer: [
    {
      command: "node ./tests/e2e/serve-fixture.mjs",
      url: FIXTURE_URL,
      timeout: 30_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Astro 7 detects agent environments and otherwise auto-backgrounds preview.
      // --ignore-lock explicitly keeps the foreground server under Playwright ownership.
      command: `bun run build && bunx astro preview --ignore-lock --host 127.0.0.1 --port ${WEB_PORT}`,
      url: WEB_URL,
      cwd: "apps/web",
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
})
