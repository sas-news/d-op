#!/usr/bin/env node
// Task-23 real-Chrome harness — drives the SAME Playwright extension-chromium
// suite that CI runs, but retargeted at REAL Chrome binaries through the
// DOP_BROWSER_EXECUTABLE hook (tests/e2e/browser-target.ts). The bundled
// Playwright chromium is never a valid target here:
//
//   * --channel=stable   → Chrome for Testing stable (official release binary)
//   * --channel=previous → Chrome for Testing, last build of previous major
//   * --channel=all      → both legs sequentially
//
// Branded Chrome ≥137 refuses --load-extension for unsigned unpacked
// extensions, so Chrome for Testing — Google's official archive of actual
// release binaries — is the supported real-binary sideload path. If branded
// Chrome is installed it is still recorded in the evidence environment.
//
// Each leg: resolve binary → preflight probe (real browser version + loaded
// extension id via a launchPersistentContext identical to the specs) →
// playwright test --project=extension-chromium --reporter=json → parse the
// report into per-spec checks → write .omo evidence JSON.
//
// Exit codes: 0 pass · 1 suite failure · 2 harness error ·
//             3 NOT RUN (required binary unavailable).

import fs from "node:fs"
import path from "node:path"
import {
  fileVersion,
  probeInstalledChrome,
  provisionChromeForTesting,
  resolveChromeForTesting,
} from "./lib/browsers.mjs"
import { spawnLogged } from "./lib/procs.mjs"

const REPO = path.resolve(
  new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
)
const EXT_BUILD = path.join(REPO, "apps/extension/.output/chrome-mv3")
const EVIDENCE_DIR = path.join(REPO, ".omo/evidence/task-23-d-op-v2-share")
const CACHE_DIR = path.join(REPO, "tools/browser-cache")
const PROFILES_DIR = path.join(CACHE_DIR, "profiles")

function parseArgs(argv) {
  const args = { channel: undefined, allowDownload: false }
  for (const arg of argv) {
    if (arg.startsWith("--channel=")) args.channel = arg.slice("--channel=".length)
    else if (arg === "--allow-download") args.allowDownload = true
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: chrome-harness.mjs --channel=stable|previous|all [--allow-download]")
      process.exit(0)
    } else {
      console.error(`unknown arg: ${arg}`)
      process.exit(2)
    }
  }
  if (!["stable", "previous", "all"].includes(args.channel)) {
    console.error("--channel=stable|previous|all is required")
    process.exit(2)
  }
  return args
}

/** Cache-first resolution so reruns never hit the network; falls back to the
 *  Chrome-for-Testing version API and (with --allow-download) provisioning. */
async function resolveChrome(channel, allowDownload) {
  const envKey = channel === "stable" ? "DOP_CHROME_PATH" : "DOP_CHROME_PREVIOUS_PATH"
  const env = process.env[envKey]?.trim()
  if (env !== undefined && fs.existsSync(env)) {
    return { path: env, source: `env:${envKey}` }
  }
  // Cached archives: chrome-<major>/chrome-win64/chrome.exe — stable is the
  // highest major present, previous the next one down.
  const cached = !fs.existsSync(CACHE_DIR)
    ? []
    : fs
        .readdirSync(CACHE_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^chrome-\d+$/.test(d.name))
        .map((d) => ({
          major: Number(d.name.slice(7)),
          exe: path.join(CACHE_DIR, d.name, "chrome-win64", "chrome.exe"),
        }))
        .filter((c) => fs.existsSync(c.exe))
        .sort((a, b) => b.major - a.major)
  const wanted = channel === "stable" ? cached[0] : cached[1]
  if (wanted !== undefined) {
    return {
      path: wanted.exe,
      source: `chrome-for-testing-cache:major-${wanted.major}`,
      version: fileVersion(wanted.exe),
    }
  }
  try {
    const resolved = await resolveChromeForTesting(channel)
    if (resolved?.path !== undefined) return resolved
    if (allowDownload) return await provisionChromeForTesting(channel)
    return resolved // { path: undefined, download } → NOT RUN
  } catch (error) {
    if (allowDownload) throw error
    return { path: undefined, source: `resolve-failed:${error.message}` }
  }
}

async function runStep(cmd, argv, cwd, label, env) {
  const step = spawnLogged(cmd, argv, { cwd, label, env })
  const code = await new Promise((resolve) => step.child.once("exit", resolve))
  return { code, log: step.log }
}

/**
 * Preflight: launch the REAL binary exactly as the specs do (persistent
 * context + --load-extension), read the extension id off the service-worker
 * URL and the browser's self-reported version. Proves the binary can load
 * the unpacked extension before the suite burns time.
 */
async function preflightProbe(chromeExe, profileDir) {
  const { chromium } = await import("@playwright/test")
  fs.rmSync(profileDir, { recursive: true, force: true })
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromeExe,
    headless: true,
    args: [`--disable-extensions-except=${EXT_BUILD}`, `--load-extension=${EXT_BUILD}`],
  })
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 15_000 }))
    return {
      browserVersion: context.browser()?.version(),
      extensionId: new URL(worker.url()).hostname,
      workerUrl: worker.url(),
    }
  } finally {
    await context.close()
  }
}

