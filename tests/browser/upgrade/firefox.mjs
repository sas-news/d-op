#!/usr/bin/env node
// Task-26 installed-profile upgrade rehearsal — REAL Firefox leg, driven
// through geckodriver (Marionette/WebDriver) exactly like the task-23 harness.
// NEVER Playwright's bundled Firefox.
//
//   bun run verify:upgrade -- --browser=firefox [--channel=stable|esr]
//     [--headed] [--keep] [--allow-download]
//
// Same disposable-only scenario as the chromium leg (see shared.mjs). Firefox
// specifics:
//   * temp add-on install via /moz/addon/install each session — identity is
//     the gecko id `d-op@sasnews.dev` from BOTH manifests (v1 keeps it, v2
//     declares the same id), so install/update/rollback keep one identity.
//   * `extensions.webextensions.uuids` pins the moz-extension UUID per
//     profile so storage.local survives browser restarts + addon swaps —
//     without it every temp install gets a fresh UUID and storage would be
//     orphaned (the same mechanism Firefox's own tests use).
//   * sessions quit/restart the real browser; profiles are per-leg disposable
//     dirs under tools/browser-cache/upgrade/firefox/.
//
// Exit codes: 0 pass · 1 check failure · 2 harness error · 3 NOT RUN.

import fs from "node:fs"
import path from "node:path"
import {
  firefoxVersion,
  geckodriverVersion,
  provisionFirefoxEsr,
  resolveFirefoxEsr,
  resolveFirefoxStable,
  resolveGeckodriver,
} from "../lib/browsers.mjs"
import { findFreePort, killByCommandLine, killTree, spawnLogged, waitFor } from "../lib/procs.mjs"
import { WebDriverClient } from "../lib/webdriver.mjs"
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

const EXT_BUILD = path.join(REPO_DIR, "apps/extension/.output/firefox-mv3")
const WORK = path.join(UPGRADE_ROOT, "firefox")
const GECKO_ID = "d-op@sasnews.dev"
const PINNED_UUID = "{d0b1e57a-9f2c-4c1d-8a00-23f1a9e50026}" // task-26 unique
const DOWNLOAD_DIR = path.join(WORK, "downloads")

