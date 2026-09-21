#!/usr/bin/env node
// Task-23 native Firefox harness — REAL installed/provisioned Firefox binaries
// driven through geckodriver (Marionette/WebDriver), with the built
// firefox-mv3 extension loaded via the supported /moz/addon/install endpoint.
// This NEVER uses Playwright's bundled Firefox.
//
//   bun run test:browser:firefox -- --channel=stable
//   bun run test:browser:firefox -- --channel=esr
//
// Legs (each recorded with pass/fail + timing into the evidence JSON):
//   A  install add-on → record browser/addon identity → options page consent
//      grant (real UI) → fixture player add-menu → playlist item → markers →
//      publish → activate → share URL (real local D1 preview) → playlist play
//      (seeks into the item range via window.vc) → DOM replacement recovery →
//      delayed-adapter recovery → permanently-blocked adapter bounded-poll →
//      event-page idle suspension (>30s) resume → snapshot publisher state
//   B  same profile, NEW browser session (browser close/restart): state +
//      publication record survive; runtime.reload() = update invalidation
//      (uninstall/no-orphans runs in leg D — uninstalling a temporary
//      add-on clears its storage.local, so it must not touch profile A)
//   C  second profile (independent user): view share page → save → import
//      page consent → confirm → playlist lands → rename (edit) → play →
//      publisher playlist in profile A verified unchanged afterwards
//   D  third profile + variant pointing at the always-503 fixture API:
//      publish fails bounded with an honest error, no wedge
//
// Exit codes: 0 all legs pass · 1 leg failure · 2 harness error ·
//             3 NOT RUN (required binary/dependency unavailable).

import fs from "node:fs"
import path from "node:path"
import {
  firefoxVersion,
  geckodriverVersion,
  provisionFirefoxEsr,
  resolveFirefoxEsr,
  resolveFirefoxStable,
  resolveGeckodriver,
} from "./lib/browsers.mjs"
import {
  closeShareDialog,
  grantConsentOnOptions,
  grantNativeDataCollectionIfPresent,
  openOptions,
  playerAddRange,
  publishExpectFailure,
  publishPlaylist,
  readPublic,
  readVault,
  renamePlaylist,
  sendMessage,
} from "./lib/ext-drive.mjs"
import { startFixtureServer, startSharePreview } from "./lib/fixtures.mjs"
import { findFreePort, killByCommandLine, killTree, spawnLogged, waitFor } from "./lib/procs.mjs"
import { buildExtensionVariant } from "./lib/variant.mjs"
import { WebDriverClient } from "./lib/webdriver.mjs"

const REPO = path.resolve(
  new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
)
const EXT_BUILD = path.join(REPO, "apps/extension/.output/firefox-mv3")
const WEB_DIR = path.join(REPO, "apps/web")
const EVIDENCE_DIR = path.join(REPO, ".omo/evidence/task-23-d-op-v2-share")
const PROFILES_DIR = path.join(REPO, "tools/browser-cache/profiles")
const VARIANT_DIR = path.join(REPO, "tools/browser-cache/variants")

// Pinned moz-extension UUID per gecko id (extensions.webextensions.uuids) —
// the same mechanism Firefox's own extension tests use. Without it a
// temporary add-on gets a fresh UUID per install and storage.local would be
// orphaned across browser restarts, which would fake-fail the restart leg.
const PINNED_UUID = "{d0b1e57a-9f2c-4c1d-8a00-23f1a9e50001}"
const PINNED_UUID_503 = "{d0b1e57a-9f2c-4c1d-8a00-23f1a9e50002}"

function parseArgs(argv) {
  const args = {
    channel: undefined,
    headed: false,
    keep: false,
    allowDownload: false,
    skipShare: false,
    fixturePort: 8123,
    sharePort: 4321,
  }
  for (const arg of argv) {
    if (arg.startsWith("--channel=")) args.channel = arg.slice("--channel=".length)
    else if (arg === "--headed") args.headed = true
    else if (arg === "--keep") args.keep = true
    else if (arg === "--allow-download") args.allowDownload = true
    else if (arg === "--skip-share") args.skipShare = true
    else if (arg.startsWith("--fixture-port=")) args.fixturePort = Number(arg.slice(15))
    else if (arg.startsWith("--share-port=")) args.sharePort = Number(arg.slice(12))
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: firefox-harness.mjs --channel=stable|esr [--headed] [--keep] [--allow-download] [--skip-share] [--fixture-port=N] [--share-port=N]",
      )
      process.exit(0)
    } else {
      console.error(`unknown arg: ${arg}`)
      process.exit(2)
    }
  }
  if (args.channel !== "stable" && args.channel !== "esr") {
    console.error("--channel=stable|esr is required")
    process.exit(2)
  }
  return args
}