async function runLeg(channel, args) {
  const run = {
    harness: "chrome-playwright-real-binary",
    channel,
    startedAt: new Date().toISOString(),
    args,
    checks: [],
    environment: {},
    artifacts: {},
  }
  const flush = (code) => {
    run.finishedAt = new Date().toISOString()
    run.result =
      code === 0 ? "PASS" : code === 3 ? "NOT RUN" : code === 2 ? "HARNESS ERROR" : "FAIL"
    const file = path.join(EVIDENCE_DIR, `native-chrome-${channel}.json`)
    fs.writeFileSync(file, JSON.stringify(run, null, 2))
    console.log(`\nevidence: ${path.relative(REPO, file)} (${run.result})`)
    return code
  }
  const check = (name, ok, detail = "") => {
    run.checks.push({ leg: "chrome", name, ok, detail, at: new Date().toISOString() })
    console.log(`  [${ok ? "PASS" : "FAIL"}] chrome/${name}${detail === "" ? "" : ` — ${detail}`}`)
    return ok
  }

  // ---------- binary ----------
  console.log(`\n[chrome/${channel}] resolving binary`)
  const chrome = await resolveChrome(channel, args.allowDownload)
  if (chrome?.path === undefined) {
    run.environment.chrome = { status: "NOT RUN", resolved: chrome }
    return flush(3)
  }
  const version = chrome.version ?? fileVersion(chrome.path)
  run.environment.chrome = { path: chrome.path, version, source: chrome.source }
  const branded = probeInstalledChrome()
  if (branded !== undefined) {
    run.environment.brandedChrome = { path: branded.path, version: branded.version }
  }
  check("real-binary", version !== undefined, `${version} @ ${chrome.path}`)

  // ---------- build ----------
  console.log(`[chrome/${channel}] building extension (chrome-mv3)`)
  const build = await runStep(
    "bunx",
    ["wxt", "build", "-b", "chrome"],
    path.join(REPO, "apps/extension"),
    "wxt",
  )
  run.artifacts["build:wxt"] = { code: build.code, tail: build.log.stderr.slice(-1500) }
  if (build.code !== 0 || !fs.existsSync(path.join(EXT_BUILD, "manifest.json"))) {
    run.artifacts.lastError = `wxt build exited ${build.code}`
    return flush(2)
  }

  // ---------- preflight ----------
  const preflightDir = path.join(PROFILES_DIR, `chrome-${channel}-preflight`)
  try {
    const probe = await preflightProbe(chrome.path, preflightDir)
    run.environment.installedAddon = {
      extensionId: probe.extensionId,
      workerUrl: probe.workerUrl,
      browserVersion: probe.browserVersion,
    }
    check(
      "addon-loaded",
      probe.extensionId !== "",
      `id=${probe.extensionId} browser=${probe.browserVersion}`,
    )
  } catch (error) {
    run.artifacts.lastError = String(error?.stack ?? error)
    check("addon-loaded", false, String(error?.message ?? error).slice(0, 300))
    return flush(1)
  } finally {
    fs.rmSync(preflightDir, { recursive: true, force: true })
  }

  // ---------- suite ----------
  console.log(`[chrome/${channel}] running extension-chromium suite`)
  const reportPath = path.join(EVIDENCE_DIR, `playwright-report-chrome-${channel}.json`)
  fs.rmSync(reportPath, { force: true })
  // Real Chrome instances are far heavier than bundled headless-shell —
  // default parallelism (6 workers here) thrashes the machine and turns
  // timing-sensitive UI steps into false negatives. Two workers keeps
  // evidence runs honest without masking real failures.
  const suite = await runStep(
    "bunx",
    ["playwright", "test", "--project=extension-chromium", "--reporter=json", "--workers=2"],
    REPO,
    "playwright",
    {
      DOP_BROWSER_EXECUTABLE: chrome.path,
      DOP_BROWSER_LABEL: `chrome-for-testing-${channel}:${version}`,
      PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
    },
  )
  run.artifacts["suite:playwright"] = {
    code: suite.code,
    stdoutTail: suite.log.stdout.slice(-4000),
    stderrTail: suite.log.stderr.slice(-2000),
    report: path.relative(REPO, reportPath),
  }

  // Parse the JSON report into per-spec evidence rows.
  let allPassed = suite.code === 0
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"))
    const specs = []
    for (const suiteNode of report.suites ?? []) {
      const walk = (node) => {
        for (const spec of node.specs ?? []) specs.push(spec)
        for (const child of node.suites ?? []) walk(child)
      }
      walk(suiteNode)
    }
    run.artifacts.specCount = specs.length
    for (const spec of specs) {
      const result = spec.tests?.[0]?.results?.[0]
      const status = result?.status ?? "unknown"
      const ok = spec.ok === true || status === "passed"
      if (!ok) allPassed = false
      check(
        `spec:${spec.title}`.slice(0, 120),
        ok,
        `${spec.file} ${status} ${Math.round((result?.duration ?? 0) / 1000)}s`,
      )
    }
    run.artifacts.stats = report.stats
  } catch (error) {
    check("report-parse", false, String(error?.message ?? error).slice(0, 200))
    allPassed = false
  }
  return flush(allPassed ? 0 : 1)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  fs.mkdirSync(PROFILES_DIR, { recursive: true })
  const channels = args.channel === "all" ? ["stable", "previous"] : [args.channel]
  let worst = 0
  for (const channel of channels) {
    const code = await runLeg(channel, args)
    if (code > worst) worst = code
  }
  process.exitCode = worst
}

main().catch((error) => {
  console.error(error?.stack ?? error)
  process.exitCode = 2
})
