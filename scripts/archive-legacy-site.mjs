#!/usr/bin/env node
// archive-legacy-site — task 29 durable archive refs for the legacy hosting
// branches BEFORE any retirement.
//
// Creates local archive tags that pin the exact commits being retired:
//
//   archive/gh-pages-pre-cutover -> origin/gh-pages (the GitHub Pages site)
//   archive/dev-pre-cutover      -> origin/dev      (the long-lived dev branch)
//
// gh-pages is an ORPHAN history (no merge-base with main) — archiving is a
// tag, never a merge. The plan-preserved site revision
// 59399be1419f830cb7b0b54c509692d41e9b48e2 is the expected gh-pages target;
// a moved remote ref requires an explicit --allow-moved override so a silent
// upstream change can never archive the wrong commit.
//
// The script writes a full `git ls-tree -r` manifest per branch (the owned
// site asset list, with blob SHAs) and verifies every created tag resolves
// to the intended commit. It NEVER deletes or moves a branch or tag — the
// destructive steps live, documented but unexecuted, in docs/cutover.md.
//
// Usage:
//   node scripts/archive-legacy-site.mjs                    # create + verify local tags
//   node scripts/archive-legacy-site.mjs --verify-only      # re-verify existing tags
//   node scripts/archive-legacy-site.mjs --push             # push tags to origin (operator)
//   node scripts/archive-legacy-site.mjs --fetch            # fetch origin refs first
//
// Exit 0 = archive refs exist (or were created) and resolve correctly.
// Exit 1 = any failure. Exit 2 = bad arguments.

import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const EXPECTED_GH_PAGES = "59399be1419f830cb7b0b54c509692d41e9b48e2" // plan-preserved
const TAG_GH_PAGES = "archive/gh-pages-pre-cutover"
const TAG_DEV = "archive/dev-pre-cutover"
const FULL_SHA = /^[0-9a-f]{40}$/

function usage(message) {
  console.error(`archive-legacy-site: ${message}`)
  console.error(
    "usage: node scripts/archive-legacy-site.mjs [--verify-only] [--push] [--fetch] " +
      "[--allow-moved] [--gh-pages <sha>] [--dev <sha>] [--manifest-dir <dir>] [--evidence <path>]",
  )
  process.exit(2)
}

// --- args ------------------------------------------------------------------

const args = process.argv.slice(2)
let verifyOnly = false
let push = false
let fetchFirst = false
let allowMoved = false
let ghPagesSha
let devSha
let manifestDir
let evidencePath
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === "--verify-only") {
    verifyOnly = true
  } else if (arg === "--push") {
    push = true
  } else if (arg === "--fetch") {
    fetchFirst = true
  } else if (arg === "--allow-moved") {
    allowMoved = true
  } else if (arg === "--gh-pages") {
    ghPagesSha = args[++i]
  } else if (arg?.startsWith("--gh-pages=")) {
    ghPagesSha = arg.slice("--gh-pages=".length)
  } else if (arg === "--dev") {
    devSha = args[++i]
  } else if (arg?.startsWith("--dev=")) {
    devSha = arg.slice("--dev=".length)
  } else if (arg === "--manifest-dir") {
    manifestDir = args[++i]
  } else if (arg?.startsWith("--manifest-dir=")) {
    manifestDir = arg.slice("--manifest-dir=".length)
  } else if (arg === "--evidence") {
    evidencePath = args[++i]
  } else if (arg?.startsWith("--evidence=")) {
    evidencePath = arg.slice("--evidence=".length)
  } else {
    usage(`unknown argument: ${arg}`)
  }
}
for (const [name, sha] of [
  ["--gh-pages", ghPagesSha],
  ["--dev", devSha],
]) {
  if (sha !== undefined && !FULL_SHA.test(sha)) {
    usage(`${name} must be a full 40-char commit sha, got: ${sha}`)
  }
}

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: dirname(fileURLToPath(import.meta.url)),
  encoding: "utf8",
}).trim()
manifestDir ??= join(repoRoot, ".omo", "evidence", "task-29-d-op-v2-share")

