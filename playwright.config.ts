import { defineConfig } from "@playwright/test"

// Task-5 Playwright harness. web-chromium runs the synthetic fixture suite now;
// web-firefox runs the same DOM/network fixture coverage; extension-chromium is
// scaffolding for later extension specs (tasks 9/10) and matches no files yet.
// Retries stay 0 so flakes surface instead of hiding; a missing browser binary
// is an explicit launch failure, never a skip (no test.skip on browser absence).
const FIXTURE_URL = "http://127.0.0.1:8123/harness.html"

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
      testMatch: /harness\.spec\.ts/,
      use: { browserName: "chromium" },
    },
    {
      name: "web-firefox",
      testMatch: /harness\.spec\.ts/,
      use: { browserName: "firefox" },
    },
    {
      name: "extension-chromium",
      testMatch: /extension-.*\.spec\.ts/,
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: "node ./tests/e2e/serve-fixture.mjs",
    url: FIXTURE_URL,
    timeout: 30_000,
    // biome-ignore lint/complexity/useLiteralKeys: brackets required by noPropertyAccessFromIndexSignature
    reuseExistingServer: !process.env["CI"],
    stdout: "pipe",
    stderr: "pipe",
  },
})
