import { execSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Shared local-D1 seeding helpers for the web e2e specs
// (share-page.spec.ts + discover.spec.ts). Seeding goes through
// `wrangler d1 execute --local`, never the rate-limited POST API, and all
// web projects share the same .wrangler/state sqlite file.

export const WEB_PORT = process.env["DOP_WEB_PORT"] ?? "4321"
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`
export const WEB_CWD = join(__dirname, "..", "..", "apps", "web")

export const shareId = (): string => randomBytes(16).toString("base64url")
export const hex64 = (): string => randomBytes(32).toString("hex")
export const isoNow = (): string => new Date().toISOString()
export const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`
export const utcDay = (daysAgo: number): string =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
export const isoDaysAgo = (daysAgo: number): string =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString()

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function wrangler(command: string): void {
  execSync(`bunx wrangler ${command}`, {
    cwd: WEB_CWD,
    stdio: "pipe",
    env: { ...process.env, CI: "true" },
  })
}

// Parallel specs share one local-D1 file; concurrent wrangler processes and
// the live preview server can collide with a transient SQLITE_BUSY /
// miniflare "internal error". Retries are replay-safe here: `d1 execute
// --file` runs the whole file in one implicit transaction — a mid-file
// runtime error leaves zero applied rows (verified against local miniflare),
// so a failed batch is always a no-op and replaying it cannot double-apply
// ON CONFLICT increments or re-INSERT rows.
const MAX_ATTEMPTS = 6

export function d1Execute(statements: readonly string[]): void {
  const dir = mkdtempSync(join(tmpdir(), "dop-d1-seed-"))
  const file = join(dir, "seed.sql")
  writeFileSync(file, `${statements.join(";\n")};\n`, "utf8")
  for (let attempt = 0; ; attempt += 1) {
    try {
      wrangler(`d1 execute dop_share --local --file "${file}"`)
      return
    } catch (error) {
      if (attempt + 1 >= MAX_ATTEMPTS) throw error
      sleep(250 * (attempt + 1))
    }
  }
}

// Migrations are idempotent (wrangler tracks applied ids) — same retry
// policy as d1Execute.
export function d1Migrate(): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      wrangler("d1 migrations apply dop_share --local")
      return
    } catch (error) {
      if (attempt + 1 >= MAX_ATTEMPTS) throw error
      sleep(250 * (attempt + 1))
    }
  }
}
