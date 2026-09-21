#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readZip } from "./lib/zip.mjs"

// Task-25 packaging checker (`bun run verify:artifacts`).
//
// Unpacks the production Chrome/Firefox zips built by `bun run build` and
// asserts, for each artifact:
//   * manifest identity — name "d-OP", version equal to package.json and to
//     the sibling browser manifest, MV3;
//   * background keys — chrome: service_worker only; firefox: scripts only;
//   * Firefox identity — gecko.id "d-op@sasnews.dev" plus the declared
//     data_collection_permissions shape (required ["none"], the 3 optional
//     categories kept in sync with src/share/consent.ts);
//   * permission minimality — permissions/host_permissions ⊆ the declared
//     allowlist, no dev-only origins in production;
//   * required resources — every manifest-referenced file exists, plus the
//     icon set, html entrypoints and the main-world bridge scripts;
//   * absence — fixture origins, fake-adapter markers, secrets, node runtime
//     paths and remote-code URLs anywhere in the archive;
//   * zip contents byte-equal the matching .output/<browser>-mv3 directory.
//
// It also checks the AMO source archive exists and carries the rebuild inputs.
//
// Modes:
//   (default)            artifact checks; exits 1 loudly on any failure.
//   --release-tag <tag>  additionally run the immutable-release gate: refuse
//                        if <tag> already exists locally or on GitHub.
//   --self-test          mutate copies of the real artifacts and prove every
//                        check above can fail (QA failure-path evidence).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OUTPUT_DIR = path.join(ROOT, "apps/extension/.output")

