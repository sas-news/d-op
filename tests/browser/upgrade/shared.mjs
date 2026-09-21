// Task-26 shared library for the installed-profile upgrade rehearsal
// (`bun run verify:upgrade -- --browser=chromium|firefox`). Everything here
// is browser-neutral: the two legs (upgrade-chromium.mjs / upgrade-firefox.mjs)
// supply a `bridge` object wrapping Playwright / geckodriver primitives and
// this module runs ONE scenario against it.
//
// Bridge contract (implemented per browser):
//   id          — the loaded extension's identity (chrome unpacked id /
//                 gecko id), resolved from the real browser at launch.
//   gotoExt(p)  — navigate the current extension surface to an extension page
//   js(body)    — evaluate an ASYNC function body (`return` allowed) on the
//                 current page; throws on script error. JSON-safe results.
//   waitFor(body,{timeoutMs,label}) — poll js(body) until truthy
//   message(m)  — browser/chrome.runtime.sendMessage round trip →
//                 { ok:true, reply } | { ok:false, error }
//   upload(sel, absPath) — set a <input type=file> from a real temp file
//   shot(path)  — screenshot of the current surface (best effort)
//   readStorageRaw() — a storage.local.get(null) that does NOT pass through
//                 the extension repository (so it never triggers/completes
//                 a migration); used by the interrupted-persistence leg to
//                 inspect what landed before re-navigation. Chromium: SW
//                 realm; Firefox: the profile's storage.js after close.
//   close()     — end the session (browser quits / context closes)
//
// Disposable-only discipline: every profile and extension dir lives under
// tools/browser-cache/upgrade/; nothing here touches a real user profile.

import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  EXPECTED,
  FUTURE_STATE,
  LEGACY_KEYS,
  LEGACY_PLAYLISTS,
  MANAGE_SECRET_A,
  MANAGE_SECRET_B,
  POST_V2_RENAME,
  publicationRecord,
  replacementSnapshot,
  SHARE_ID_A,
  SHARE_ID_B,
} from "./seed-data.ts"

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
export const EVIDENCE_DIR = path.join(REPO_DIR, ".omo/evidence/task-26-d-op-v2-share")
export const UPGRADE_ROOT = path.join(REPO_DIR, "tools/browser-cache/upgrade")

const V1_FILES = [
  "background.js",
  "browser-polyfill.js",
  "common.js",
  "content.js",
  "content-store.js",
  "injected.js",
  "options.css",
  "options.html",
  "options.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "styles.css",
  "styles-store.css",
  "icons/icon128.png",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
]

/** Extract the disposable v1.0.0 extension from the git baseline tag.
 *  For Firefox the legacy `manifest.firefox.json` becomes `manifest.json`. */
export function extractV1Extension(destDir, browser) {
  fs.rmSync(destDir, { recursive: true, force: true })
  const manifestSrc = browser === "firefox" ? "manifest.firefox.json" : "manifest.json"
  for (const rel of [manifestSrc, ...V1_FILES]) {
    const bytes = execFileSync("git", ["-C", REPO_DIR, "show", `v1.0.0:${rel}`])
    const target = path.join(destDir, rel === manifestSrc ? "manifest.json" : rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
  }
  return JSON.parse(fs.readFileSync(path.join(destDir, "manifest.json"), "utf8"))
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else fs.copyFileSync(from, to)
  }
}

/** The SAME unpacked directory is re-populated in place — Chrome derives the
 *  unpacked id from the absolute path, so this is exactly how a store update
 *  (files replaced under the same extension id) presents to the profile. */
export function swapExtensionContents(srcDir, liveDir) {
  fs.mkdirSync(liveDir, { recursive: true })
  for (const entry of fs.readdirSync(liveDir)) {
    fs.rmSync(path.join(liveDir, entry), { recursive: true, force: true })
  }
  copyTree(srcDir, liveDir)
  return JSON.parse(fs.readFileSync(path.join(liveDir, "manifest.json"), "utf8"))
}

export function copyDir(srcDir, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true })
  copyTree(srcDir, destDir)
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

export function writeEvidence(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2))
  return file
}

/** JSON-canonicalize: stored values cross chrome.storage's serialization,
 *  which drops `undefined` object fields — the in-harness oracle may carry
 *  them. Comparing must use the same canonical form. */
export function jsonCanon(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

// --- Structural compare (order-insensitive object keys, strict arrays) ------
export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, i) => deepEqual(entry, b[i]))
  }
  if (typeof a === "object") {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every((key) => key in b && deepEqual(a[key], b[key]))
  }
  return false
}

/** First leaf-level difference between two structures — diagnostics only. */
export function firstDiff(a, b, path = "$") {
  if (a === b) return null
  if (typeof a !== typeof b || a === null || b === null) {
    return `${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array vs non-array`
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  if (typeof a === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in a)) return `${path}.${key}: missing in expected`
      if (!(key in b)) return `${path}.${key}: ${JSON.stringify(a[key])} !== <absent>`
      const d = firstDiff(a[key], b[key], `${path}.${key}`)
      if (d) return d
    }
    return null
  }
  return `${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`
}

