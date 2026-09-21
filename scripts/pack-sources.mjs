#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { writeZip } from "./lib/zip.mjs"

// Task-25 AMO reproducible source archive (`bun run pack:sources`, also the
// last step of `bun run build`).
//
// Firefox add-on review requires uploading the source used to produce the
// submitted bundle. This packs the whole buildable workspace — lockfile
// included — into apps/extension/.output/d-op-<version>-sources.zip with a
// generated BUILD-INSTRUCTIONS.md at the archive root. The archive is
// deterministic: sorted entries, zeroed timestamps (scripts/lib/zip.mjs).
//
// scripts/verify-artifacts.mjs asserts the required entries exist and no
// generated/secret material leaks in; the clean-build rehearsal
// (docs/release.md, recorded in .omo/evidence/task-25-*) proves the
// archive rebuilds byte-identical logical artifacts.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OUTPUT_DIR = path.join(ROOT, "apps/extension/.output")

// Explicit include roots — deterministic regardless of git index state.
const INCLUDE_FILES = [
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "tsconfig.base.json",
  "biome.jsonc",
  "vitest.unit.config.ts",
  "playwright.config.ts",
  "LICENSE",
  "README.md",
  "PRIVACY.md",
  "STORE_LISTING.md",
  "AGENTS.md",
  ".gitignore",
]
const INCLUDE_DIRS = [
  "apps",
  "packages",
  "scripts",
  "docs",
  "tests",
  "test",
  "icons",
  "assets",
  ".github",
]
const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".output",
  ".wxt",
  ".astro",
  ".wrangler",
  "dist",
  ".git",
  ".omo",
  ".codegraph",
  ".playwright-mcp",
  "test-results",
  "playwright-report",
  "tools",
  "memo",
])
const EXCLUDE_FILES = new Set([".dev.vars", "worker-configuration.d.ts"])
const EXCLUDE_EXTENSIONS = /\.(zip|crx|pem|key|p12|pfx)$/i

function collect(absDir, relBase, entries) {
  for (const item of fs
    .readdirSync(absDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relBase === "" ? item.name : `${relBase}/${item.name}`
    if (item.isDirectory()) {
      if (EXCLUDE_DIRS.has(item.name)) continue
      collect(path.join(absDir, item.name), rel, entries)
    } else if (item.isFile()) {
      if (EXCLUDE_FILES.has(item.name) || EXCLUDE_EXTENSIONS.test(item.name)) continue
      entries.set(rel, fs.readFileSync(path.join(absDir, item.name)))
    }
  }
}

function buildInstructions(version) {
  return `# d-OP ${version} — reproducible build instructions

This archive contains the complete source used to produce the release
artifacts (AMO source-review requirement). It builds deterministically: the
same tree always yields byte-identical logical artifacts.

## Requirements

- Bun ≥ 1.3.13 (CI pins 1.3.13; the lockfile format is Bun's, so
  \`bun install\` is the only supported dependency step — do not substitute
  npm/pnpm)
- Node.js ≥ 20 for the packaging scripts (scripts/*.mjs)
- No store credentials, signing keys, or network-external services are needed
  for the build itself

## Steps

\`\`\`sh
unzip d-op-${version}-sources.zip -d d-op-src
cd d-op-src
bun install --frozen-lockfile   # pinned deps incl. wxt/vite/astro
bun run build                   # WXT production builds + zips + this archive
\`\`\`

## Outputs

- \`apps/extension/.output/chrome-mv3/\` + \`d-op-${version}-chrome.zip\`
  — Chrome MV3 bundle (\`background.service_worker\`)
- \`apps/extension/.output/firefox-mv3/\` + \`d-op-${version}-firefox.zip\`
  — Firefox MV3 bundle (\`background.scripts\`, gecko id \`d-op@sasnews.dev\`)
- \`apps/extension/.output/d-op-${version}-sources.zip\` — this archive
- \`apps/web/dist/\` — the optional Share site (not part of the extension)

## Verifying

\`\`\`sh
node scripts/verify-artifacts.mjs            # unpacks zips, asserts identity/permissions/content
node scripts/verify-artifacts.mjs --self-test # proves every check can fail
\`\`\`

To compare a rebuilt zip against a released one, compare logical content
(sorted name → SHA-256 lines) — ZIP timestamps are already zeroed by the
toolchain, so byte equality is expected for identical inputs.

## Privacy note

Ordinary extension use is local-only; the optional Share feature talks to
\`d-op.sasnews.dev\` only after explicit in-extension consent. No telemetry,
analytics, or remote code is present in the extension packages.
`
}

function run() {
  const version = JSON.parse(
    fs.readFileSync(path.join(ROOT, "apps/extension/package.json"), "utf-8"),
  ).version
  const entries = new Map()
  for (const file of INCLUDE_FILES) {
    const abs = path.join(ROOT, file)
    if (fs.existsSync(abs)) entries.set(file, fs.readFileSync(abs))
    else console.log(`note: ${file} absent — skipped`)
  }
  for (const dir of INCLUDE_DIRS) {
    const abs = path.join(ROOT, dir)
    if (fs.existsSync(abs)) collect(abs, dir, entries)
  }
  entries.set("BUILD-INSTRUCTIONS.md", Buffer.from(buildInstructions(version), "utf-8"))

  const zip = writeZip(entries)
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const out = path.join(OUTPUT_DIR, `d-op-${version}-sources.zip`)
  fs.writeFileSync(out, zip)
  console.log(
    `packed ${entries.size} source files -> ${path.relative(ROOT, out)} (${zip.length} bytes, sha256 ${createHash("sha256").update(zip).digest("hex")})`,
  )
}

run()
