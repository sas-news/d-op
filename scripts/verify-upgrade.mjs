#!/usr/bin/env node
// verify:upgrade — task 26 installed-profile migration/rollback rehearsal.
//
//   bun run verify:upgrade -- --browser=chromium
//   bun run verify:upgrade -- --browser=firefox [--channel=stable|esr]
//
// Thin dispatcher: selects the browser leg under tests/browser/upgrade/ and
// forwards the remaining args. Each leg is self-contained: it extracts the
// v1.0.0 extension from the git baseline, seeds every legacy fixture through
// v1's own write helpers on a DISPOSABLE profile, swaps the same unpacked
// directory to the built v2 (same unpacked-path / gecko identity), asserts
// the full migration against the shared parser oracle, rehearses restart
// persistence, detached management keys, export→wipe→re-import recovery and
// the fault legs, then rolls back to v1.
//
// What this does NOT prove (recorded as an explicit limitation, not faked):
// production store signing / update continuity — Chrome Web Store
// mcjkaoagedekadnimbcbkhdkgpbnnodc and Firefox AMO d-op@sasnews.dev use
// signed-update channels this rehearsal cannot exercise without the real
// signing credentials. The same-identity invariant proven here is the
// unpacked-path id (Chromium) and the gecko id (Firefox).

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function usage(message) {
  console.error(`verify-upgrade: ${message}`)
  console.error(
    "usage: bun run verify:upgrade -- --browser=chromium|firefox [--channel=...] [--headed] [--keep] [--allow-download]",
  )
  process.exit(2)
}

const args = process.argv.slice(2)
const browserArg = args.find((a) => a.startsWith("--browser="))
const browser = browserArg?.slice("--browser=".length)
if (browser !== "chromium" && browser !== "firefox") {
  usage("--browser=chromium|firefox is required")
}
const forwarded = args.filter((a) => !a.startsWith("--browser="))
const leg = path.join(REPO, "tests/browser/upgrade", `${browser}.mjs`)

// Always bun: the legs import the shared .ts seed/oracle modules directly.
const child = spawn("bun", [leg, ...forwarded], {
  cwd: REPO,
  stdio: "inherit",
  env: process.env,
})
child.once("exit", (code, signal) => {
  if (signal) process.exitCode = 2
  else process.exitCode = code ?? 2
})
child.once("error", (error) => {
  console.error(error?.stack ?? error)
  process.exitCode = 2
})