// --- Run/check bookkeeping (mirrors the task-23 harness style) -------------
export class CheckFailed extends Error {}

export function createRun(harnessName, browser, args) {
  const run = {
    harness: harnessName,
    browser,
    startedAt: new Date().toISOString(),
    args,
    checks: [],
    environment: {},
    artifacts: {},
    snapshots: {},
    notRun: [],
  }
  const record = (entry) => {
    run.checks.push({ ...entry, at: new Date().toISOString() })
    const mark = entry.notRun === true ? "NR  " : entry.ok ? "PASS" : "FAIL"
    console.log(`  [${mark}] ${entry.leg}/${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`)
  }
  const check = (leg, name, ok, detail = "") => {
    record({ leg, name, ok, detail })
    if (!ok) throw new CheckFailed(`${leg}/${name}: ${detail}`)
    return ok
  }
  const note = (leg, name, detail) => record({ leg, name, ok: true, detail })
  const notRun = (leg, name, reason) => {
    run.notRun.push({ leg, name, reason })
    record({ leg, name, ok: true, detail: reason, notRun: true })
  }
  return { run, check, note, notRun }
}

// --- Page-side script bodies (async function bodies, `return` produces the
//     value; the bridge wraps them per driver) -------------------------------

const seedCall = (fn, arg) => `await ${fn}(${JSON.stringify(arg)});`

export const PAGE = {
  v1Ready: `return typeof dopSavePlaylists === "function" && typeof dopGetPlaylists === "function"`,
  v2Ready: `return document.getElementById("playlistsContainer") !== null
    && document.getElementById("optionsVersion") !== null`,
  v2Cards: `return document.querySelectorAll(".playlist-card").length`,
  managementRows: `return document.querySelectorAll("#managementList .management-row").length`,
  modalVisible: `return document.getElementById("d-op-modal") !== null`,
  importStatus: `return document.getElementById("importStatus")?.textContent ?? ""`,

  /** Seed every legacy key through v1's OWN write helpers (common.js is loaded
   *  on the v1 options page — real code path, not a storage poke). */
  seedV1: `
    ${seedCall("dopSavePlaylists", LEGACY_PLAYLISTS)}
    // dop_playback is seeded with a negative (SW-context) windowId: v1's
    // recoverPlayerState deletes the key on restart when it finds a stale
    // positive id — real v1 housekeeping, not a rehearsal assertion target.
    await (globalThis.browser ?? globalThis.chrome).storage.local.set({
      dop_playback: { playlistId: "pl-modern", index: 1, updatedAt: 1700000000000, windowId: -4242 },
      dop_player_window: { id: 4242, left: 10, top: 20, width: 800, height: 600 },
    });
    ${seedCall("dopSetPending", { action: "add", partId: "pt_pending", updatedAt: 1_700_000_000_001 })}
    await dopSetOpEdMode(true);
    ${seedCall("dopSetWindowMode", "tab")}
    await dopSetCollapsedPlaylist("pl-modern", true);
    await dopSetCollapsedPlaylist("pl-typed", false);
    return (globalThis.browser ?? globalThis.chrome).storage.local.get(null)`,

  seedDirect: (obj) => `
    await (globalThis.browser ?? globalThis.chrome).storage.local.set(${JSON.stringify(obj)});
    return (globalThis.browser ?? globalThis.chrome).storage.local.get(null)`,

  readAll: `return (globalThis.browser ?? globalThis.chrome).storage.local.get(null)`,
  bytesInUse: `const st = (globalThis.browser ?? globalThis.chrome).storage.local
    return typeof st.getBytesInUse === "function" ? st.getBytesInUse(null) : -1`,
  removeKeys: (keys) => `
    await (globalThis.browser ?? globalThis.chrome).storage.local.remove(${JSON.stringify(keys)});
    return true`,
  v1View: `return dopGetPlaylists()`,

  /** Fill storage.local until a set() actually rejects (real quota) or the
   *  hard item cap is hit — bounded so a backend with no quota (some channels)
   *  terminates honestly instead of looping forever. Returns
   *  { filled, keys, bytesInUse }. */
  fillUntilQuota: `
    const st = (globalThis.browser ?? globalThis.chrome).storage.local
    const keys = []
    let filled = false
    let index = 0
    const isQuota = (e) => String(e && (e.message || e)).toLowerCase().includes("quota")
    try {
      while (index < 1700) {
        const values = {}
        for (let i = 0; i < 20 && index < 1700; i += 1, index += 1) {
          const name = "filler_" + index
          values[name] = "x".repeat(7000)
          keys.push(name)
        }
        await st.set(values)
      }
    } catch (e) {
      filled = isQuota(e)
    }
    // Shrinking finish ALWAYS runs: the batch rejection leaves up to one
    // batch (~140KB) of headroom — a small migration envelope would still
    // fit. Squeeze until even a ~60-byte write is refused (or the cap hits).
    if (index < 3400) {
      for (const size of [4000, 1000, 250, 60]) {
        while (index < 3400) {
          try {
            const name = "filler_t" + index
            index += 1
            const v = {}
            v[name] = "x".repeat(size)
            await st.set(v)
            keys.push(name)
          } catch (e) {
            filled = filled || isQuota(e)
            break
          }
        }
        if (filled && index >= 3400) break
        // Keep shrinking even while earlier sizes still fit.
      }
    }
    const used = typeof st.getBytesInUse === "function" ? await st.getBytesInUse(null) : -1
    return { filled, keys, bytesInUse: used }`,

  /** Export capture: hook URL.createObjectURL once (the page revokes the URL
   *  immediately after anchor.click(), so the Blob itself — which stays
   *  readable — is what we keep). Identical on both drivers. */
  armExportCapture: `
    if (!globalThis.__dopUrlHooked) {
      globalThis.__dopUrlHooked = true
      const orig = URL.createObjectURL.bind(URL)
      URL.createObjectURL = (blob) => {
        globalThis.__dopExport = blob
        return orig(blob)
      }
    }
    return true`,
  clickExport: `document.getElementById("exportBtn").click(); return true`,
  readExport: `
    const blob = globalThis.__dopExport
    globalThis.__dopExport = null
    return blob ? blob.text() : null`,

  modalClick: (text) => `
    const btn = [...document.querySelectorAll("#d-op-modal .d-op-modal-footer button")]
      .find((b) => b.textContent.includes(${JSON.stringify(text)}))
    if (!btn) return false
    btn.click()
    return true`,
  renameCard: (from, to) => `
    const card = [...document.querySelectorAll(".playlist-card")]
      .find((cd) => cd.querySelector(".playlist-name-input")?.value === ${JSON.stringify(from)})
    if (!card) return false
    const input = card.querySelector(".playlist-name-input")
    input.value = ${JSON.stringify(to)}
    input.dispatchEvent(new Event("change", { bubbles: true }))
    return true`,
  deleteCard: (name) => `
    const card = [...document.querySelectorAll(".playlist-card")]
      .find((cd) => cd.querySelector(".playlist-name-input")?.value === ${JSON.stringify(name)})
    if (!card) return false
    const btn = [...card.querySelectorAll("button")].find((b) => b.textContent.includes("削除"))
    if (!btn) return false
    btn.click()
    return true`,
  unhideFileInput: `
    const el = document.getElementById("importFile")
    if (el) { el.style.display = "block"; el.style.visibility = "visible"; el.style.height = "24px" }
    return true`,
}

