#!/usr/bin/env node
// Task-26 installed-profile upgrade rehearsal — REAL Chrome-for-Testing leg.
//
//   bun run verify:upgrade -- --browser=chromium [--channel=stable|previous]
//     [--headed] [--keep] [--allow-download]
//
// Flow (all on DISPOSABLE profiles/dirs under tools/browser-cache/upgrade/):
//   extract v1.0.0 from git → unpacked dir loaded at a FIXED path → seed every
//   legacy fixture through v1's own write helpers → before snapshot → replace
//   the SAME directory's files with the built v2 (same unpacked-path identity)
//   → real migration on first storage access → after snapshot + full oracle
//   checks → browser restart persistence → detached management keys → safe
//   export → wipe → re-import equivalence → fault legs (quota / future schema
//   / interrupted write, each on a fresh disposable profile) → rollback to v1
//   on the same profile.
//
// Branded Chrome ≥137 refuses unsigned --load-extension; Chrome for Testing
// (Google's official release archive) is the real-binary sideload path —
// identical constraint as the task-23 harness.
//
// Exit codes: 0 pass · 1 check failure · 2 harness error · 3 NOT RUN.

import fs from "node:fs"
import path from "node:path"
import { fileVersion, probeInstalledChrome, resolveChromeForTesting } from "../lib/browsers.mjs"
import { spawnLogged, waitFor } from "../lib/procs.mjs"
import {
  CheckFailed,
  copyDir,
  createRun,
  EVIDENCE_DIR,
  extractV1Extension,
  PAGE,
  REPO_DIR,
  runUpgradeScenario,
  swapExtensionContents,
  UPGRADE_ROOT,
  writeEvidence,
} from "./shared.mjs"

const EXT_BUILD = path.join(REPO_DIR, "apps/extension/.output/chrome-mv3")
const CACHE_DIR = path.join(REPO_DIR, "tools/browser-cache")
const WORK = path.join(UPGRADE_ROOT, "chromium")

function parseArgs(argv) {
  const args = { channel: "stable", headed: false, keep: false, allowDownload: false }
  for (const arg of argv) {
    if (arg.startsWith("--channel=")) args.channel = arg.slice("--channel=".length)
    else if (arg === "--headed") args.headed = true
    else if (arg === "--keep") args.keep = true
    else if (arg === "--allow-download") args.allowDownload = true
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: chromium.mjs [--channel=stable|previous] [--headed] [--keep] [--allow-download]",
      )
      process.exit(0)
    } else {
      console.error(`unknown arg: ${arg}`)
      process.exit(2)
    }
  }
  if (!["stable", "previous"].includes(args.channel)) {
    console.error("--channel=stable|previous")
    process.exit(2)
  }
  return args
}

