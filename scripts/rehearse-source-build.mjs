#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { logicalDigest, readZip } from "./lib/zip.mjs"

// Task-25 source-archive clean-build rehearsal.
//
// Unpacks apps/extension/.output/d-op-<version>-sources.zip into a fresh temp
// dir, runs `bun install --frozen-lockfile` + `bun run build` there, then
// compares the rebuilt extension zips against the repo's release zips by
// logical content (sorted name→sha256 map — immune to timestamps/ordering;
// the toolchain already zeroes timestamps so byte equality is also reported).
//
// Proves the AMO source archive is complete and the build is reproducible.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OUTPUT_DIR = path.join(ROOT, "apps/extension/.output")
const sha256 = (data) => createHash("sha256").update(data).digest("hex")

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(" ")}  (cwd=${cwd})`)
  const opts = {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }
  try {
    return execFileSync(cmd, args, opts)
  } catch (err) {
    // Volta-style Windows shims are bun.cmd batch files needing cmd.exe.
    if ((err.code === "ENOENT" || err.code === "EINVAL") && process.platform === "win32")
      return execFileSync(`${cmd} ${args.join(" ")}`, { ...opts, shell: true })
    throw err
  }
}

function main() {
  const version = JSON.parse(
    fs.readFileSync(path.join(ROOT, "apps/extension/package.json"), "utf-8"),
  ).version
  const srcZip = path.join(OUTPUT_DIR, `d-op-${version}-sources.zip`)
  if (!fs.existsSync(srcZip)) throw new Error(`missing ${srcZip} — run "bun run build" first`)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d-op-src-rehearsal-"))
  console.log(`extracting ${path.relative(ROOT, srcZip)} -> ${tmp}`)
  const entries = readZip(fs.readFileSync(srcZip))
  for (const [name, content] of entries) {
    const dest = path.join(tmp, name)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, content)
  }

  try {
    const bunInstall = run("bun", ["install", "--frozen-lockfile"], tmp)
    console.log(bunInstall.trim().split("\n").slice(-3).join("\n"))

    const build = run("bun", ["run", "build"], tmp)
    console.log(build.trim().split("\n").slice(-12).join("\n"))

    let mismatches = 0
    for (const browser of ["chrome", "firefox"]) {
      const rel = path.join(OUTPUT_DIR, `d-op-${version}-${browser}.zip`)
      const reb = path.join(tmp, "apps/extension/.output", `d-op-${version}-${browser}.zip`)
      if (!fs.existsSync(reb)) {
        console.error(`FAIL rehearsal: rebuilt artifact missing ${reb}`)
        mismatches++
        continue
      }
      const relBytes = fs.readFileSync(rel)
      const rebBytes = fs.readFileSync(reb)
      const relDigest = logicalDigest(readZip(relBytes), sha256)
      const rebDigest = logicalDigest(readZip(rebBytes), sha256)
      const logicalEqual = relDigest === rebDigest
      const byteEqual = relBytes.equals(rebBytes)
      console.log(
        `${browser}: logical content ${logicalEqual ? "IDENTICAL" : "DIFFERS"} (entries ${readZip(relBytes).size}), byte-equal ${byteEqual}`,
      )
      if (!logicalEqual) {
        mismatches++
        const relLines = new Set(relDigest.split("\n"))
        for (const line of rebDigest.split("\n"))
          if (!relLines.has(line)) console.error(`  diff: ${line}`)
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true })
    if (mismatches > 0) {
      console.error(`rehearsal FAILED — ${mismatches} artifact(s) differ`)
      process.exit(1)
    }
    console.log("rehearsal PASSED — source archive rebuilds identical logical artifacts")
  } catch (err) {
    console.error(`rehearsal FAILED: ${err.message}`)
    if (err.stdout) console.error(String(err.stdout).slice(-4000))
    if (err.stderr) console.error(String(err.stderr).slice(-4000))
    process.exit(1)
  }
}

main()
