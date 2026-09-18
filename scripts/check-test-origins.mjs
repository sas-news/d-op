import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

// Task-5 baseline artifact checker (runs in CI after `bun run build`).
// Proves test-only origins and fixture markers are absent from production
// build output. Missing output directories are a hard failure, never a pass:
// the build must run before this check so absence cannot masquerade as clean.
const OUTPUT_ROOTS = ["apps/extension/.output", "apps/web/dist"]
const FORBIDDEN_MARKERS = [
  "DOP_TEST_FIXTURE",
  "127.0.0.1:8123",
  "dop-fixture-ready",
  "serve-fixture",
  "harness.spec",
]

async function collectFiles(root) {
  const entries = await readdir(root)
  const files = []
  for (const entry of entries) {
    const full = join(root, entry)
    const info = await stat(full)
    if (info.isDirectory()) {
      files.push(...(await collectFiles(full)))
    } else {
      files.push(full)
    }
  }
  return files
}

const { readFile } = await import("node:fs/promises")

const failures = []
for (const root of OUTPUT_ROOTS) {
  let files
  try {
    files = await collectFiles(root)
  } catch {
    console.error(`missing build output: ${root} (run "bun run build" first)`)
    process.exitCode = 1
    continue
  }
  for (const file of files) {
    const bytes = await readFile(file)
    for (const marker of FORBIDDEN_MARKERS) {
      if (bytes.includes(Buffer.from(marker))) {
        failures.push(`${file} contains forbidden marker ${marker}`)
      }
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure)
  }
  process.exitCode = 1
} else if (process.exitCode !== 1) {
  console.log(`test-origin check clean: ${OUTPUT_ROOTS.join(", ")}`)
}
