import { execFileSync, execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

// Task-23 binary discovery for the native browser gate. Only REAL supported
// binaries qualify: installed Firefox/ESR, installed branded Chrome (recorded
// — but branded Chrome ≥137 cannot sideload unsigned extensions, see below),
// official Chrome for Testing archives, and official geckodriver releases.
// The bundled Playwright chromium is NEVER a valid target for this gate.
//
// Resolution order per leg:
//   1. Explicit env override (DOP_*_PATH) — operator-provided, always wins.
//   2. tools/browser-cache/<...> — the harness-managed download cache.
//   3. Well-known install locations / registry.
//   4. Auto-provision (download) when --allow-download is set; else NOT RUN.

const REPO_ROOT = path.resolve(
  new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
)
export const CACHE_DIR = path.join(REPO_ROOT, "tools", "browser-cache")

const exists = (p) => p !== undefined && fs.existsSync(p)

/** File version of a Windows PE via PowerShell VersionInfo (no launch). */
export function fileVersion(exePath) {
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `(Get-Item -LiteralPath '${exePath.replaceAll("'", "''")}').VersionInfo.FileVersion`,
    ],
    { encoding: "utf8", timeout: 20_000 },
  ).trim()
  return out === "" ? undefined : out
}

/** `firefox.exe --version` prints "Mozilla Firefox X.Y" and exits cleanly. */
export function firefoxVersion(exePath) {
  try {
    const out = execFileSync(exePath, ["--version"], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    }).trim()
    const match = /Firefox\s+([0-9][\d.]*(?:esr)?[a-z0-9]*)/i.exec(out) ?? /([0-9][\d.]*)/.exec(out)
    return match?.[1] ?? out
  } catch {
    return fileVersion(exePath)
  }
}

function registrySearch(pattern) {
  // Enumerate HKLM uninstall keys + Mozilla keys for matching display names.
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '${pattern}' } | ForEach-Object { $_.InstallLocation } | Select-Object -First 1`,
      ],
      { encoding: "utf8", timeout: 20_000 },
    ).trim()
    return out === "" ? undefined : out
  } catch {
    return undefined
  }
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate !== undefined && fs.existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Firefox stable: the real installed binary (registry → Program Files →
 * per-user installs). Returns {path, source} or undefined.
 */
export function resolveFirefoxStable() {
  const env = process.env["DOP_FIREFOX_PATH"]?.trim()
  if (exists(env)) return { path: env, source: "env:DOP_FIREFOX_PATH" }
  const installDir = registrySearch("Mozilla Firefox")
  const found = firstExisting([
    installDir === undefined ? undefined : path.join(installDir, "firefox.exe"),
    "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
    "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
    process.env["LOCALAPPDATA"] === undefined
      ? undefined
      : path.join(process.env["LOCALAPPDATA"], "Mozilla Firefox", "firefox.exe"),
  ])
  return found === undefined ? undefined : { path: found, source: "installed" }
}

/**
 * Firefox ESR: env → cache (extracted MSI payload) → common ESR install dirs.
 * Auto-provision downloads the official Mozilla MSI and extracts the inner
 * NSIS installer with 7-Zip (no system install — ESR shares the stable
 * install dir name, so a real installer run could clobber stable).
 */
export function resolveFirefoxEsr() {
  const env = process.env["DOP_FIREFOX_ESR_PATH"]?.trim()
  if (exists(env)) return { path: env, source: "env:DOP_FIREFOX_ESR_PATH" }
  const found = firstExisting([
    path.join(CACHE_DIR, "firefox-esr", "core", "firefox.exe"),
    path.join(CACHE_DIR, "firefox-esr", "firefox.exe"),
    "C:\\Program Files\\Mozilla Firefox ESR\\firefox.exe",
    "C:\\Program Files\\Firefox ESR\\firefox.exe",
    "C:\\Program Files (x86)\\Mozilla Firefox ESR\\firefox.exe",
  ])
  return found === undefined ? undefined : { path: found, source: "installed-or-cached" }
}

/** Download + extract the current FIREFOX_ESR release into the cache. */
export async function provisionFirefoxEsr() {
  const meta = await (
    await fetch("https://product-details.mozilla.org/1.0/firefox_versions.json", {
      signal: AbortSignal.timeout(20_000),
    })
  ).json()
  const version = meta["FIREFOX_ESR"]
  if (typeof version !== "string") throw new Error("FIREFOX_ESR missing in product-details")
  const msiUrl = `https://download-installer.cdn.mozilla.net/pub/firefox/releases/${version}/win64/en-US/Firefox%20Setup%20${version}.msi`
  const msiPath = path.join(CACHE_DIR, `firefox-esr-${version}.msi`)
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  if (!fs.existsSync(msiPath)) {
    process.stderr.write(`[browsers] downloading ${msiUrl}\n`)
    const res = await fetch(msiUrl)
    if (!res.ok) throw new Error(`ESR MSI download failed: HTTP ${res.status}`)
    fs.writeFileSync(msiPath, Buffer.from(await res.arrayBuffer()))
  }
  const sevenZip = firstExisting([
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe",
    execSync("where.exe 7z 2>NUL", { encoding: "utf8" }).split(/\r?\n/)[0]?.trim(),
  ])
  if (sevenZip === undefined) {
    throw new Error("7-Zip required to extract the Firefox ESR MSI payload")
  }
  const innerDir = path.join(CACHE_DIR, "firefox-esr-inner")
  fs.rmSync(innerDir, { recursive: true, force: true })
  execFileSync(sevenZip, ["x", "-y", `-o${innerDir}`, msiPath, "Binary.WrappedExe"], {
    stdio: "inherit",
  })
  const outDir = path.join(CACHE_DIR, "firefox-esr")
  fs.rmSync(outDir, { recursive: true, force: true })
  execFileSync(
    sevenZip,
    ["x", "-y", `-o${outDir}`, path.join(innerDir, "Binary.WrappedExe"), "core/*"],
    { stdio: "inherit" },
  )
  fs.rmSync(innerDir, { recursive: true, force: true })
  const exe = path.join(outDir, "core", "firefox.exe")
  if (!fs.existsSync(exe)) throw new Error("ESR extraction produced no core/firefox.exe")
  return { path: exe, source: `downloaded:${version}` }
}

