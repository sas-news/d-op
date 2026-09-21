import fs from "node:fs"
import path from "node:path"

// Task-23 native-test extension variant. Real browsers cannot intercept
// https:// traffic the way Playwright routes do, so the harness installs a
// byte-patched COPY of the built production extension into a temp dir:
//
//   * every occurrence of the share origin literal "https://d-op.sasnews.dev"
//     in JS/manifest is replaced by the local share origin (exactly what the
//     non-production `allowedShareOrigins()` block does at build time);
//   * manifest content-script matches for the two d-Anime scripts gain the
//     loopback fixture origin (the shipped matches stay untouched);
//   * host_permissions gain the loopback fixture + share origins;
//   * web_accessible_resources.matches gain the fixture origin so the
//     main-world adapter script can be injected on fixture pages;
//   * browser_specific_settings.gecko.id may be renamed so a second variant
//     can coexist in one profile (used by the 503 leg only when needed).
//
// The patched copy is a TEST ARTIFACT in a temp dir — it never lands in
// .output (check-test-origins guards that) and never ships.

const PROD_SHARE_ORIGIN = "https://d-op.sasnews.dev"

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else fs.copyFileSync(from, to)
  }
}

function walkFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

/**
 * Build the native-test variant of a built extension directory.
 * Returns { dir, patchedFiles, manifestSummary } for evidence.
 */
export function buildExtensionVariant({
  srcDir,
  destDir,
  shareOrigin,
  fixtureOrigin,
  geckoId, // optional override; default keeps the real id
}) {
  if (!fs.existsSync(path.join(srcDir, "manifest.json"))) {
    throw new Error(`extension build missing: ${srcDir} (run wxt build first)`)
  }
  fs.rmSync(destDir, { recursive: true, force: true })
  copyTree(srcDir, destDir)

  const patchedFiles = {}
  let totalReplacements = 0
  for (const file of walkFiles(destDir)) {
    if (!/\.(js|json|html|css)$/.test(file)) continue
    const before = fs.readFileSync(file, "utf8")
    if (!before.includes(PROD_SHARE_ORIGIN)) continue
    const after = before.replaceAll(PROD_SHARE_ORIGIN, shareOrigin)
    fs.writeFileSync(file, after)
    const count = before.split(PROD_SHARE_ORIGIN).length - 1
    patchedFiles[path.relative(destDir, file)] = count
    totalReplacements += count
  }
  if (totalReplacements === 0) {
    throw new Error(`share-origin literal not found in ${srcDir} — patch contract broken`)
  }

  const manifestPath = path.join(destDir, "manifest.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))

  // Match patterns cannot carry a port — an invalid pattern makes Firefox
  // silently drop the whole content-script entry. Match patterns ignore the
  // URL port anyway, so strip it from every pattern field while keeping the
  // port in JS fetch/share-origin literals.
  const fixtureHostNoPort = fixtureOrigin.replace(/:\d+$/, "")
  const stripPorts = (patterns) =>
    patterns?.map((p) => p.replace(/^([a-z]+:\/\/[^/]+):\d+(\/.*)/, "$1$2"))

  for (const script of manifest.content_scripts ?? []) {
    script.matches = stripPorts(script.matches)
    script.exclude_matches = stripPorts(script.exclude_matches)
    const js = script.js?.[0] ?? ""
    if (js.includes("danime-player")) {
      script.matches.push(`${fixtureHostNoPort}/animestore/sc_d_pc*`)
    } else if (js.includes("danime-store")) {
      script.matches.push(`${fixtureHostNoPort}/animestore/*`)
      script.exclude_matches = script.exclude_matches ?? []
      script.exclude_matches.push(`${fixtureHostNoPort}/animestore/sc_d_pc*`)
    }
  }
  manifest.host_permissions = stripPorts(manifest.host_permissions) ?? []
  manifest.host_permissions.push(`${fixtureHostNoPort}/*`)
  for (const resource of manifest.web_accessible_resources ?? []) {
    resource.matches = stripPorts(resource.matches) ?? []
    resource.matches.push(`${fixtureHostNoPort}/*`)
  }
  if (geckoId !== undefined && manifest.browser_specific_settings?.gecko !== undefined) {
    manifest.browser_specific_settings.gecko.id = geckoId
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  return {
    dir: destDir,
    patchedFiles,
    totalReplacements,
    manifestSummary: {
      contentScripts: manifest.content_scripts.map((s) => ({
        js: s.js,
        matches: s.matches,
        exclude_matches: s.exclude_matches,
      })),
      hostPermissions: manifest.host_permissions,
      webAccessible: manifest.web_accessible_resources,
      geckoId: manifest.browser_specific_settings?.gecko?.id,
    },
  }
}