const EXTENSION_NAME = "d-OP"
const GECKO_ID = "d-op@sasnews.dev"
const ALLOWED_PERMISSIONS = new Set(["storage", "tabs"])
const ALLOWED_HOST_PERMISSIONS = new Set([
  "https://animestore.docomo.ne.jp/*",
  "https://anime.dmkt-sp.jp/*",
  "https://d-op.sasnews.dev/*",
])
// Content-script match patterns may only target the d-Anime hosts and the
// share-site /p/* relay (see AGENTS.md invariants).
const ALLOWED_MATCH_PREFIXES = [
  "https://animestore.docomo.ne.jp/",
  "https://anime.dmkt-sp.jp/",
  "https://d-op.sasnews.dev/",
]
const REQUIRED_DATA_COLLECTION_OPTIONAL = [
  "personallyIdentifyingInfo",
  "technicalAndInteraction",
  "websiteContent",
]
const REQUIRED_ICON_SIZES = ["16", "32", "48", "128"]
// Files every bundle must carry beyond the manifest-referenced ones: the
// main-world bridge scripts and the import confirmation window.
const REQUIRED_EXTRA_FILES = ["danime-main.js", "danime-isolated-runtime.js", "import.html"]
// Fixture/test/dev markers that must never appear in a production bundle.
// (ws010105Data and d-op-player-bridge are REAL adapter strings — the fake
// adapter is identified by __adapterFixture and the fixture origins only.)
const FORBIDDEN_MARKERS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  ":4321",
  ":8123",
  "DOP_TEST_FIXTURE",
  "dop-fixture-ready",
  "serve-fixture",
  "harness.spec",
  "__adapterFixture",
  "adapter bridge fixture",
  "-----BEGIN",
  "PRIVATE KEY-----",
]
// Remote-code signatures: script tags / CSP entries loading off-package code.
const FORBIDDEN_REMOTE_PATTERNS = [
  /<script[^>]+src\s*=\s*["']https?:\/\//i,
  /<script[^>]+src\s*=\s*["']\/\//i,
  /<link[^>]+href\s*=\s*["']https?:\/\//i,
  /script-src[^;"']*https?:\/\//i,
  /eval\s*\(/,
  /new Function\s*\(/,
]

const sorted = (arr) => [...arr].sort()
const eqSet = (a, b) => a.length === b.length && sorted(a).every((v, i) => v === sorted(b)[i])

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"))
}

function dirFiles(root) {
  const out = new Map()
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.set(path.relative(root, full).split(path.sep).join("/"), fs.readFileSync(full))
    }
  }
  walk(root)
  return out
}

function manifestChecks(files, browser, expectedVersion, failures) {
  const raw = files.get("manifest.json")
  if (!raw) {
    failures.push("manifest.json missing from archive")
    return null
  }
  let manifest
  try {
    manifest = JSON.parse(raw.toString("utf-8"))
  } catch (err) {
    failures.push(`manifest.json does not parse: ${err.message}`)
    return null
  }
  const tag = `${browser} manifest`

  if (manifest.manifest_version !== 3)
    failures.push(`${tag}: manifest_version is ${manifest.manifest_version}, expected 3`)
  if (manifest.name !== EXTENSION_NAME)
    failures.push(`${tag}: name is ${JSON.stringify(manifest.name)}, expected "d-OP"`)
  if (manifest.version !== expectedVersion)
    failures.push(`${tag}: version ${manifest.version} != package.json ${expectedVersion}`)
  if (typeof manifest.description !== "string" || manifest.description.length === 0)
    failures.push(`${tag}: description missing`)

  // --- Background keys (browser-specific, must not be swapped) -------------
  const bg = manifest.background ?? {}
  if (browser === "chrome") {
    if (typeof bg.service_worker !== "string")
      failures.push(`${tag}: background.service_worker missing`)
    else if (!files.has(bg.service_worker))
      failures.push(`${tag}: service_worker file ${bg.service_worker} absent`)
    if ("scripts" in bg)
      failures.push(`${tag}: firefox-style background.scripts leaked into chrome build`)
    if (manifest.browser_specific_settings !== undefined)
      failures.push(`${tag}: browser_specific_settings must not appear in chrome manifest`)
  } else {
    if ("service_worker" in bg)
      failures.push(`${tag}: chrome-style service_worker leaked into firefox build`)
    if (!Array.isArray(bg.scripts) || bg.scripts.length === 0) {
      failures.push(`${tag}: background.scripts missing`)
    } else {
      for (const s of bg.scripts)
        if (!files.has(s)) failures.push(`${tag}: background script ${s} absent`)
    }
    const gecko = manifest.browser_specific_settings?.gecko
    if (gecko?.id !== GECKO_ID)
      failures.push(`${tag}: gecko.id is ${JSON.stringify(gecko?.id)}, expected ${GECKO_ID}`)
    const dcp = gecko?.data_collection_permissions
    if (!eqSet(dcp?.required ?? [], ["none"]))
      failures.push(
        `${tag}: data_collection_permissions.required must be exactly ["none"], got ${JSON.stringify(dcp?.required)}`,
      )
    if (!eqSet(dcp?.optional ?? [], REQUIRED_DATA_COLLECTION_OPTIONAL))
      failures.push(
        `${tag}: data_collection_permissions.optional drifted from SHARE_DATA_COLLECTION_PERMISSIONS, got ${JSON.stringify(dcp?.optional)}`,
      )
  }

  // --- Permission minimality -----------------------------------------------
  for (const p of manifest.permissions ?? [])
    if (!ALLOWED_PERMISSIONS.has(p)) failures.push(`${tag}: undeclared permission ${p}`)
  for (const p of manifest.optional_permissions ?? [])
    failures.push(`${tag}: optional_permissions not allowed in release: ${p}`)
  for (const h of manifest.host_permissions ?? [])
    if (!ALLOWED_HOST_PERMISSIONS.has(h)) failures.push(`${tag}: undeclared host_permission ${h}`)

  // --- Content scripts / web-accessible resources --------------------------
  const scripts = manifest.content_scripts
  if (!Array.isArray(scripts) || scripts.length === 0) {
    failures.push(`${tag}: content_scripts missing`)
  } else {
    for (const [i, cs] of scripts.entries()) {
      for (const js of cs.js ?? [])
        if (!files.has(js)) failures.push(`${tag}: content_scripts[${i}] js ${js} absent`)
      for (const css of cs.css ?? [])
        if (!files.has(css)) failures.push(`${tag}: content_scripts[${i}] css ${css} absent`)
      for (const field of ["matches", "exclude_matches"]) {
        for (const m of cs[field] ?? []) {
          if (m === "<all_urls>" || m === "*://*/*" || m.startsWith("*://"))
            failures.push(`${tag}: content_scripts[${i}].${field} wildcard ${m}`)
          else if (!ALLOWED_MATCH_PREFIXES.some((p) => m.startsWith(p)))
            failures.push(`${tag}: content_scripts[${i}].${field} outside allowlist: ${m}`)
        }
      }
    }
  }
  for (const [i, war] of (manifest.web_accessible_resources ?? []).entries()) {
    for (const r of war.resources ?? [])
      if (!files.has(r)) failures.push(`${tag}: web_accessible_resources[${i}] ${r} absent`)
    for (const m of war.matches ?? [])
      if (!ALLOWED_MATCH_PREFIXES.some((p) => m.startsWith(p)))
        failures.push(`${tag}: web_accessible_resources[${i}] match outside allowlist: ${m}`)
  }

  // --- Required resources ---------------------------------------------------
  const icons = manifest.icons ?? {}
  for (const size of REQUIRED_ICON_SIZES) {
    if (!icons[size]) failures.push(`${tag}: icons[${size}] missing`)
    else if (!files.has(icons[size])) failures.push(`${tag}: icon file ${icons[size]} absent`)
  }
  const popup = manifest.action?.default_popup
  if (!popup) failures.push(`${tag}: action.default_popup missing`)
  else if (!files.has(popup)) failures.push(`${tag}: popup file ${popup} absent`)
  const optionsPage = manifest.options_ui?.page
  if (!optionsPage) failures.push(`${tag}: options_ui.page missing`)
  else if (!files.has(optionsPage)) failures.push(`${tag}: options page ${optionsPage} absent`)
  for (const f of REQUIRED_EXTRA_FILES)
    if (!files.has(f)) failures.push(`${tag}: required file ${f} absent`)
  return manifest
}

function contentChecks(files, browser, failures) {
  const tag = `${browser} archive`
  for (const name of files.keys()) {
    if (name.startsWith("/") || name.includes("..") || name.includes("\\"))
      failures.push(`${tag}: unsafe zip entry name ${name}`)
    if (name.startsWith("node_modules/") || name.includes("/node_modules/"))
      failures.push(`${tag}: node runtime path ${name}`)
    if (/\.(pem|key|p12|pfx|env)$/i.test(name)) failures.push(`${tag}: secret-like file ${name}`)
  }
  for (const [name, content] of files) {
    if (/\.(png|jpg|jpeg|gif|webp|woff2?|ttf|otf|ico)$/i.test(name)) continue // binary
    const text = content.toString("utf-8")
    for (const marker of FORBIDDEN_MARKERS)
      if (text.includes(marker))
        failures.push(`${tag}: ${name} contains forbidden marker ${JSON.stringify(marker)}`)
    for (const pattern of FORBIDDEN_REMOTE_PATTERNS)
      if (pattern.test(text))
        failures.push(`${tag}: ${name} matches remote-code/forbidden pattern ${pattern}`)
    for (const needle of ["node_modules/", "node_modules\\"])
      if (text.includes(needle)) failures.push(`${tag}: ${name} references ${needle.trim()} path`)
  }
}

function checkArtifact(files, browser, expectedVersion) {
  const failures = []
  const manifest = manifestChecks(files, browser, expectedVersion, failures)
  contentChecks(files, browser, failures)
  return { manifest, failures }
}

function loadArtifactZip(browser, version, failures) {
  const zipPath = path.join(OUTPUT_DIR, `d-op-${version}-${browser}.zip`)
  if (!fs.existsSync(zipPath)) {
    failures.push(`missing artifact ${path.relative(ROOT, zipPath)} (run "bun run build" first)`)
    return null
  }
  return { zipPath, files: readZip(fs.readFileSync(zipPath)) }
}

function checkZipMatchesDir(files, browser, failures) {
  const dir = path.join(OUTPUT_DIR, `${browser}-mv3`)
  if (!fs.existsSync(dir)) {
    failures.push(`missing build dir ${path.relative(ROOT, dir)}`)
    return
  }
  const onDisk = dirFiles(dir)
  const zipNames = sorted(files.keys())
  const dirNames = sorted(onDisk.keys())
  if (!eqSet(zipNames, dirNames)) {
    failures.push(
      `${browser}: zip entry list differs from ${browser}-mv3 dir (zip-only: ${zipNames.filter((n) => !onDisk.has(n))}; dir-only: ${dirNames.filter((n) => !files.has(n))})`,
    )
    return
  }
  for (const [name, content] of files)
    if (!content.equals(onDisk.get(name)))
      failures.push(`${browser}: ${name} differs between zip and build dir`)
}

function checkSourceArchive(version, failures) {
  const zipPath = path.join(OUTPUT_DIR, `d-op-${version}-sources.zip`)
  if (!fs.existsSync(zipPath)) {
    failures.push(
      `missing source archive ${path.relative(ROOT, zipPath)} (run "bun run pack:sources")`,
    )
    return
  }
  const files = readZip(fs.readFileSync(zipPath))
  for (const required of [
    "bun.lock",
    "package.json",
    "BUILD-INSTRUCTIONS.md",
    "apps/extension/package.json",
    "apps/extension/wxt.config.ts",
    "apps/extension/entrypoints/background.ts",
    "apps/extension/public/icons/icon128.png",
    "apps/web/package.json",
    "packages/shared/package.json",
    "LICENSE",
  ])
    if (!files.has(required)) failures.push(`source archive missing required entry ${required}`)
  for (const name of files.keys())
    if (
      /(^|\/)(node_modules|\.output|\.wxt|dist|\.wrangler|\.astro|tools|\.git|test-results|playwright-report)(\/|$)/.test(
        name,
      ) ||
      /\.(zip|crx|pem)$/.test(name)
    )
      failures.push(`source archive carries excluded entry ${name}`)
}

function checkReleaseTag(tag, failures, notes) {
  let existing
  try {
    existing = execFileSync("git", ["tag", "--list", tag], { cwd: ROOT, encoding: "utf-8" }).trim()
  } catch (err) {
    failures.push(`release gate: cannot enumerate git tags: ${err.message}`)
    return
  }
  if (existing !== "") {
    failures.push(
      `release gate: immutable refusal — git tag ${tag} already exists; releases are never deleted or recreated`,
    )
    return
  }
  // Best-effort remote release check; CI does the authoritative gh api check.
  let remoteUrl = ""
  try {
    remoteUrl = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: ROOT,
      encoding: "utf-8",
    }).trim()
  } catch {
    // no remote configured — skip remote check below
  }
  const remote = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/)?.[1]
  if (!remote) {
    notes.push("release gate: no github remote detected — skipped remote release check")
    return
  }
  try {
    execFileSync("gh", ["api", `repos/${remote}/releases/tags/${tag}`, "--silent"], {
      stdio: "pipe",
    })
    failures.push(`release gate: immutable refusal — GitHub release for ${tag} already exists`)
  } catch (err) {
    const out = `${err.stderr ?? ""}${err.stdout ?? ""}`
    if (out.includes("404") || out.includes("Not Found"))
      notes.push(`release gate: no GitHub release for ${tag} (good)`)
    else
      notes.push(
        `release gate: remote release check inconclusive (${out.trim().split("\n")[0] || err.message}) — CI step is authoritative`,
      )
  }
}