/** Installed branded Chrome (recorded; cannot sideload unsigned MV3 ≥137). */
export function probeInstalledChrome() {
  const found = firstExisting([
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env["LOCALAPPDATA"] === undefined
      ? undefined
      : path.join(process.env["LOCALAPPDATA"], "Google", "Chrome", "Application", "chrome.exe"),
  ])
  return found === undefined ? undefined : { path: found, version: fileVersion(found) }
}

/**
 * Chrome for Testing is Google's official archive of actual release binaries
 * and the supported sideload path since branded Chrome 137 dropped
 * --load-extension. `channel` is "stable" (current stable version) or
 * "previous" (last build of the previous major).
 */
export async function resolveChromeForTesting(channel) {
  const envKey = channel === "stable" ? "DOP_CHROME_PATH" : "DOP_CHROME_PREVIOUS_PATH"
  const env = process.env[envKey]?.trim()
  if (exists(env)) return { path: env, source: `env:${envKey}` }
  const versions = await chromeForTestingVersions()
  const wanted = channel === "stable" ? versions.stable : versions.previousMajor
  if (wanted === undefined) return undefined
  const cached = path.join(CACHE_DIR, `chrome-${wanted.major}`, "chrome-win64", "chrome.exe")
  if (fs.existsSync(cached)) {
    return { path: cached, source: `chrome-for-testing:${wanted.version}`, version: wanted.version }
  }
  return {
    path: undefined,
    source: `chrome-for-testing:${wanted.version}`,
    version: wanted.version,
    download: wanted.download,
  }
}