/** Same cache-first resolution the task-23 harness uses. */
async function resolveChrome(channel, allowDownload) {
  const envKey = channel === "stable" ? "DOP_CHROME_PATH" : "DOP_CHROME_PREVIOUS_PATH"
  const env = process.env[envKey]?.trim()
  if (env !== undefined && fs.existsSync(env)) return { path: env, source: `env:${envKey}` }
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
    if (allowDownload) {
      const { provisionChromeForTesting } = await import("../lib/browsers.mjs")
      return await provisionChromeForTesting(channel)
    }
    return resolved
  } catch (error) {
    if (allowDownload) throw error
    return { path: undefined, source: `resolve-failed:${error.message}` }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  const { run, check, note, notRun } = createRun("upgrade-rehearsal", "chromium", args)
  const flush = (code) => {
    run.finishedAt = new Date().toISOString()
    run.result =
      code === 0 ? "PASS" : code === 3 ? "NOT RUN" : code === 2 ? "HARNESS ERROR" : "FAIL"
    const file = path.join(EVIDENCE_DIR, "upgrade-chromium.json")
    writeEvidence(file, run)
    console.log(`\nevidence: ${path.relative(REPO_DIR, file)} (${run.result})`)
    process.exitCode = code
  }

  // ---------- binary ----------
  const chrome = await resolveChrome(args.channel, args.allowDownload)
  if (chrome?.path === undefined) {
    run.environment.chrome = { status: "NOT RUN", resolved: chrome }
    return flush(3)
  }
  const version = chrome.version ?? fileVersion(chrome.path)
  run.environment.chrome = { path: chrome.path, version, source: chrome.source }
  const branded = probeInstalledChrome()
  if (branded !== undefined) run.environment.brandedChrome = branded
  check("setup", "real-binary", version !== undefined, `${version} @ ${chrome.path}`)

  // ---------- build + extract ----------
  const step = async (cmd, argv, cwd, label) => {
    const s = spawnLogged(cmd, argv, { cwd, label })
    const code = await new Promise((r) => s.child.once("exit", r))
    run.artifacts[`build:${label}`] = { code, tail: s.log.stderr.slice(-1500) }
    return code
  }
  if (
    (await step(
      "bunx",
      ["wxt", "build", "-b", "chrome"],
      path.join(REPO_DIR, "apps/extension"),
      "wxt",
    )) !== 0
  ) {
    return flush(2)
  }
  if (!fs.existsSync(path.join(EXT_BUILD, "manifest.json"))) return flush(2)

  const dirs = {
    work: WORK,
    extLive: path.join(WORK, "ext-live"),
    extV1: path.join(WORK, "ext-v1"),
    extV2: path.join(WORK, "ext-v2"),
    profileMain: path.join(WORK, "profile-main"),
    profileQuota: path.join(WORK, "profile-quota"),
    profileSchema: path.join(WORK, "profile-schema"),
    profileCrash: path.join(WORK, "profile-crash"),
  }
  const v1Manifest = extractV1Extension(dirs.extV1, "chromium")
  copyDir(EXT_BUILD, dirs.extV2)
  swapExtensionContents(dirs.extV1, dirs.extLive) // ext-live starts as v1
  run.environment.v1 = { version: v1Manifest.version, source: "git show v1.0.0:*" }
  run.environment.v2 = { dir: ".output/chrome-mv3", manifestVersion: 3 }
  note("setup", "v1-extracted", `v${v1Manifest.version} → ${path.relative(REPO_DIR, dirs.extV1)}`)

  // ---------- module-level fault legs (once, real migration code) ----------
  const vit = await step(
    "bunx",
    [
      "vitest",
      "run",
      "apps/extension/tests/storage/upgrade-rehearsal.test.ts",
      "--config",
      "vitest.unit.config.ts",
    ],
    REPO_DIR,
    "vitest-rehearsal",
  )
  run.artifacts["module-fault-legs"] = run.artifacts["build:vitest-rehearsal"]
  check("module", "vitest-fault-legs", vit === 0, `exit=${vit}`)

  // ---------- Playwright bridge ----------
  const { chromium } = await import("@playwright/test")
  const liveExt = dirs.extLive
  const openSessions = new Set()
  const launch = async (profileDir) => {
    // Update-time service-worker invalidation: a same-path unpacked swap does
    // NOT refresh the SW — Chrome persists the OLD extension's registration +
    // script under <profile>/Default/Service Worker and keeps serving it
    // (observed: v1's onMessage listener answering after the manifest was
    // already v2). A REAL store/reload update performs exactly this
    // invalidation, so the harness deletes that dir before every launch —
    // the SW re-registers from the CURRENT files. storage.local lives under
    // "Local Extension Settings", never in Service Worker — the migration's
    // data is untouched. Harmless on same-version restarts (SW is stateless).
    fs.rmSync(path.join(profileDir, "Default", "Service Worker"), {
      recursive: true,
      force: true,
    })
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: chrome.path,
      headless: !args.headed,
      args: [`--disable-extensions-except=${liveExt}`, `--load-extension=${liveExt}`],
    })
    // The unpacked id derives from the extension path; read the REAL one off
    // the registered service worker — never assumed.
    const worker =
      context.serviceWorkers().find((sw) => sw.url().startsWith("chrome-extension://")) ??
      (await context.waitForEvent("serviceworker", { timeout: 20_000 }))
    const id = new URL(worker.url()).hostname
    const page = context.pages()[0] ?? (await context.newPage())
    const bridge = {
      id,
      context,
      page,
      gotoExt: (p) =>
        page.goto(`chrome-extension://${id}/${p}`, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        }),
      js: (body) => page.evaluate(`(async () => {\n${body}\n})()`),
      waitFor: async (body, opts) => {
        await waitFor(async () => {
          try {
            return await bridge.js(body)
          } catch {
            return false
          }
        }, opts)
      },
      message: (m) =>
        page.evaluate(`(async () => {
          try {
            const r = await (globalThis.browser ?? globalThis.chrome).runtime.sendMessage(${JSON.stringify(m)})
            return { ok: true, reply: r === undefined ? null : r }
          } catch (e) {
            return { ok: false, error: String(e && (e.stack || e.message || e)) }
          }
        })()`),
      upload: (sel, abs) => page.setInputFiles(sel, abs),
      shot: (file) => page.screenshot({ path: file }),
      // In-page blob hook — CDP evaluate runs in the page's real realm, so
      // URL.createObjectURL CAN be intercepted here (unlike geckodriver's
      // sandboxed scripts — see the firefox leg's captureExport).
      captureExport: async () => {
        await bridge.js(PAGE.armExportCapture)
        await bridge.js(PAGE.clickExport)
        await bridge.waitFor(
          `return globalThis.__dopExport !== null && globalThis.__dopExport !== undefined`,
          { timeoutMs: 10_000, label: "export blob captured" },
        )
        return bridge.js(PAGE.readExport)
      },
      // SW-realm read: bypasses the repository, so it can never complete a
      // pending migration — exactly what the interrupt leg must observe.
      readStorageRaw: () =>
        worker.evaluate(
          `(async () => (globalThis.browser ?? globalThis.chrome).storage.local.get(null))()`,
        ),
      close: async () => {
        await context.close().catch(() => {})
        openSessions.delete(bridge)
      },
    }
    openSessions.add(bridge)
    return bridge
  }

  try {
    await runUpgradeScenario({
      browser: "chromium",
      dirs,
      launch,
      check,
      note,
      notRun,
      run,
      vitestLog: run.artifacts["build:vitest-rehearsal"]?.tail ?? "",
    })
  } catch (error) {
    run.artifacts.lastError = String(error?.stack ?? error)
    if (error instanceof CheckFailed) {
      await closeAll(openSessions)
      if (!args.keep) rmWork()
      return flush(1)
    }
    await closeAll(openSessions)
    if (!args.keep) rmWork()
    return flush(2)
  } finally {
    await closeAll(openSessions)
  }
  if (!args.keep) rmWork()
  return flush(0)
}

async function closeAll(openSessions) {
  for (const session of [...openSessions]) {
    await session.close().catch(() => {})
  }
}

function rmWork() {
  // Windows profile locks linger briefly after context.close() — bounded
  // retries beat a single EBUSY. Disposable dir only.
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 })
}

main().catch((error) => {
  console.error(error?.stack ?? error)
  process.exitCode = 2
})
