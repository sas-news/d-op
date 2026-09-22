#!/usr/bin/env node
// e2e runner: web projects share one persisted local D1 (.wrangler/state).
// Parallel workers poison each other — concurrent `wrangler d1 execute`
// seeds, frozen discovery_snapshots (60 s first-page reuse), and the global
// import-count window all interleave nondeterministically. Web specs
// therefore run serialized in a single worker; the extension suite is
// fully route-mocked against https://d-op.sasnews.dev and stays parallel.
//
// `bun run test:e2e -- <args>` forwards args to a single playwright run so
// targeted smoke runs (e.g. `--project=web-chromium harness.spec.ts`) keep
// working without the two-phase split.
//
// The CLI is invoked through its JS entry under this same node runtime so
// no bunx/PATH shim resolution is needed on Windows.

import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const cli = require.resolve("@playwright/test/cli")
const args = process.argv.slice(2)

/** @param {string[]} extra */
const playwright = (extra) =>
  spawnSync(process.execPath, [cli, "test", ...extra], {
    stdio: "inherit",
    env: process.env,
  })

if (args.length > 0) {
  process.exit(playwright(args).status ?? 1)
}

const web = playwright(["--project=web-chromium", "--project=web-firefox", "--workers=1"])
const ext = playwright(["--project=extension-chromium"])

const webStatus = web.status ?? 1
const extStatus = ext.status ?? 1
process.exit(webStatus !== 0 ? webStatus : extStatus)