async function chromeForTestingVersions() {
  const [knownGood, lastGood] = await Promise.all([
    (
      await fetch(
        "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json",
        { signal: AbortSignal.timeout(20_000) },
      )
    ).json(),
    (
      await fetch(
        "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json",
        { signal: AbortSignal.timeout(20_000) },
      )
    ).json(),
  ])
  const stableEntry = lastGood.channels?.Stable
  const stableDownload = stableEntry?.downloads?.chrome?.find((d) => d.platform === "win64")?.url
  const stableMajor = Number(stableEntry?.version?.split(".")[0])
  const previousMajor = stableMajor - 1
  const candidates = knownGood.versions
    .filter((v) => v.version.startsWith(`${previousMajor}.`))
    .map((v) => ({
      version: v.version,
      major: previousMajor,
      download: v.downloads?.chrome?.find((d) => d.platform === "win64")?.url,
    }))
    .filter((v) => v.download !== undefined)
  return {
    stable: {
      version: stableEntry?.version,
      major: stableMajor,
      download: stableDownload,
    },
    previousMajor: candidates.at(-1),
  }
}

export async function provisionChromeForTesting(channel) {
  const resolved = await resolveChromeForTesting(channel)
  if (resolved === undefined || resolved.download === undefined) {
    throw new Error(`no Chrome for Testing download resolved for channel ${channel}`)
  }
  if (resolved.path !== undefined) return resolved
  const zipPath = path.join(CACHE_DIR, `chrome-win64-${resolved.version}.zip`)
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  if (!fs.existsSync(zipPath)) {
    process.stderr.write(`[browsers] downloading ${resolved.download}\n`)
    const res = await fetch(resolved.download)
    if (!res.ok) throw new Error(`CfT download failed: HTTP ${res.status}`)
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
  }
  const outDir = path.join(CACHE_DIR, `chrome-${resolved.version.split(".")[0]}`)
  fs.rmSync(outDir, { recursive: true, force: true })
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${outDir}'`,
    ],
    { stdio: "inherit" },
  )
  const exe = path.join(outDir, "chrome-win64", "chrome.exe")
  if (!fs.existsSync(exe)) throw new Error(`CfT extract produced no chrome.exe: ${outDir}`)
  return { path: exe, source: `chrome-for-testing:${resolved.version}`, version: resolved.version }
}

/** geckodriver: env → cache → PATH → auto-download (latest release). */
export async function resolveGeckodriver({ allowDownload = false } = {}) {
  const env = process.env["DOP_GECKODRIVER_PATH"]?.trim()
  if (exists(env)) return { path: env, source: "env:DOP_GECKODRIVER_PATH" }
  const cached = path.join(CACHE_DIR, "geckodriver", "geckodriver.exe")
  if (fs.existsSync(cached)) return { path: cached, source: "cached" }
  try {
    const found = execSync("where.exe geckodriver 2>NUL", { encoding: "utf8" })
      .split(/\r?\n/)[0]
      ?.trim()
    if (exists(found)) return { path: found, source: "path" }
  } catch {}
  if (!allowDownload) return undefined
  const release = await (
    await fetch("https://api.github.com/repos/mozilla/geckodriver/releases/latest", {
      signal: AbortSignal.timeout(20_000),
    })
  ).json()
  const asset = release.assets?.find((a) => /win64\.zip$/.test(a.name))
  if (asset === undefined) throw new Error("no win64 geckodriver asset in latest release")
  const zipPath = path.join(CACHE_DIR, "geckodriver.zip")
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  process.stderr.write(`[browsers] downloading ${asset.browser_download_url}\n`)
  const res = await fetch(asset.browser_download_url)
  if (!res.ok) throw new Error(`geckodriver download failed: HTTP ${res.status}`)
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${path.join(CACHE_DIR, "geckodriver")}'`,
    ],
    { stdio: "inherit" },
  )
  return { path: cached, source: `downloaded:${release.tag_name}` }
}

export function geckodriverVersion(exePath) {
  try {
    return execFileSync(exePath, ["--version"], { encoding: "utf8", timeout: 10_000 })
      .split(/\r?\n/)[0]
      ?.trim()
  } catch {
    return undefined
  }
}

export { CACHE_DIR as BROWSER_CACHE }