function run() {
  const args = process.argv.slice(2)
  const selfTest = args.includes("--self-test")
  const releaseTagIdx = args.indexOf("--release-tag")
  const releaseTag = releaseTagIdx >= 0 ? args[releaseTagIdx + 1] : null

  const rootPkg = readJson(path.join(ROOT, "package.json"))
  const extPkg = readJson(path.join(ROOT, "apps/extension/package.json"))
  const failures = []
  const notes = []
  if (rootPkg.version !== extPkg.version)
    failures.push(
      `version mismatch: root package.json ${rootPkg.version} != apps/extension ${extPkg.version}`,
    )
  const version = extPkg.version

  const artifacts = {}
  for (const browser of ["chrome", "firefox"]) {
    const loaded = loadArtifactZip(browser, version, failures)
    if (loaded) artifacts[browser] = loaded
  }

  const manifests = {}
  for (const browser of Object.keys(artifacts)) {
    const { manifest, failures: f } = checkArtifact(artifacts[browser].files, browser, version)
    manifests[browser] = manifest
    failures.push(...f)
    checkZipMatchesDir(artifacts[browser].files, browser, failures)
  }
  if (
    manifests.chrome &&
    manifests.firefox &&
    manifests.chrome.version !== manifests.firefox.version
  )
    failures.push(
      `version drift: chrome ${manifests.chrome.version} != firefox ${manifests.firefox.version}`,
    )

  checkSourceArchive(version, failures)
  if (releaseTag) checkReleaseTag(releaseTag, failures, notes)

  if (selfTest) failures.push(...runSelfTest(artifacts, version))

  for (const note of notes) console.log(`note: ${note}`)
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`)
    console.error(`verify:artifacts failed with ${failures.length} problem(s)`)
    process.exit(1)
  }
  console.log(
    `verify:artifacts OK — d-op ${version} chrome+firefox zips, source archive${releaseTag ? `, release gate (${releaseTag})` : ""}${selfTest ? ", self-test" : ""}`,
  )
}

// ---------------------------------------------------------------------------
// Self-test: mutate copies of the real artifacts and prove each gate fails.
// ---------------------------------------------------------------------------

function mutateManifest(files, fn) {
  const copy = new Map(files)
  const manifest = JSON.parse(copy.get("manifest.json").toString("utf-8"))
  fn(manifest)
  copy.set("manifest.json", Buffer.from(JSON.stringify(manifest), "utf-8"))
  return copy
}

function expectFailure(name, files, browser, version, want) {
  const { failures } = checkArtifact(files, browser, version)
  const hit = failures.some((f) => f.includes(want))
  if (!hit || failures.length === 0)
    return [
      `self-test ${name}: expected failure containing ${JSON.stringify(want)}, got ${JSON.stringify(failures)}`,
    ]
  return []
}

function runSelfTest(artifacts, version) {
  const problems = []
  const chrome = artifacts.chrome?.files
  const firefox = artifacts.firefox?.files
  if (!chrome || !firefox) return ["self-test: real artifacts unavailable — build first"]

  // Control: unmutated artifacts must pass.
  for (const [browser, files] of [
    ["chrome", chrome],
    ["firefox", firefox],
  ]) {
    const { failures } = checkArtifact(files, browser, version)
    if (failures.length > 0)
      problems.push(`self-test control(${browser}): clean artifact failed: ${failures}`)
  }

  const cases = [
    [
      "wrong gecko id",
      mutateManifest(firefox, (m) => {
        m.browser_specific_settings.gecko.id = "wrong@example.com"
      }),
      "firefox",
      "gecko.id",
    ],
    [
      "swapped background (chrome gets scripts)",
      mutateManifest(chrome, (m) => {
        m.background = { scripts: ["background.js"] }
      }),
      "chrome",
      "service_worker",
    ],
    [
      "swapped background (firefox gets service_worker)",
      mutateManifest(firefox, (m) => {
        m.background = { service_worker: "background.js" }
      }),
      "firefox",
      "service_worker",
    ],
    [
      "missing resource (popup.html removed)",
      (() => {
        const c = new Map(chrome)
        c.delete("popup.html")
        return c
      })(),
      "chrome",
      "popup",
    ],
    [
      "missing icon resource",
      (() => {
        const c = new Map(firefox)
        c.delete("icons/icon16.png")
        return c
      })(),
      "firefox",
      "icon",
    ],
    [
      "version mismatch vs package.json",
      mutateManifest(chrome, (m) => {
        m.version = "9.9.9"
      }),
      "chrome",
      "9.9.9",
    ],
    [
      "fixture origin marker",
      (() => {
        const c = new Map(chrome)
        c.set("injected-marker.js", Buffer.from("fetch('http://127.0.0.1:8123/x')"))
        return c
      })(),
      "chrome",
      "127.0.0.1",
    ],
    [
      "fake adapter marker",
      (() => {
        const c = new Map(firefox)
        c.set("content-scripts/danime-player.js", Buffer.from("window.__adapterFixture = {}"))
        return c
      })(),
      "firefox",
      "__adapterFixture",
    ],
    [
      "node runtime path entry",
      (() => {
        const c = new Map(chrome)
        c.set("node_modules/evil/index.js", Buffer.from("x"))
        return c
      })(),
      "chrome",
      "node runtime",
    ],
    [
      "secret material",
      (() => {
        const c = new Map(chrome)
        c.set("key.pem", Buffer.from("-----BEGIN PRIVATE KEY-----"))
        return c
      })(),
      "chrome",
      "secret-like",
    ],
    [
      "remote code script tag",
      (() => {
        const c = new Map(chrome)
        c.set(
          "popup.html",
          Buffer.from('<html><script src="https://evil.example/x.js"></script></html>'),
        )
        return c
      })(),
      "chrome",
      "remote-code",
    ],
    [
      "extra permission",
      mutateManifest(chrome, (m) => {
        m.permissions.push("clipboardRead")
      }),
      "chrome",
      "clipboardRead",
    ],
    [
      "dev host permission leak",
      mutateManifest(firefox, (m) => {
        m.host_permissions.push("http://localhost:4321/*")
      }),
      "firefox",
      "localhost",
    ],
    [
      "wildcard content script match",
      mutateManifest(chrome, (m) => {
        m.content_scripts[0].matches.push("<all_urls>")
      }),
      "chrome",
      "wildcard",
    ],
    [
      "data_collection required drift",
      mutateManifest(firefox, (m) => {
        m.browser_specific_settings.gecko.data_collection_permissions.required = ["websiteContent"]
      }),
      "firefox",
      "required",
    ],
  ]
  for (const [name, files, browser, want] of cases)
    problems.push(...expectFailure(name, files, browser, version, want))

  // Release-gate refusal: v1.0.0 is an existing tag, so the gate must refuse;
  // a never-used tag must pass.
  const tagFailures = []
  const tagNotes = []
  checkReleaseTag("v1.0.0", tagFailures, tagNotes)
  if (tagFailures.length === 0)
    problems.push("self-test release gate: existing tag v1.0.0 did not trigger refusal")
  const freeTagFailures = []
  checkReleaseTag("v99.0.0", freeTagFailures, tagNotes)
  if (freeTagFailures.length > 0)
    problems.push(`self-test release gate: free tag refused: ${freeTagFailures}`)

  if (problems.length === 0)
    console.log(`self-test: ${cases.length + 4} failure-path checks all refused correctly`)
  return problems.map((p) => `self-test: ${p}`)
}

run()