// --- git helpers -------------------------------------------------------------

function git(...argv) {
  return execFileSync("git", argv, { cwd: repoRoot, encoding: "utf8" }).trim()
}

function gitOk(...argv) {
  try {
    return { ok: true, out: git(...argv) }
  } catch (error) {
    return { ok: false, out: "", err: error?.stderr?.toString() ?? error?.message ?? "" }
  }
}

function objectType(ref) {
  const res = gitOk("cat-file", "-t", ref)
  return res.ok ? res.out : null
}

function resolveRef(ref) {
  const res = gitOk("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)
  return res.ok ? res.out : null
}

// --- flow --------------------------------------------------------------------

const results = []
let failed = false

function record(name, status, detail) {
  results.push({ name, status, detail })
  const tag = status === "pass" ? "ok" : status === "skip" ? "skip" : "FAIL"
  console.log(`[${tag}] ${name}: ${detail}`)
}

function fail(name, detail) {
  record(name, "fail", detail)
  failed = true
}

if (fetchFirst) {
  const res = gitOk("fetch", "origin", "gh-pages", "dev", "--tags")
  if (res.ok) {
    record("fetch", "pass", "origin gh-pages/dev fetched")
  } else {
    fail("fetch", `git fetch failed: ${res.err.split("\n")[0]}`)
  }
}

// Resolve the target commits.
let ghPagesSource = "origin/gh-pages"
if (ghPagesSha === undefined) {
  ghPagesSha = resolveRef("origin/gh-pages")
  if (ghPagesSha === null) {
    fail(
      "resolve:gh-pages",
      "origin/gh-pages is not resolvable — fetch it (--fetch) or pass --gh-pages <sha>",
    )
    ghPagesSha = ""
  }
} else {
  ghPagesSource = "--gh-pages"
}
if (devSha === undefined) {
  devSha = resolveRef("origin/dev")
  if (devSha === null) {
    fail("resolve:dev", "origin/dev is not resolvable — fetch it (--fetch) or pass --dev <sha>")
    devSha = ""
  }
}

// The gh-pages target must be the plan-preserved site revision unless the
// operator explicitly acknowledges a moved remote.
if (ghPagesSha !== "" && ghPagesSha !== EXPECTED_GH_PAGES && !allowMoved) {
  fail(
    "gh-pages-revision",
    `${ghPagesSource} gave ${ghPagesSha}, not the plan-preserved ` +
      `${EXPECTED_GH_PAGES}. If the remote legitimately moved, re-run with ` +
      "--allow-moved after confirming the new tip is the intended site state.",
  )
} else if (ghPagesSha !== "") {
  const moved = ghPagesSha === EXPECTED_GH_PAGES ? "" : " (moved tip accepted via --allow-moved)"
  record("gh-pages-revision", "pass", `${ghPagesSha}${moved}`)
}

// --- create / verify tags -----------------------------------------------------

function ensureTag(name, sha, branchLabel) {
  if (sha === "") {
    fail(`tag:${name}`, "no target commit resolved — see earlier failure")
    return null
  }
  const type = objectType(sha)
  if (type !== "commit") {
    fail(`tag:${name}`, `${sha} is ${type ?? "missing"}, expected a commit object`)
    return null
  }
  const existing = resolveRef(`refs/tags/${name}`)
  if (existing !== null) {
    if (existing === sha) {
      record(`tag:${name}`, "pass", `already archived at ${sha}`)
      return existing
    }
    fail(
      `tag:${name}`,
      `tag exists at ${existing}, expected ${sha} — archive tags are ` +
        "immutable and are never moved; resolve the discrepancy manually",
    )
    return null
  }
  if (verifyOnly) {
    fail(`tag:${name}`, `archive tag missing (verify-only mode); create it without --verify-only`)
    return null
  }
  const created = gitOk("tag", name, sha)
  if (!created.ok) {
    fail(`tag:${name}`, `git tag failed: ${created.err.split("\n")[0]}`)
    return null
  }
  const resolved = resolveRef(`refs/tags/${name}`)
  if (resolved !== sha) {
    fail(`tag:${name}`, `created tag resolves to ${resolved}, expected ${sha}`)
    return null
  }
  record(`tag:${name}`, "pass", `${branchLabel} archived at ${sha}`)
  return resolved
}

// --- tree manifest -------------------------------------------------------------

// The manifest always describes the resolved archive ref, never the CLI
// input — a refused/mismatched target can never overwrite the real
// asset list with a wrong tree.
function writeManifest(name, tagSha, tagName) {
  if (tagSha === null) {
    record(`manifest:${name}`, "skip", "skipped — the archive tag did not resolve cleanly")
    return
  }
  const tree = gitOk("ls-tree", "-r", "-l", tagSha)
  if (!tree.ok) {
    fail(`manifest:${name}`, `git ls-tree failed: ${tree.err.split("\n")[0]}`)
    return
  }
  mkdirSync(manifestDir, { recursive: true })
  const file = join(manifestDir, `${name}-tree.txt`)
  const header =
    `# legacy-site asset manifest (task 29 archive)\n` +
    `# ref: ${tagName} -> ${tagSha}\n` +
    `# format: <mode> <type> <blob-sha> <size>\\t<path>\n` +
    `# recorded: ${new Date().toISOString()}\n`
  writeFileSync(file, `${header}${tree.out}\n`)
  const entries = tree.out === "" ? 0 : tree.out.split("\n").length
  record(`manifest:${name}`, "pass", `${entries} entries -> ${file}`)
}

const ghPagesTagSha = ensureTag(TAG_GH_PAGES, ghPagesSha, "gh-pages site")
const devTagSha = ensureTag(TAG_DEV, devSha, "dev branch")
writeManifest("gh-pages", ghPagesTagSha, TAG_GH_PAGES)
writeManifest("dev", devTagSha, TAG_DEV)

// --- optional push -------------------------------------------------------------

const pushed = []
if (push && !failed) {
  for (const tagName of [TAG_GH_PAGES, TAG_DEV]) {
    const res = gitOk("push", "origin", `refs/tags/${tagName}`)
    if (res.ok) {
      pushed.push(tagName)
      record(`push:${tagName}`, "pass", res.out.split("\n")[0] || "pushed")
    } else {
      fail(`push:${tagName}`, `git push failed: ${res.err.split("\n")[0]}`)
    }
  }
  const remote = gitOk("ls-remote", "--tags", "origin", "refs/tags/archive/*")
  if (remote.ok) {
    record("remote-archive-refs", "pass", remote.out.split("\n").join(" | "))
  }
} else if (push && failed) {
  record("push", "skip", "push skipped — fix the failures above first")
} else {
  record(
    "push",
    "skip",
    "local tags only — the operator pushes at cutover time: " +
      `git push origin ${TAG_GH_PAGES} ${TAG_DEV}`,
  )
}

// --- summary -------------------------------------------------------------------

const evidence = {
  tool: "archive-legacy-site",
  spec: "task-29 d-op-v2-share",
  at: new Date().toISOString(),
  repoRoot,
  verifyOnly,
  pushed,
  expectedGhPages: EXPECTED_GH_PAGES,
  targets: { ghPages: ghPagesSha, dev: devSha },
  manifestDir,
  results,
  verdict: failed ? "FAIL" : "PASS",
}
if (evidencePath !== undefined) {
  mkdirSync(dirname(evidencePath), { recursive: true })
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`[evidence] written to ${evidencePath}`)
}

if (failed) {
  console.error(
    `archive-legacy-site FAIL: ${results
      .filter((r) => r.status === "fail")
      .map((r) => r.name)
      .join(", ")}`,
  )
  process.exit(1)
}
console.log(
  `archive-legacy-site ${verifyOnly ? "VERIFY" : "PASS"}: ` +
    `${TAG_GH_PAGES} -> ${ghPagesSha}, ${TAG_DEV} -> ${devSha}`,
)
process.exit(0)
