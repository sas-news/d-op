import { defineConfig } from "@playwright/test"

// Task-5 Playwright harness plus task-4 Web shell coverage. web-chromium and
// web-firefox run the synthetic fixture suite plus the Astro SSR shell spec;
// extension-chromium loads the real unpacked WXT output for extension acceptance.
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
      testMatch:
        /web-shell\.spec\.ts|harness\.spec\.ts|adapter-bridge\.spec\.ts|csp\.spec\.ts|share-page\.spec\.ts|landing\.spec\.ts|discover\.spec\.ts|accessibility\.spec\.ts/,
      // The preview server's read rate limiter keys on cf-connecting-ip: give
      // each project a distinct TEST-NET-2 address so the two web suites do
      // not share one 120-req/60s bucket (the serial crawl in landing.spec
      // alone approaches the cap).
      use: {
        browserName: "chromium",
        extraHTTPHeaders: { "cf-connecting-ip": "198.51.100.23" },
      },
    },
    {
      name: "web-firefox",
      testMatch:
        /web-shell\.spec\.ts|harness\.spec\.ts|adapter-bridge\.spec\.ts|share-page\.spec\.ts|landing\.spec\.ts|accessibility\.spec\.ts/,
      use: {
        browserName: "firefox",
        extraHTTPHeaders: { "cf-connecting-ip": "198.51.100.24" },
      },
    },
    {
      name: "extension-chromium",
      testMatch: /extension-.*\.spec\.ts/,
      use: { browserName: "chromium" },
    },
  ],
  webServer: [
    {
      command:
        "cd apps/extension && bunx wxt build --browser chrome && bunx wxt build --browser firefox && cd ../.. && node ./tests/e2e/serve-fixture.mjs",
      url: FIXTURE_URL,
      // Two cold WXT builds run inside this window; parallel workers can push
      // a cold build well past 30 s, so keep real headroom.
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Astro 7 detects agent environments and otherwise auto-backgrounds preview.
      // --ignore-lock explicitly keeps the foreground server under Playwright ownership.
      // .dev.vars (gitignored) enables the /fixtures/shell demo page, which
      // production never exposes. The Cloudflare vite plugin folds it into
      // dist/server/.dev.vars at BUILD time, so it must exist before `build`.
      command: `printf 'DOP_FIXTURE_PAGE=true\\n' > .dev.vars && bun run build && bunx astro preview --ignore-lock --host 127.0.0.1 --port ${WEB_PORT}`,
      url: WEB_URL,
      cwd: "apps/web",
      // Cold `astro build` (types + two vite passes) plus preview startup can
      // exceed 60 s when another worker is building concurrently.
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
})