function parseArgs(argv) {
  const args = { channel: "stable", headed: false, keep: false, allowDownload: false }
  for (const arg of argv) {
    if (arg.startsWith("--channel=")) args.channel = arg.slice("--channel=".length)
    else if (arg === "--headed") args.headed = true
    else if (arg === "--keep") args.keep = true
    else if (arg === "--allow-download") args.allowDownload = true
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: firefox.mjs [--channel=stable|esr] [--headed] [--keep] [--allow-download]",
      )
      process.exit(0)
    } else {
      console.error(`unknown arg: ${arg}`)
      process.exit(2)
    }
  }
  if (!["stable", "esr"].includes(args.channel)) {
    console.error("--channel=stable|esr")
    process.exit(2)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  const { run, check, note, notRun } = createRun("upgrade-rehearsal", "firefox", args)
  const cleanup = []
  const flush = (code) => {
    run.finishedAt = new Date().toISOString()
    run.result =
      code === 0 ? "PASS" : code === 3 ? "NOT RUN" : code === 2 ? "HARNESS ERROR" : "FAIL"
    const file = path.join(EVIDENCE_DIR, "upgrade-firefox.json")
    writeEvidence(file, run)
    console.log(`\nevidence: ${path.relative(REPO_DIR, file)} (${run.result})`)
    process.exitCode = code
  }

  // ---------- binaries ----------
  let firefox = args.channel === "stable" ? resolveFirefoxStable() : resolveFirefoxEsr()
  if (firefox === undefined && args.allowDownload && args.channel === "esr") {
    firefox = await provisionFirefoxEsr()
  }
  if (firefox === undefined) {
    run.environment.firefox = { status: "NOT RUN", reason: `no ${args.channel} binary` }
    return flush(3)
  }
  const gecko = await resolveGeckodriver({ allowDownload: args.allowDownload })
  if (gecko === undefined) {
    run.environment.geckodriver = { status: "NOT RUN" }
    return flush(3)
  }
  run.environment.firefox = {
    path: firefox.path,
    version: firefoxVersion(firefox.path),
    source: firefox.source,
  }
  run.environment.geckodriver = {
    path: gecko.path,
    version: geckodriverVersion(gecko.path),
    source: gecko.source,
  }
  check(
    "setup",
    "real-binaries",
    true,
    `${run.environment.firefox.version} + geckodriver ${run.environment.geckodriver.version}`,
  )

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
      ["wxt", "build", "-b", "firefox"],
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
  const v1Manifest = extractV1Extension(dirs.extV1, "firefox")
  copyDir(EXT_BUILD, dirs.extV2)
  swapExtensionContents(dirs.extV1, dirs.extLive)
  for (const dir of [dirs.profileMain, dirs.profileQuota, dirs.profileSchema, dirs.profileCrash]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  run.environment.v1 = {
    version: v1Manifest.version,
    source: "git show v1.0.0:* (manifest.firefox.json)",
  }
  run.environment.v2 = { dir: ".output/firefox-mv3", geckoId: GECKO_ID }
  note(
    "setup",
    "v1-extracted",
    `v${v1Manifest.version} gecko=${v1Manifest.browser_specific_settings?.gecko?.id}`,
  )

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

  // ---------- geckodriver ----------
  const gdPort = await findFreePort(4464)
  const drv = spawnLogged(gecko.path, ["--port", String(gdPort), "--allow-system-access"], {
    label: "geckodriver",
  })
  cleanup.push(() => killTree(drv.child))
  try {
    await waitFor(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${gdPort}/status`)).ok
        } catch {
          return false
        }
      },
      { timeoutMs: 15_000, label: "geckodriver /status" },
    )
  } catch (error) {
    run.artifacts.lastError = String(error?.stack ?? error)
    await killTree(drv.child)
    return flush(3)
  }
  const wd = new WebDriverClient(`http://127.0.0.1:${gdPort}`)
  run.artifacts.geckodriverLog = drv.log.stderr.slice(-2000)

  // ---------- WebDriver bridge ----------
  const liveExt = dirs.extLive
  const openSessions = new Set()
  const launch = async (profileDir) => {
    await wd.newSession({
      acceptInsecureCerts: true,
      "moz:firefoxOptions": {
        binary: firefox.path,
        args: [...(args.headed ? [] : ["-headless"]), "-no-remote", "-profile", profileDir],
        prefs: {
          "browser.shell.checkDefaultBrowser": false,
          "dom.disable_beforeunload": true,
          // Headless marionette cannot answer the native data-collection
          // doorhanger (same constraint as task-23); the extension's own
          // consent gate is unaffected and stays fail-closed.
          "extensions.dataCollectionPermissions.enabled": false,
          "extensions.webextensions.uuids": JSON.stringify({ [GECKO_ID]: PINNED_UUID }),
          // Export capture: WebDriver scripts on extension pages run in a
          // sandbox with separate JS intrinsics, so URL.createObjectURL can
          // never be hooked there. The real <a download> click performs a
          // real download — land it silently in a disposable dir and read
          // the file (stronger evidence than a blob hook anyway).
          "browser.download.dir": DOWNLOAD_DIR,
          "browser.download.useDefaultDir": false,
          "browser.download.folderList": 2,
          "browser.download.always_ask_before_handling_new_content_types": false,
          "browser.download.manager.showWhenStarting": false,
          "browser.helperApps.neverAsk.saveToDisk": "application/json",
        },
      },
    })
    await wd.setTimeouts({ script: 60_000, pageLoad: 60_000 })
    const id = await wd.installAddon(liveExt, { temporary: true })
    await wd.mozSetContext("chrome")
    const host = await wd.execute(
      `const p = WebExtensionPolicy.getByID(${JSON.stringify(GECKO_ID)});
       return p ? p.mozExtensionHostname : null`,
    )
    await wd.mozSetContext("content")
    if (host === null || host === undefined) throw new Error(`no mozExtension host for ${GECKO_ID}`)
    const extBase = `moz-extension://${host}`
    const bridge = {
      id,
      wd,
      extBase,
      gotoExt: (p) => wd.navigate(`${extBase}/${p}`),
      js: async (body) => {
        const result = await wd.executeAsync(
          `const __done = arguments[arguments.length - 1]
           // JSON-canon INSIDE the page: geckodriver marshals return values
           // with undefined object properties as null — the only place that
           // null can appear. Page-side canon makes replies byte-identical to
           // CDP returnByValue (chromium leg) and to stored bytes.
           const __canon = v => { try { return v === undefined ? null : JSON.parse(JSON.stringify(v)) } catch { return v } }
           ;(async () => {\n${body}\n})().then(
             v => __done({__v: __canon(v)}),
             e => __done({__e: String(e && (e.stack || e.message || e))}))`,
        )
        if (result !== null && typeof result === "object" && "__e" in result) {
          throw new Error(result.__e)
        }
        return result === null || result === undefined ? null : result.__v
      },
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
        wd.executeAsync(
          `const done = arguments[arguments.length-1];
           const canon = v => { try { return v === undefined ? null : JSON.parse(JSON.stringify(v)) } catch { return v } }
           // Consume the rejection ON the sendMessage promise itself: letting
           // it propagate (even into an awaited iife) fires the sandbox's
           // unhandled-rejection reporting — geckodriver then returns the
           // receiver's error as a script error and done() never runs
           // (observed: future-schema refusal surfacing as WebDriverError).
           ;(async () => {
             const rt = (globalThis.browser ?? globalThis.chrome).runtime;
             done(await rt.sendMessage(${JSON.stringify(m)}).then(
               r => ({ok: true, reply: canon(r)}),
               e => ({ok: false, error: String(e && (e.stack || e.message) || e)})))
           })().catch(e => done({ok: false, error: String(e && (e.stack || e.message) || e)}))`,
        ),
      upload: async (sel, abs) => {
        const el = await wd.findElement(sel)
        if (el === undefined) throw new Error(`no element ${sel}`)
        await wd.sendKeys(el, abs)
      },
      // See the download prefs comment: the export's <a download> click is
      // real, so the whitelisted JSON lands in DOWNLOAD_DIR. Clear stale
      // files, click, and wait for the completed file (.part excluded).
      captureExport: async () => {
        fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })
        for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
          fs.rmSync(path.join(DOWNLOAD_DIR, f), { force: true })
        }
        await bridge.js(PAGE.clickExport)
        const file = await waitFor(
          async () => {
            const done = fs
              .readdirSync(DOWNLOAD_DIR)
              .filter((f) => f.startsWith("dop_playlists_") && f.endsWith(".json"))
            return done.length > 0 ? path.join(DOWNLOAD_DIR, done[0]) : false
          },
          { timeoutMs: 15_000, label: "export download" },
        )
        return fs.readFileSync(file, "utf8")
      },
      shot: async (file) => {
        const png = await wd.screenshot()
        fs.writeFileSync(file, Buffer.from(png, "base64"))
      },
      // Raw backend read: Firefox's storage.local is IndexedDB-backed (no
      // flat file like the legacy json backend), so read through the storage
      // API itself. manifest.json is a script-free extension document — it
      // exposes browser.storage but can never invoke the repository, so the
      // read cannot trigger/complete the lazy migration under test.
      readStorageRaw: async () => {
        await wd.navigate(`${extBase}/manifest.json`)
        const result = await wd.executeAsync(
          `const done = arguments[arguments.length-1];
           const b = globalThis.browser ?? globalThis.chrome
           if (!b?.storage?.local) return done({__e: "no storage api on manifest document"})
           b.storage.local.get(null).then(
             v => done({__v: v === undefined ? null : JSON.parse(JSON.stringify(v))}),
             e => done({__e: String(e && (e.stack || e.message) || e)}))`,
        )
        if (result !== null && typeof result === "object" && "__e" in result) {
          throw new Error(result.__e)
        }
        return result === null || result === undefined ? {} : result.__v
      },
      close: async () => {
        await wd.deleteSession().catch(() => {})
        openSessions.delete(bridge)
      },
    }
    openSessions.add(bridge)
    return bridge
  }

  try {
    await runUpgradeScenario({
      browser: "firefox",
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
    await teardown(args, cleanup, openSessions)
    if (error instanceof CheckFailed) return flush(1)
    return flush(2)
  }
  await teardown(args, cleanup, openSessions)
  return flush(0)
}

async function teardown(args, cleanup, openSessions) {
  for (const session of [...openSessions]) {
    await session.close().catch(() => {})
  }
  for (const fn of cleanup.reverse()) {
    try {
      await fn()
    } catch {}
  }
  // Reap orphaned harness firefoxes still holding one of OUR profile dirs.
  await killByCommandLine("firefox.exe", WORK).catch(() => {})
  if (!args.keep) {
    fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 })
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error)
  process.exitCode = 2
})