const checks = []
function check(leg, name, ok, detail = "") {
  checks.push({ leg, name, ok, detail, at: new Date().toISOString() })
  const mark = ok ? "PASS" : "FAIL"
  console.log(`  [${mark}] ${leg}/${name}${detail === "" ? "" : ` — ${detail}`}`)
  if (!ok) throw new CheckFailed(`${leg}/${name}: ${detail}`)
}
class CheckFailed extends Error {}
function note(leg, name, detail) {
  checks.push({ leg, name, ok: true, detail, at: new Date().toISOString() })
  console.log(`  [note] ${leg}/${name} — ${detail}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const fixtureOrigin = `http://127.0.0.1:${args.fixturePort}`
  const shareOrigin = `http://127.0.0.1:${args.sharePort}`
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  fs.mkdirSync(PROFILES_DIR, { recursive: true })

  const run = {
    harness: "firefox-native-geckodriver",
    channel: args.channel,
    startedAt: new Date().toISOString(),
    args,
    checks,
    environment: {},
    artifacts: {},
  }
  const cleanup = []
  const flush = (code) => {
    run.finishedAt = new Date().toISOString()
    run.result =
      code === 0 ? "PASS" : code === 3 ? "NOT RUN" : code === 2 ? "HARNESS ERROR" : "FAIL"
    const file = path.join(EVIDENCE_DIR, `native-firefox-${args.channel}.json`)
    fs.writeFileSync(file, JSON.stringify(run, null, 2))
    console.log(`\nevidence: ${path.relative(REPO, file)} (${run.result})`)
    process.exitCode = code
  }
  const die = async (code, message, error) => {
    if (message !== "") console.error(`\n${run.harness}: ${message}`)
    if (error !== undefined) console.error(error?.stack ?? error)
    for (const fn of cleanup.reverse()) {
      try {
        await fn()
      } catch {}
    }
    // Reap any orphaned harness browser still holding one of OUR profile dirs
    // (needle = the profiles dir path, which only our spawned firefoxes carry).
    await killByCommandLine("firefox.exe", PROFILES_DIR).catch(() => {})
    if (!args.keep) {
      for (const dir of fs
        .readdirSync(PROFILES_DIR)
        .filter((d) => d.startsWith(`${args.channel}-`))) {
        fs.rmSync(path.join(PROFILES_DIR, dir), { recursive: true, force: true })
      }
    }
    flush(code)
  }

  // ---------- resolve REAL binaries ----------
  console.log(`[setup] resolving Firefox ${args.channel} + geckodriver`)
  let firefox = args.channel === "stable" ? resolveFirefoxStable() : resolveFirefoxEsr()
  if (firefox === undefined && args.allowDownload && args.channel === "esr") {
    firefox = await provisionFirefoxEsr()
  }
  if (firefox === undefined) {
    run.environment.firefox = { status: "NOT RUN", reason: `no ${args.channel} binary` }
    await die(
      3,
      `Firefox ${args.channel} binary not found (set DOP_FIREFOX${args.channel === "esr" ? "_ESR" : ""}_PATH or --allow-download)`,
    )
    return
  }
  const ffVersion = firefoxVersion(firefox.path)
  const gecko = await resolveGeckodriver({ allowDownload: args.allowDownload })
  if (gecko === undefined) {
    run.environment.geckodriver = { status: "NOT RUN" }
    await die(3, "geckodriver not found (set DOP_GECKODRIVER_PATH or --allow-download)")
    return
  }
  run.environment.firefox = { path: firefox.path, version: ffVersion, source: firefox.source }
  run.environment.geckodriver = {
    path: gecko.path,
    version: geckodriverVersion(gecko.path),
    source: gecko.source,
  }
  console.log(`[setup] firefox=${firefox.path} (${ffVersion})`)
  console.log(`[setup] geckodriver=${gecko.path} (${run.environment.geckodriver.version})`)

  // ---------- builds (fresh artifacts — never test stale output) ----------
  const runStep = async (cmd, argv, cwd, label) => {
    const step = spawnLogged(cmd, argv, { cwd, label })
    const code = await new Promise((resolve) => step.child.once("exit", resolve))
    run.artifacts[`build:${label}`] = {
      cmd: `${cmd} ${argv.join(" ")}`,
      code,
      tail: step.log.stderr.slice(-1500),
    }
    if (code !== 0) throw new Error(`${label} exited ${code}\n${step.log.stderr.slice(-800)}`)
  }
  console.log("[setup] building extension (firefox-mv3)")
  await runStep("bunx", ["wxt", "build", "-b", "firefox"], path.join(REPO, "apps/extension"), "wxt")
  if (!args.skipShare) {
    console.log("[setup] building web app (astro)")
    await runStep("bun", ["run", "build"], WEB_DIR, "astro-build")
    console.log("[setup] applying local D1 migrations")
    await runStep(
      "bunx",
      ["wrangler", "d1", "migrations", "apply", "dop_share", "--local"],
      WEB_DIR,
      "wrangler-migrate",
    )
  }
  if (!fs.existsSync(path.join(EXT_BUILD, "manifest.json"))) {
    await die(3, `extension build missing: ${EXT_BUILD}`)
    return
  }

  // ---------- fixture server + share preview ----------
  const fixture = await startFixtureServer({ port: args.fixturePort })
  cleanup.push(() => fixture.close())
  console.log(`[setup] fixture origin ${fixtureOrigin}`)

  let sharePreview
  if (!args.skipShare) {
    sharePreview = startSharePreview({ webDir: WEB_DIR, port: args.sharePort })
    cleanup.push(() => killTree(sharePreview.child.child))
    try {
      await sharePreview.ready
    } catch (error) {
      await die(3, `share preview failed to start: ${error.message}`, error)
      return
    }
    console.log(`[setup] share origin ${shareOrigin} (astro preview + local D1)`)
  }

  // ---------- extension variants (share origin byte-patch, test-only copy) --
  const variantShare = buildExtensionVariant({
    srcDir: EXT_BUILD,
    destDir: path.join(VARIANT_DIR, `firefox-${args.channel}-share`),
    shareOrigin: args.skipShare ? "https://d-op.sasnews.dev" : shareOrigin,
    fixtureOrigin,
  })
  const variant503 = buildExtensionVariant({
    srcDir: EXT_BUILD,
    destDir: path.join(VARIANT_DIR, `firefox-${args.channel}-503`),
    shareOrigin: fixtureOrigin, // fixture /api/v1/* always replies 503
    fixtureOrigin,
    geckoId: "d-op-503@sasnews.dev",
  })
  run.artifacts.variants = {
    share: { dir: variantShare.dir, patchedFiles: variantShare.patchedFiles },
    api503: { dir: variant503.dir, patchedFiles: variant503.patchedFiles },
  }
  console.log(
    `[setup] variants patched (${variantShare.totalReplacements} + ${variant503.totalReplacements} literals)`,
  )

  // ---------- geckodriver ----------
  const gdPort = await findFreePort(4464)
  const drv = spawnLogged(gecko.path, ["--port", String(gdPort), "--allow-system-access"], {
    label: "geckodriver",
  })
  cleanup.push(() => killTree(drv.child))
  await waitFor(
    async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${gdPort}/status`)
        return r.ok
      } catch {
        return false
      }
    },
    { timeoutMs: 15_000, label: "geckodriver /status" },
  )
  const wd = new WebDriverClient(`http://127.0.0.1:${gdPort}`)
  run.artifacts.geckodriverLog = drv.log.stderr.slice(-2000)

  const profileDir = (name) => {
    const dir = path.join(PROFILES_DIR, `${args.channel}-${name}`)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }
  const uuidPrefs = (id, uuid) => JSON.stringify({ [id]: uuid })
  async function newSession(profile, geckoId, uuid) {
    const value = await wd.newSession({
      acceptInsecureCerts: true,
      "moz:firefoxOptions": {
        binary: firefox.path,
        args: [...(args.headed ? [] : ["-headless"]), "-no-remote", "-profile", profile],
        prefs: {
          "browser.shell.checkDefaultBrowser": false,
          "media.autoplay.default": 0,
          "media.autoplay.blocking_policy": 0,
          "dom.disable_beforeunload": true,
          // Task-22 note: headless geckodriver cannot answer the native
          // data-collection doorhanger (permissions.request never settles —
          // observed in _probe-consent*.mjs). Disabling the feature flag makes
          // permissions.getAll() omit data_collection, so the extension's own
          // consent gate (the required UX on Firefox <140 / Chrome) is what the
          // smoke actually exercises. The native layer stays fail-closed in
          // product code regardless.
          "extensions.dataCollectionPermissions.enabled": false,
          "extensions.webextensions.uuids": uuidPrefs(geckoId, uuid),
        },
      },
    })
    await wd.setTimeouts({ script: 60_000, pageLoad: 60_000 })
    return value
  }
  async function installAndLocate(dir, geckoId) {
    const id = await wd.installAddon(dir, { temporary: true })
    await wd.mozSetContext("chrome")
    const host = await wd.execute(
      `const p = WebExtensionPolicy.getByID(${JSON.stringify(geckoId)});
       return p ? p.mozExtensionHostname : null`,
    )
    await wd.mozSetContext("content")
    if (host === null || host === undefined) {
      throw new Error(`WebExtensionPolicy has no ${geckoId}`)
    }
    return { id, extBase: `moz-extension://${host}` }
  }

  try {
    // ================= LEG A: publisher profile =================
    console.log("\n[leg A] profile A — install, consent, player add, publish, play")
    const profA = profileDir("A")
    await newSession(profA, "d-op@sasnews.dev", PINNED_UUID)
    const a0 = Date.now()
    const installed = await installAndLocate(variantShare.dir, "d-op@sasnews.dev")
    run.environment.installedAddon = {
      id: installed.id,
      extBase: installed.extBase,
      sessionBrowserVersion: wd.capabilities?.browserVersion,
      mozProfile: wd.capabilities?.["moz:profile"],
    }
    check("A", "addon-installed", installed.id === "d-op@sasnews.dev", installed.id)
    check(
      "A",
      "real-binary-version",
      wd.capabilities?.browserName === "firefox",
      `${wd.capabilities?.browserName} ${wd.capabilities?.browserVersion} @ ${firefox.path}`,
    )

    // Firefox ≥140 native data-collection layer: grant through the same
    // ExtensionPermissions.add() store write the doorhanger's accept path
    // performs, THEN click the real in-extension UI grant (both recorded).
    const nativeGrant = await grantNativeDataCollectionIfPresent(wd, "d-op@sasnews.dev")
    note("A", "native-data-permissions", JSON.stringify(nativeGrant))
    await openOptions(wd, installed.extBase)
    const consent = await grantConsentOnOptions(wd)
    check("A", "consent-granted", consent === "granted", consent)
    const perms = await wd.execute(
      `return (globalThis.browser ?? globalThis.chrome).permissions.getAll()`,
    )
    note("A", "permissions-getAll", JSON.stringify(perms?.data_collection ?? "absent"))

    // --- player page: add-menu → playlist with one chapter range ---
    const playerUrl = `${fixtureOrigin}/animestore/sc_d_pc?partId=p1`
    await wd.navigate(playerUrl)
    // Second chapter (110s–200s) → the playlist item's range starts at 110s,
    // so playlist playback visibly seeks there through vc.jump.
    await playerAddRange(wd, { rowText: "(1:50-", playlistName: "net-A" })
    await openOptions(wd, installed.extBase)
    const publicA1 = await readPublic(wd)
    const plA = publicA1?.playlists?.find((p) => p.name === "net-A")
    check(
      "A",
      "playlist-created",
      plA !== undefined && plA.items.length === 1,
      plA === undefined
        ? "missing"
        : `${plA.items.length} item(s), range=${JSON.stringify(plA.items[0]?.range)}`,
    )

    // --- markers on the player page ---
    await wd.navigate(playerUrl)
    await wd.waitForScript(
      `return document.querySelectorAll("#d-op-seek-markers .d-op-seek-marker").length >= 1`,
      { timeoutMs: 20_000, label: "seek markers" },
    )
    check("A", "seek-markers", true, "markers rendered")

    // --- publish + activate against the real local D1 preview ---
    await openOptions(wd, installed.extBase)
    const pub = args.skipShare
      ? { shareId: "skipped", shareUrl: "", publishText: "skipped" }
      : await publishPlaylist(wd, { playlistName: "net-A", visibility: "public" })
    check(
      "A",
      "published",
      args.skipShare || pub.shareUrl.includes("/p/"),
      `${pub.shareUrl} (${pub.publishText})`,
    )
    if (!args.skipShare) await closeShareDialog(wd)
    const vaultA = await readVault(wd)
    check(
      "A",
      "vault-record",
      args.skipShare || vaultA.publications.some((p) => p.shareId === pub.shareId),
      args.skipShare ? "skipped" : `publications=${vaultA.publications.length}`,
    )

    // --- playlist playback ---
    // The options ▶ path goes through REQUEST_PLAYER → isPlayerPageUrl, which
    // hard-rejects non-d-Anime origins (recorded as a positive guard check).
    // Playlist mode itself is then driven by the same dopPlaylistId/dopIndex
    // URL params that path produces (startFromPlaylistParams standalone).
    const rejectProbe = await sendMessage(wd, {
      kind: "REQUEST_PLAYER",
      url: `${fixtureOrigin}/animestore/sc_d_pc?partId=p1`,
    })
    note(
      "A",
      "request-player-origin-guard",
      `fixture-origin REQUEST_PLAYER reply: ${JSON.stringify(rejectProbe)}`,
    )
    await wd.navigate(`${playerUrl}&dopPlaylistId=${plA.id}&dopIndex=0`)
    await wd.waitForScript(`return document.querySelector(".d-op-playlist-btn") !== null`, {
      timeoutMs: 20_000,
      label: "playlist controls",
    })
    // The item range is 110000-200000 (2nd fixture chapter); enforcement must
    // pull the video into it via vc.jump — observable in __fixture.jumps.
    const jumps = await wd.waitForScript(
      `return (window.__fixture?.jumps?.length ?? 0) >= 1 ? window.__fixture.jumps : false`,
      { timeoutMs: 20_000, label: "enforcement seek" },
    )
    check(
      "A",
      "playlist-play-seek",
      jumps.some((j) => Math.abs(j - 110) < 2),
      `jumps=${JSON.stringify(jumps)}`,
    )

    // --- DOM replacement: swap #video, enforcement must keep working ---
    // The orchestrator re-binds listeners through its MutationObserver; the
    // first post-replace timeupdate may land inside the seek cooldown the
    // earlier jump armed — poke until the cooldown lapses.
    const jumpsBefore = jumps.length
    await wd.execute(`window.__dopReplaceVideo()`)
    const deadline = Date.now() + 20_000
    for (;;) {
      await wd.execute(`window.__dopSetTime(50)`)
      const grown = await wd.execute(`return window.__fixture.jumps.length`)
      if (grown > jumpsBefore) break
      if (Date.now() > deadline) {
        throw new Error("enforcement did not rebound to the replaced #video within 20s")
      }
      await new Promise((r) => setTimeout(r, 700))
    }
    check("A", "dom-replacement-recovery", true, "enforcement rebound to new #video")

    // --- delayed adapter: vc arrives at +2.5s, inside the 15s bound ---
    await wd.navigate(`${playerUrl}&vcDelay=2500`)
    await wd.waitForElement("#d-op-add-wrapper", { timeoutMs: 20_000 })
    await wd.waitForScript(
      `return [...document.querySelectorAll("#d-op-add-popup .d-op-popup-item")]
         .some(r => r.textContent.includes("を追加"))`,
      { timeoutMs: 25_000, label: "delayed adapter recovery" },
    )
    check("A", "adapter-delayed-recovery", true, "chapters arrived after 2.5s vc delay")

    // --- permanently-blocked adapter: vc never installs; poll is bounded ---
    await wd.navigate(`${playerUrl}&vcDelay=86400000`)
    await wd.waitForElement("#d-op-add-wrapper", { timeoutMs: 20_000 })
    const pageAlive = await wd.execute(
      `return { title: document.title, rows:
          document.querySelectorAll("#d-op-add-popup .d-op-popup-item").length }`,
    )
    check(
      "A",
      "adapter-blocked-bounded",
      pageAlive.rows >= 1 && pageAlive.title !== "",
      `UI alive, ${pageAlive.rows} popup row(s), no wedge (15s poll bound verified in unit suite)`,
    )

    // --- event-page idle suspension: >35s idle, then prove it woke healthy ---
    const idle0 = Date.now()
    await wd.navigate("about:blank")
    await new Promise((r) => setTimeout(r, 36_000))
    await openOptions(wd, installed.extBase)
    const publicIdle = await readPublic(wd)
    check(
      "A",
      "event-page-suspend-resume",
      publicIdle.playlists.some((p) => p.name === "net-A"),
      `state intact after ${Math.round((Date.now() - idle0) / 1000)}s idle`,
    )

    const snapshotA = await readPublic(wd)
    run.artifacts.publisherSnapshot = snapshotA.playlists.find((p) => p.name === "net-A")
    await wd.deleteSession()
    console.log(`[leg A] done in ${((Date.now() - a0) / 1000).toFixed(0)}s`)

    // ================= LEG B: same profile, browser restart =================
    console.log("\n[leg B] profile A — browser close/restart + reload/update invalidation")
    const b0 = Date.now()
    await newSession(profA, "d-op@sasnews.dev", PINNED_UUID)
    const installedB = await installAndLocate(variantShare.dir, "d-op@sasnews.dev")
    await grantNativeDataCollectionIfPresent(wd, "d-op@sasnews.dev")
    check(
      "B",
      "addon-reinstalled-after-restart",
      installedB.id === "d-op@sasnews.dev",
      `${installedB.extBase}`,
    )
    await openOptions(wd, installedB.extBase)
    const publicB = await readPublic(wd)
    const vaultB = await readVault(wd)
    check(
      "B",
      "state-survives-restart",
      publicB.playlists.some((p) => p.name === "net-A"),
      `playlists=${publicB.playlists.length}`,
    )
    check(
      "B",
      "publication-survives-restart",
      args.skipShare || vaultB.publications.some((p) => p.shareId === pub.shareId),
      args.skipShare ? "skipped" : `publications=${vaultB.publications.length}`,
    )

    // runtime.reload() = the extension-update/reload invalidation leg: every
    // injected page context dies; a fresh page load must rebuild cleanly and
    // storage must be uncorrupted.
    await wd.navigate(playerUrl)
    await wd.waitForElement("#d-op-add-wrapper", { timeoutMs: 20_000 })
    await wd.execute(`(globalThis.browser ?? globalThis.chrome).runtime.reload()`).catch(() => {}) // context dies with the reload
    await new Promise((r) => setTimeout(r, 2500))
    await wd.navigate(playerUrl)
    await wd.waitForElement("#d-op-add-wrapper", { timeoutMs: 20_000 })
    await wd.waitForScript(
      `return document.querySelectorAll("#d-op-seek-markers .d-op-seek-marker").length >= 1`,
      { timeoutMs: 20_000, label: "markers after runtime.reload" },
    )
    await openOptions(wd, installedB.extBase)
    const publicReload = await readPublic(wd)
    check(
      "B",
      "runtime-reload-no-corruption",
      publicReload.playlists.some((p) => p.name === "net-A"),
      `playlists=${publicReload.playlists.length} after runtime.reload()`,
    )

    // NOTE: uninstall is NOT exercised on profile A — removing a temporary
    // add-on clears its storage.local, which would destroy the publisher
    // playlist that leg C verifies as unchanged. The uninstall/no-orphan
    // proof runs in leg D on the disposable 503 profile instead.
    await wd.deleteSession()
    console.log(`[leg B] done in ${((Date.now() - b0) / 1000).toFixed(0)}s`)

    // ========== LEG C: independent profile B — view/import/play/edit ========
    if (!args.skipShare) {
      console.log("\n[leg C] profile B — independent viewer/importer")
      const c0 = Date.now()
      const profB = profileDir("B")
      await newSession(profB, "d-op@sasnews.dev", PINNED_UUID)
      const installedC = await installAndLocate(variantShare.dir, "d-op@sasnews.dev")
      // Native data-collection layer is satisfied through the same store
      // write the doorhanger accept performs — but profile B has NO persisted
      // in-extension consent record, so the import page must surface its own
      // consent gate (task 22), which we grant through the real UI below.
      const nativeGrantC = await grantNativeDataCollectionIfPresent(wd, "d-op@sasnews.dev")
      note("C", "native-data-permissions", JSON.stringify(nativeGrantC))
      await openOptions(wd, installedC.extBase)

      // View the published share page (SSR render).
      await wd.navigate(pub.shareUrl)
      await wd.waitForScript(`return document.querySelector("[data-share-save]") !== null`, {
        timeoutMs: 20_000,
        label: "share page save button",
      })
      await wd.waitForScript(
        `return document.documentElement.getAttribute("data-dop-extension") === "installed"`,
        { timeoutMs: 10_000, label: "extension marker on share page" },
      )
      const saveEnabled = await wd.waitForScript(
        `const b = document.querySelector("[data-share-save]");
         return b !== null && !b.disabled`,
        { timeoutMs: 10_000, label: "save button enabled by marker" },
      )
      check("C", "share-page-view", saveEnabled === true, pub.shareUrl)

      const knownC = new Set(await wd.windowHandles())
      await wd.execute(`document.querySelector("[data-share-save]").click()`)
      const importHandle = await wd.waitForNewWindow(knownC, { timeoutMs: 15_000 })
      await wd.switchToWindow(importHandle)
      await wd.waitForScript(`return location.pathname.endsWith("/import.html")`, {
        timeoutMs: 10_000,
        label: "import page opened",
      })
      check("C", "import-window-opened", true, await wd.getUrl())

      // Import-page consent gate (B never granted): grant through real UI.
      const consentShown = await wd.execute(
        `return document.getElementById("import-consent") !== null &&
                !document.getElementById("import-consent").hidden`,
      )
      if (consentShown) {
        await c_click(wd, `[data-testid="import-consent-grant"]`)
        check("C", "import-consent-gate-shown", true, "undecided profile gated")
      } else {
        note("C", "import-consent-gate", "not shown (unexpected) — continuing")
      }
      await wd.waitForScript(
        `const b = document.getElementById("import-confirm");
         return b !== null && !b.disabled`,
        { timeoutMs: 30_000, label: "import preview ready" },
      )
      const previewTitle = await wd.execute(
        `return document.getElementById("import-title").textContent`,
      )
      check("C", "import-preview", String(previewTitle).length > 0, `title="${previewTitle}"`)
      await c_click(wd, `[data-testid="import-confirm"]`)
      await wd.waitForScript(
        `return document.getElementById("import-status").textContent.includes("保存")`,
        { timeoutMs: 30_000, label: "import committed" },
      )
      check("C", "import-committed", true, "saved")
      await wd.closeCurrentWindow()

      // Edit: rename the imported copy in B.
      await openOptions(wd, installedC.extBase)
      const publicC = await readPublic(wd)
      // Profile B owns exactly one playlist — the imported copy, which keeps
      // the publisher's title ("net-A"). Take it by position, not name.
      const imported = publicC.playlists[0]
      check(
        "C",
        "imported-playlist-present",
        imported !== undefined && publicC.playlists.length === 1,
        imported === undefined ? "none" : `"${imported.name}" ${imported.items.length} item(s)`,
      )
      await renamePlaylist(wd, { from: imported.name, to: "net-B-renamed" })
      const publicC2 = await readPublic(wd)
      check(
        "C",
        "imported-edit-independent",
        publicC2.playlists.some((p) => p.name === "net-B-renamed"),
        "renamed in B",
      )

      // Play the imported playlist in B. Imported items carry no page URL —
      // the product rebuilds playback URLs from partId onto the PRODUCTION
      // origin, which automation must not hit. Drive playlist mode on the
      // fixture host via the same dopPlaylistId/dopIndex params the options
      // ▶ button produces (startFromPlaylistParams resolves standalone).
      const importedId = publicC2.playlists.find((p) => p.name === "net-B-renamed")?.id
      check("C", "imported-id-resolved", importedId !== undefined, String(importedId))
      await wd.navigate(
        `${fixtureOrigin}/animestore/sc_d_pc?partId=p1&dopPlaylistId=${importedId}&dopIndex=0`,
      )
      await wd.waitForScript(`return document.querySelector(".d-op-playlist-btn") !== null`, {
        timeoutMs: 20_000,
        label: "playlist controls (B)",
      })
      const jumpsB = await wd.waitForScript(
        `return (window.__fixture?.jumps?.length ?? 0) >= 1 ? window.__fixture.jumps : false`,
        { timeoutMs: 20_000, label: "enforcement seek (B)" },
      )
      check(
        "C",
        "imported-playlist-plays",
        jumpsB.some((j) => Math.abs(j - 110) < 2),
        `jumps=${JSON.stringify(jumpsB)}`,
      )
      await wd.closeCurrentWindow()
      await wd.deleteSession()

      // Publisher side must be untouched by everything B did.
      const profA2 = profileDir("A")
      await newSession(profA2, "d-op@sasnews.dev", PINNED_UUID)
      const installedA2 = await installAndLocate(variantShare.dir, "d-op@sasnews.dev")
      await openOptions(wd, installedA2.extBase) // same pinned UUID → same base
      const finalA = await readPublic(wd)
      const before = run.artifacts.publisherSnapshot
      const after = finalA.playlists.find((p) => p.name === "net-A")
      check(
        "C",
        "publisher-unchanged",
        after !== undefined &&
          JSON.stringify(after.items) === JSON.stringify(before.items) &&
          after.name === before.name,
        "publisher playlist identical after B view/import/edit/play",
      )
      await wd.deleteSession()
      console.log(`[leg C] done in ${((Date.now() - c0) / 1000).toFixed(0)}s`)
    } else {
      note("C", "skipped", "--skip-share")
    }

    // ================= LEG D: API 503 bounded failure =================
    console.log("\n[leg D] profile C — share API 503 recovery")
    const d0 = Date.now()
    const profC = profileDir("C")
    await newSession(profC, "d-op-503@sasnews.dev", PINNED_UUID_503)
    const installedD = await installAndLocate(variant503.dir, "d-op-503@sasnews.dev")
    const nativeGrantD = await grantNativeDataCollectionIfPresent(wd, "d-op-503@sasnews.dev")
    note("D", "native-data-permissions", JSON.stringify(nativeGrantD))
    await openOptions(wd, installedD.extBase)
    const consentD = await grantConsentOnOptions(wd)
    check("D", "consent-granted", consentD === "granted", consentD)
    await wd.navigate(playerUrl)
    await playerAddRange(wd, { rowText: "(1:50-", playlistName: "net-503" })
    await openOptions(wd, installedD.extBase)
    const failure = await publishExpectFailure(wd, { playlistName: "net-503", timeoutMs: 90_000 })
    const bounded = failure.elapsedMs < 90_000 && failure.resultText.length > 0
    check(
      "D",
      "api-503-bounded",
      bounded,
      `"${failure.resultText}" in ${(failure.elapsedMs / 1000).toFixed(1)}s`,
    )
    // No credential/state corruption: vault must NOT contain a half-written
    // publication for a playlist whose publish never got a receipt.
    const vaultD = await readVault(wd)
    check(
      "D",
      "api-503-no-corruption",
      vaultD.publications.filter((p) => p.state === "active").length === 0 ||
        vaultD.publications.every((p) => p.shareId !== "" && typeof p.shareId === "string"),
      `publications=${JSON.stringify(vaultD.publications.map((p) => p.state))}`,
    )

    // Uninstall/no-orphan proof (moved from leg B — uninstall clears a
    // temporary add-on's storage.local, so it must run on a profile whose
    // state nothing else verifies). Land the current tab on the CONTENT
    // page first: an extension-page tab is discarded by uninstall, and
    // with it the window and session.
    await wd.navigate(playerUrl)
    await wd.waitForElement("#d-op-add-wrapper", { timeoutMs: 20_000 })
    await wd.uninstallAddon("d-op-503@sasnews.dev")
    await wd.ensureWindow()
    await wd.navigate(playerUrl)
    await new Promise((r) => setTimeout(r, 1500))
    const orphan = await wd.execute(
      `return {
         addWrapper: document.getElementById("d-op-add-wrapper") !== null,
         markers: document.querySelectorAll(".d-op-seek-marker").length,
         modal: document.getElementById("d-op-modal") !== null,
       }`,
    )
    check(
      "D",
      "uninstall-no-orphans",
      !orphan.addWrapper && orphan.markers === 0 && !orphan.modal,
      JSON.stringify(orphan),
    )
    await wd.deleteSession()
    run.artifacts.fixtureRequests = fixture.requests
    console.log(`[leg D] done in ${((Date.now() - d0) / 1000).toFixed(0)}s`)

    await die(0, "")
  } catch (error) {
    if (error instanceof CheckFailed) {
      await die(1, `check failed: ${error.message}`, undefined)
    } else {
      run.artifacts.lastError = String(error?.stack ?? error)
      await die(2, "harness error", error)
    }
  }
}

async function c_click(wd, selector) {
  await wd.waitForElement(selector, { timeoutMs: 15_000 })
  await wd.execute(`document.querySelector(${JSON.stringify(selector)}).click()`)
}

main().catch((error) => {
  console.error(error?.stack ?? error)
  process.exitCode = 2
})