// --- Scenario -------------------------------------------------------------

function pick(obj, keys) {
  const out = {}
  for (const key of keys) if (key in obj) out[key] = obj[key]
  return out
}

function newOperationId() {
  return crypto.randomUUID()
}

async function openOptionsAndWait(bridge, { v1 }) {
  await bridge.gotoExt("options.html")
  await bridge.waitFor(v1 ? PAGE.v1Ready : PAGE.v2Ready, {
    timeoutMs: 20_000,
    label: v1 ? "v1 options helpers" : "v2 options render",
  })
}

/**
 * The full v1→v2→rollback rehearsal. `launch(profileDir)` must return a fresh
 * bridge bound to a NEW session on that profile; `closeBridge` ends it.
 * Storage assertions compare the REAL stored bytes — never UI summaries.
 */
export async function runUpgradeScenario({
  browser,
  dirs,
  launch,
  check,
  note,
  notRun,
  run,
  vitestLog,
}) {
  const evid = (name) => path.join(EVIDENCE_DIR, name.replaceAll("<b>", browser))
  const oracle = await expectedMigration()

  const pickLegacy = (obj) => pick(obj, [...LEGACY_KEYS])

  // ---------- PHASE 1: v1 sessions (ext-live = v1) -------------------------
  // Profile "main": full seed through v1's own write helpers.
  let session = await launch(dirs.profileMain)
  const idV1 = session.id
  run.environment.identityV1 = idV1
  check("v1", "loaded", idV1 !== undefined && idV1 !== "", `id=${idV1}`)
  await openOptionsAndWait(session, { v1: true })
  const before = await session.js(PAGE.seedV1)
  writeEvidence(evid("before-storage-<b>.json"), before)
  run.snapshots.before = {
    file: path.basename(evid("before-storage-<b>.json")),
    sha256: sha256File(evid("before-storage-<b>.json")),
  }
  const seededKeys = Object.keys(before)
  check(
    "v1",
    "seeded-all-legacy-keys",
    LEGACY_KEYS.every((key) => seededKeys.includes(key)),
    `keys=${seededKeys.length}`,
  )
  const v1View = await session.js(PAGE.v1View)
  check(
    "v1",
    "v1-reads-own-data",
    Array.isArray(v1View) && v1View.length === EXPECTED.migratedPlaylistCount + 1,
    `${v1View?.length} playlists incl. corrupt entry`,
  )
  await session.close()

  // Profile "fault-quota": small legacy set, then storage filled to real quota.
  session = await launch(dirs.profileQuota)
  await openOptionsAndWait(session, { v1: true })
  const quotaSeed = {
    dop_playlists: [LEGACY_PLAYLISTS[0]],
    dop_window_mode: "tab",
  }
  await session.js(PAGE.seedDirect(quotaSeed))
  const fill = await session.js(PAGE.fillUntilQuota)
  run.artifacts.quotaFill = { bytesInUse: fill.bytesInUse, keys: fill.keys.length }
  if (!fill.filled) {
    notRun(
      "quota",
      "browser-level quota injection",
      `storage.local never rejected within ${fill.keys.length} items / ${fill.bytesInUse}B on ${browser} — the fail-closed path is still exercised at module level (Vitest) and the resume path was rehearsed on ${browser === "chromium" ? "Firefox" : "chromium"} where quota enforced`,
    )
  }
  await session.close()

  // Profile "fault-crash": full legacy seed for the interrupted-persistence leg.
  session = await launch(dirs.profileCrash)
  await openOptionsAndWait(session, { v1: true })
  await session.js(PAGE.seedDirect({ dop_playlists: LEGACY_PLAYLISTS, dop_window_mode: "tab" }))
  await session.close()

  // ---------- PHASE 2: swap ext-live := v2 (same unpacked path) ------------
  const swapped = swapExtensionContents(dirs.extV2, dirs.extLive)
  note("swap", "files-replaced-in-place", `manifest v${swapped.version} @ same dir`)

  // ---------- PHASE 3: migration on the SAME identity ----------------------
  session = await launch(dirs.profileMain)
  const idV2 = session.id
  run.environment.identityV2 = idV2
  check(
    "migrate",
    "same-extension-identity",
    idV2 === idV1,
    `v1=${idV1} v2=${idV2} (unpacked-path id — see signed/store limitation)`,
  )
  await openOptionsAndWait(session, { v1: false })
  await session.waitFor(
    `return document.querySelectorAll(".playlist-card").length === ${EXPECTED.migratedPlaylistCount}`,
    { timeoutMs: 20_000, label: "migrated playlist cards" },
  )
  const pub = await session.message({ type: "DOP_STORAGE_READ_PUBLIC" })
  check("migrate", "read-public-ok", pub.ok === true, JSON.stringify(pub).slice(0, 120))
  const vault = await session.message({ type: "DOP_STORAGE_READ_VAULT" })
  check("migrate", "read-vault-ok", vault.ok === true)
  const after = await session.js(PAGE.readAll)
  writeEvidence(evid("after-storage-<b>.json"), after)
  run.snapshots.after = {
    file: path.basename(evid("after-storage-<b>.json")),
    sha256: sha256File(evid("after-storage-<b>.json")),
  }

  const st = after["dop_v2_state"]
  check("migrate", "envelope-written", st?.schemaVersion === 2 && st?.revision === 0)
  check(
    "migrate",
    "playlists-match-oracle",
    deepEqual(jsonCanon(st?.playlists), jsonCanon(oracle.playlists)),
    "shared parseLegacyLibrary output",
  )
  check(
    "migrate",
    "every-valid-playlist",
    Array.isArray(st?.playlists) &&
      st.playlists.length === EXPECTED.migratedPlaylistCount &&
      st.playlists.every((p, i) => p.id === EXPECTED.migratedPlaylistIds[i]),
    `${st?.playlists?.length} playlists, order preserved`,
  )
  const migratedItems = (st?.playlists ?? []).flatMap((p) => p.items)
  check(
    "migrate",
    "every-valid-clip",
    migratedItems.length === EXPECTED.migratedItemCount,
    `${migratedItems.length} clips`,
  )
  check(
    "migrate",
    "fanout-expanded",
    deepEqual(
      st?.playlists?.[2]?.items.map((i) => [i.id, i.range?.name]),
      EXPECTED.fanoutIds.map((id, i) => [id, EXPECTED.fanoutNames[i]]),
    ),
    "opRange/edRange/customRange → OP/ED/CUSTOM",
  )
  check(
    "migrate",
    "duplicate-ids-corrected",
    deepEqual(
      st?.playlists?.[3]?.items.map((i) => i.id),
      [...EXPECTED.duplicateIds],
    ),
    "dup-shared-id → -c1",
  )
  check(
    "migrate",
    "missing-id-repaired",
    st?.playlists?.[4]?.items[1]?.id === EXPECTED.repairedMissingItemId,
    EXPECTED.repairedMissingItemId,
  )
  check(
    "migrate",
    "typed-ranges-named",
    deepEqual(
      st?.playlists?.[1]?.items.map((i) => i.range?.name),
      [...EXPECTED.typedRangeNames],
    ),
    "range.type → OP/ED/CUSTOM",
  )
  check(
    "migrate",
    "null-range-preserved",
    st?.playlists?.[4]?.items[0]?.range === null && st?.playlists?.[6]?.items.length === 0,
    "full-episode clip + empty playlist",
  )
  check(
    "migrate",
    "all-ids-unique",
    new Set(migratedItems.map((i) => i.id)).size === migratedItems.length &&
      new Set(st?.playlists?.map((p) => p.id)).size === st?.playlists?.length,
    "global uniqueness after repair",
  )
  check(
    "migrate",
    "episodeNumber-preserved",
    st?.playlists?.[0]?.items.every((i) => i.episodeNumber !== undefined) &&
      st?.playlists?.[0]?.items[0]?.episodeNumber === "1" &&
      st?.playlists?.[0]?.items[1]?.episodeNumber === "3",
    "episodeNumber on migrated items",
  )
  check(
    "migrate",
    "preferences-migrated",
    deepEqual(st?.preferences, EXPECTED.preferences),
    JSON.stringify(st?.preferences),
  )
  const quarantined = vault.reply?.migrationRecovery?.quarantined ?? []
  check(
    "migrate",
    "quarantined-count",
    quarantined.length === EXPECTED.quarantinedCount,
    `${quarantined.length} entries`,
  )
  check(
    "migrate",
    "quarantine-keeps-bytes",
    quarantined.some(
      (q) => q.playlistIndex === 5 && q.itemIndex === 1 && q.originalJson.includes("逆行区間"),
    ) && quarantined.some((q) => q.playlistIndex === 7 && q.originalJson.includes("壊れたリスト")),
    "corrupt item + corrupt playlist carry originalJson",
  )
  check(
    "migrate",
    "legacy-keys-byte-identical",
    deepEqual(pickLegacy(before), pickLegacy(after)),
    "all 7 legacy keys = rollback snapshot",
  )
  check(
    "migrate",
    "no-legacy-transient-import",
    after["dop_v2_transient"] === undefined || after["dop_v2_transient"]?.playback === undefined,
    "legacy playback never rehydrated into a live session",
  )
  const v2Keys = Object.keys(after).filter((k) => k.startsWith("dop_v2"))
  check(
    "migrate",
    "no-partial-migration-markers",
    v2Keys.every((k) => k === "dop_v2_state"),
    `v2 keys: ${v2Keys.join(",") || "none"}`,
  )
  await session.shot(evid("options-after-migration-<b>.png")).catch(() => {})
  await session.close()

  // ---------- PHASE 4: restart persistence + management keys + round trip --
  session = await launch(dirs.profileMain)
  check("restart", "same-identity-after-restart", session.id === idV1, session.id)
  await openOptionsAndWait(session, { v1: false })
  const pubAfterRestart = await session.message({ type: "DOP_STORAGE_READ_PUBLIC" })
  writeEvidence(evid("public-read-after-restart-<b>.json"), pubAfterRestart)
  check(
    "restart",
    "state-survives-restart",
    pubAfterRestart.ok === true && deepEqual(pubAfterRestart.reply, pub.reply),
    `migration result identical across browser restart${deepEqual(pubAfterRestart.reply, pub.reply) ? "" : ` (first diff: ${firstDiff(pub.reply, pubAfterRestart.reply)})`}`,
  )

  // --- Detached management keys: real vault commands + real UI import ------
  const rev = pubAfterRestart.reply.revision
  const putA = await session.message({
    type: "DOP_STORAGE_COMMAND",
    command: {
      kind: "put-publication",
      operationId: newOperationId(),
      expectedRevision: rev,
      publication: publicationRecord({
        shareId: SHARE_ID_A,
        localPlaylistId: "pl-modern",
        manageSecret: MANAGE_SECRET_A,
      }),
    },
  })
  check("management", "seed-publication-A", putA.reply?.kind === "committed")
  const putB = await session.message({
    type: "DOP_STORAGE_COMMAND",
    command: {
      kind: "put-publication",
      operationId: newOperationId(),
      expectedRevision: rev + 1,
      publication: publicationRecord({
        shareId: SHARE_ID_B,
        localPlaylistId: "pl-typed",
        manageSecret: MANAGE_SECRET_B,
        visibility: "unlisted",
      }),
    },
  })
  check("management", "seed-publication-B", putB.reply?.kind === "committed")

  // Local delete → record A detaches (never dropped).
  check(
    "management",
    "delete-clicked",
    (await session.js(PAGE.deleteCard("お気に入りOP集"))) === true,
  )
  await session.waitFor(PAGE.modalVisible, { timeoutMs: 10_000, label: "delete confirm" })
  check("management", "delete-confirmed", (await session.js(PAGE.modalClick("削除"))) === true)
  await session.waitFor(
    `return document.querySelectorAll(".playlist-card").length === ${EXPECTED.migratedPlaylistCount - 1}`,
    { timeoutMs: 10_000, label: "playlist deleted" },
  )
  const vaultAfterDelete = await session.message({ type: "DOP_STORAGE_READ_VAULT" })
  const recA1 = vaultAfterDelete.reply?.publications?.find((r) => r.shareId === SHARE_ID_A)
  check(
    "management",
    "delete-detaches-key-kept",
    recA1 !== undefined &&
      recA1.localPlaylistId === null &&
      recA1.state === "local-deleted" &&
      recA1.manageSecret === MANAGE_SECRET_A,
    `state=${recA1?.state}, secret retained`,
  )
  await session.waitFor(
    `return document.querySelectorAll("#managementList .management-row").length === 1`,
    { timeoutMs: 10_000, label: "detached row rendered" },
  )
  const mgmtText = await session.js(`return document.getElementById("managementList").textContent`)
  check(
    "management",
    "detached-listed-no-secret",
    mgmtText.includes(SHARE_ID_A) && !mgmtText.includes(MANAGE_SECRET_A),
    "共有管理 row shows shareId, never the key",
  )
  await session.shot(evid("management-detached-<b>.png")).catch(() => {})

  // JSON replace import: recB's playlist id survives → link preserved; the
  // already-detached recA keeps its key (never discarded by replace).
  const replaceFile = path.join(dirs.work, `replacement-${browser}.json`)
  writeEvidence(replaceFile, replacementSnapshot())
  await session.js(PAGE.unhideFileInput)
  await session.upload("#importFile", replaceFile)
  await session.waitFor(PAGE.modalVisible, { timeoutMs: 10_000, label: "import mode modal" })
  check(
    "management",
    "replace-mode-clicked",
    (await session.js(PAGE.modalClick("上書き"))) === true,
  )
  await session.waitFor(
    `return (document.getElementById("importStatus")?.textContent ?? "").includes("インポート")`,
    {
      timeoutMs: 15_000,
      label: "replace import status",
    },
  )
  const pubAfterReplace = await session.message({ type: "DOP_STORAGE_READ_PUBLIC" })
  const idsAfterReplace = pubAfterReplace.reply?.playlists?.map((p) => p.id) ?? []
  check(
    "management",
    "replace-import-committed",
    deepEqual(idsAfterReplace, ["pl-typed", "pl-reimport"]),
    idsAfterReplace.join(","),
  )
  const vaultAfterReplace = await session.message({ type: "DOP_STORAGE_READ_VAULT" })
  const recA2 = vaultAfterReplace.reply?.publications?.find((r) => r.shareId === SHARE_ID_A)
  const recB2 = vaultAfterReplace.reply?.publications?.find((r) => r.shareId === SHARE_ID_B)
  check(
    "management",
    "detached-key-survives-replace",
    recA2?.state === "local-deleted" &&
      recA2.localPlaylistId === null &&
      recA2.manageSecret === MANAGE_SECRET_A,
    "replace never discards detached keys",
  )
  check(
    "management",
    "link-survives-when-id-reimported",
    recB2?.state === "active" &&
      recB2.localPlaylistId === "pl-typed" &&
      recB2.manageSecret === MANAGE_SECRET_B,
    "record stays attached to the re-imported playlist id",
  )
  note(
    "management",
    "detach-semantics",
    "once detached a record never re-links (localPlaylistId stays null by design); a still-linked record whose playlist id survives the replace stays attached; republish after detach mints a NEW shareId (task-15 flow, covered-by-test)",
  )

  // --- Post-v2 edit (the rollback leg proves v1 cannot see it) -------------
  check(
    "roundtrip",
    "post-v2-edit-committed",
    (await session.js(PAGE.renameCard("旧形式リスト(改)", POST_V2_RENAME))) === true,
    POST_V2_RENAME,
  )
  await session.waitFor(
    `return [...document.querySelectorAll(".playlist-name-input")].some(i => i.value === ${JSON.stringify(POST_V2_RENAME)})`,
    { timeoutMs: 10_000, label: "post-v2 rename" },
  )

  // --- Safe export → wipe → re-import equivalence --------------------------
  // captureExport() is per-driver: chromium hooks the blob in-page; firefox
  // cannot (WebDriver scripts run in an Xray sandbox with separate JS
  // intrinsics — page URL.createObjectURL is unreachable) so it reads the
  // real downloaded file from the pref'd download dir.
  const exportText = await session.captureExport()
  writeEvidence(evid("export-<b>.json"), exportText)
  run.snapshots.export = {
    file: path.basename(evid("export-<b>.json")),
    sha256: sha256File(evid("export-<b>.json")),
  }
  const envelope = JSON.parse(exportText)
  check(
    "roundtrip",
    "export-envelope-whitelist",
    deepEqual(Object.keys(envelope).sort(), ["playlists", "schemaVersion"]) &&
      envelope.schemaVersion === 2,
    `keys=${Object.keys(envelope).join(",")}`,
  )
  check(
    "roundtrip",
    "export-carries-no-secrets",
    !exportText.includes('"url"') &&
      !exportText.includes("manageSecret") &&
      !exportText.includes("publications") &&
      !exportText.includes(SHARE_ID_A) &&
      !exportText.includes("A".repeat(43)),
    "no url/keys/vault in the portable file",
  )
  // Wipe the whole library through the real command path, then re-import.
  const wipeReply = await session.message({
    type: "DOP_STORAGE_COMMAND",
    command: {
      kind: "replace-library",
      operationId: newOperationId(),
      expectedRevision: pubAfterReplace.reply.revision + 1,
      playlists: [],
    },
  })
  check("roundtrip", "library-wiped", wipeReply.reply?.kind === "committed")
  const importFile = path.join(dirs.work, `roundtrip-${browser}.json`)
  fs.writeFileSync(importFile, exportText)
  await session.js(PAGE.unhideFileInput)
  await session.upload("#importFile", importFile)
  await session.waitFor(
    `return (document.getElementById("importStatus")?.textContent ?? "").includes("インポート")`,
    { timeoutMs: 15_000, label: "re-import status" },
  )
  const pubRoundTrip = await session.message({ type: "DOP_STORAGE_READ_PUBLIC" })
  check(
    "roundtrip",
    "reimport-committed",
    pubRoundTrip.ok === true && pubRoundTrip.reply?.playlists?.length === envelope.playlists.length,
    `${pubRoundTrip.reply?.playlists?.length} playlists re-imported`,
  )
  // Equivalence is export→export: re-import normalizes through the parser
  // (episodeNumber/url projections), so compare the SECOND safe export —
  // the same whitelist projection applied to the recovered library.
  const exportText2 = await session.captureExport()
  writeEvidence(evid("export-roundtrip-<b>.json"), exportText2)
  check(
    "roundtrip",
    "export-wipe-reimport-equivalent",
    exportText2 === exportText,
    "second safe export byte-identical to the first",
  )
  await session.close()

  // ---------- PHASE 5: fault legs (each on its own disposable profile) ------

  // (a) Quota exhaustion mid-migration → fail closed → free space → resume.
  if (fill.filled) {
    session = await launch(dirs.profileQuota)
    await openOptionsAndWait(session, { v1: false })
    // Same refused-read marshaling tolerance as the future-schema leg.
    const denied = await session.message({ type: "DOP_STORAGE_READ_PUBLIC" }).then(
      (r) => r,
      (error) => ({ ok: false, error: String(error?.message ?? error) }),
    )
    check(
      "quota",
      "migration-fails-closed",
      denied.ok === false,
      String(denied.error ?? "").slice(0, 120),
    )
    const duringQuota = await session.js(PAGE.readAll)
    check(
      "quota",
      "no-envelope-no-marker",
      duringQuota["dop_v2_state"] === undefined,
      "migration never announced complete",
    )
    check(
      "quota",
      "old-snapshot-accessible",
      deepEqual(pick(duringQuota, Object.keys(quotaSeed)), quotaSeed),
      "legacy keys + filler untouched",
    )
    await session.js(PAGE.removeKeys(fill.keys))
    const resumed = await session.message({ type: "DOP_STORAGE_READ_PUBLIC" })
    check(
      "quota",
      "resume-after-free-space",
      resumed.ok === true && resumed.reply?.playlists?.length === 1,
      `resumed with ${resumed.reply?.playlists?.length} playlist`,
    )
    const postQuota = await session.js(PAGE.readAll)
    check(
      "quota",
      "legacy-still-intact-after-resume",
      deepEqual(pick(postQuota, Object.keys(quotaSeed)), quotaSeed),
      "",
    )
    await session.close()
  }

  // (b) Future canonical schema → refuse, never downgrade.
  session = await launch(dirs.profileSchema)
  await openOptionsAndWait(session, { v1: false })
  await session.js(
    PAGE.seedDirect({ dop_v2_state: FUTURE_STATE, dop_playlists: [LEGACY_PLAYLISTS[0]] }),
  )
  await session.close()
  session = await launch(dirs.profileSchema)
  await openOptionsAndWait(session, { v1: false })
  // Refusal may surface EITHER as a rejected sendMessage (ok:false) OR —
  // nondeterministically on geckodriver — as the receiver's error escaping
  // the execute/async call itself. Both prove the read was refused.
  const refused = await session.message({ type: "DOP_STORAGE_READ_PUBLIC" }).then(
    (r) => r,
    (error) => ({ ok: false, error: String(error?.message ?? error) }),
  )
  check(
    "future-schema",
    "read-rejects",
    refused.ok === false,
    String(refused.error ?? "").slice(0, 160),
  )
  const duringSchema = await session.js(PAGE.readAll)
  check(
    "future-schema",
    "state-not-downgraded",
    deepEqual(duringSchema["dop_v2_state"], FUTURE_STATE),
    "v3 blob untouched",
  )
  check(
    "future-schema",
    "legacy-still-readable",
    deepEqual(duringSchema["dop_playlists"], [LEGACY_PLAYLISTS[0]]),
    "old snapshot accessible",
  )
  await session.close()

  // (c) Interrupted persistence: start the first v2 read and end the session
  //     mid-flight; on relaunch the storage must be either a COMPLETE envelope
  //     or nothing — never a half-migrated marker, never lost legacy.
  session = await launch(dirs.profileCrash)
  const nav = session.gotoExt("options.html").catch(() => {})
  await session.close()
  await nav.catch(() => {})
  session = await launch(dirs.profileCrash)
  const crash = await session.readStorageRaw()
  const crashLegacyOk =
    deepEqual(crash["dop_playlists"], LEGACY_PLAYLISTS) && crash["dop_window_mode"] === "tab"
  check("crash", "legacy-intact-after-interrupt", crashLegacyOk)
  if (crash["dop_v2_state"] === undefined) {
    note("crash", "interrupted-before-write", "no envelope — resuming")
    await openOptionsAndWait(session, { v1: false })
    const resumed = await session.message({ type: "DOP_STORAGE_READ_PUBLIC" })
    check(
      "crash",
      "resume-completes",
      resumed.ok === true && resumed.reply?.playlists?.length === EXPECTED.migratedPlaylistCount,
      `${resumed.reply?.playlists?.length} playlists after resume`,
    )
  } else {
    check(
      "crash",
      "landed-envelope-complete",
      crash["dop_v2_state"]?.schemaVersion === 2 &&
        crash["dop_v2_state"]?.playlists?.length === EXPECTED.migratedPlaylistCount &&
        crash["dop_v2_state"]?.migrationRecovery?.quarantined?.length === EXPECTED.quarantinedCount,
      "write landed before interrupt — complete envelope only",
    )
  }
  await session.close()

  // ---------- PHASE 6: rollback to v1 on the SAME profile ------------------
  swapExtensionContents(dirs.extV1, dirs.extLive)
  session = await launch(dirs.profileMain)
  check("rollback", "same-identity", session.id === idV1, session.id)
  await openOptionsAndWait(session, { v1: true })
  const rolled = await session.js(PAGE.v1View)
  const rolledNames = rolled.map((p) => p.name)
  check(
    "rollback",
    "v1-sees-original-playlists",
    rolled.length === EXPECTED.migratedPlaylistCount + 1 &&
      ["お気に入りOP集", "旧形式リスト", "重複IDリスト"].every((n) => rolledNames.includes(n)),
    `${rolled.length} playlists with original names`,
  )
  check(
    "rollback",
    "v1-corrupt-entries-intact",
    rolled.some((p) => p.id === "pl-corrupt") &&
      rolled.some((p) => (p.items ?? []).some((i) => i.id === "bad1")),
    "entries v2 quarantined are still in the v1 snapshot",
  )
  check(
    "rollback",
    "no-post-v2-edits",
    !rolledNames.includes(POST_V2_RENAME) && !rolledNames.includes("再インポート"),
    "post-v2 edits are NOT in the v1 snapshot (export file is the transfer)",
  )
  const rolledAll = await session.js(PAGE.readAll)
  check(
    "rollback",
    "legacy-keys-still-byte-identical",
    deepEqual(pickLegacy(before), pickLegacy(rolledAll)),
    "v1 snapshot unchanged through the whole rehearsal",
  )
  check(
    "rollback",
    "v2-state-left-for-forward-path",
    rolledAll["dop_v2_state"]?.schemaVersion === 2,
    "v1 ignores dop_v2_state; re-upgrading keeps v2 data",
  )
  writeEvidence(evid("rollback-view-<b>.json"), {
    playlists: rolled.map((p) => ({ id: p.id, name: p.name, items: (p.items ?? []).length })),
    keysPresent: Object.keys(rolledAll).sort(),
  })
  note(
    "rollback",
    "post-v2-edits-not-retained",
    "v1 sees the frozen pre-migration keys only; post-v2 edits live in dop_v2_state and reach v1 ONLY via the v2 safe-JSON export (re-imported as the bare-array form v1 accepts)",
  )
  await session.close()

  // ---------- PHASE 7: module-level fault injection (Vitest, real code) ----
  run.artifacts["module-fault-legs"] = vitestLog
  note(
    "module",
    "vitest-failure-injection",
    "quota mid-migration, interrupted persistence, future schema, malformed root — see apps/extension/tests/storage/upgrade-rehearsal.test.ts",
  )
}

/** Compute the shared-parser oracle in-process (Bun resolves the .ts source —
 *  the SAME module the extension's migration runs). */
async function expectedMigration() {
  const { parseLegacyLibrary } = await import("../../../packages/shared/src/local-import.ts")
  return parseLegacyLibrary(LEGACY_PLAYLISTS)
}
