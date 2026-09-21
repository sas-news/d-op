import type { D1Database } from "@cloudflare/workers-types"
import m0001 from "../../../migrations/0001_schema_migrations.sql?raw"
import m0002 from "../../../migrations/0002_playlists.sql?raw"
import m0003 from "../../../migrations/0003_tags.sql?raw"
import m0004 from "../../../migrations/0004_publication_operations.sql?raw"
import m0005 from "../../../migrations/0005_imports.sql?raw"
import m0006 from "../../../migrations/0006_discovery_snapshots.sql?raw"
import m0007 from "../../../migrations/0007_operator_takedowns.sql?raw"
import { SnapshotRepositoryError } from "./errors"

// Ordered D1 migration manifest. Files live in apps/web/migrations/ following
// the wrangler `NNNN_name.sql` convention so `wrangler d1 migrations apply`
// uses the identical sources; this manifest embeds them for in-worker/test use.
// Every file is IF NOT EXISTS-idempotent; schema_migrations records what ran.

export type MigrationFile = {
  readonly name: string
  readonly sql: string
}

export const MIGRATIONS: readonly MigrationFile[] = [
  { name: "0001_schema_migrations", sql: m0001 },
  { name: "0002_playlists", sql: m0002 },
  { name: "0003_tags", sql: m0003 },
  { name: "0004_publication_operations", sql: m0004 },
  { name: "0005_imports", sql: m0005 },
  { name: "0006_discovery_snapshots", sql: m0006 },
  { name: "0007_operator_takedowns", sql: m0007 },
]

/**
 * Splits a migration file into single statements. D1 exec() splits input on
 * newlines rather than semicolons, so multi-line statements must be grouped
 * here first. Our files only ever contain: full-line `--` comments, blank
 * lines, `;`-terminated statements, and CREATE TRIGGER ... BEGIN ... END;
 * blocks (the only construct with interior semicolons).
 */
export function splitStatements(sql: string): readonly string[] {
  const statements: string[] = []
  let buffer: string[] = []
  let inTrigger = false
  for (const line of sql.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("--")) continue
    if (buffer.length === 0 && /^CREATE\s+TRIGGER\b/i.test(trimmed)) inTrigger = true
    buffer.push(line)
    if (inTrigger ? /\bEND\s*;\s*$/.test(trimmed) : trimmed.endsWith(";")) {
      const statement = buffer.join("\n").replace(/;\s*$/, "")
      if (statement.trim() !== "") statements.push(statement)
      buffer = []
      inTrigger = false
    }
  }
  if (buffer.length > 0) {
    throw new SnapshotRepositoryError(
      "ASSERTION_FAILED",
      `migration file holds an unterminated statement: ${buffer[0]?.slice(0, 60) ?? ""}`,
    )
  }
  return statements
}

export async function appliedMigrations(db: D1Database): Promise<readonly string[]> {
  const table = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .first<{ name: string }>()
  if (table === null) return []
  const rows = await db.prepare("SELECT name FROM schema_migrations ORDER BY name").all<{
    name: string
  }>()
  return rows.results.map((row) => row.name)
}

/**
 * Applies pending migrations in manifest order and records each in
 * schema_migrations inside the same atomic batch. Returns the names applied by
 * this call. Idempotent: already-recorded files are skipped, and every file is
 * written so a partially applied database can be re-run without errors.
 */
export async function migrate(db: D1Database, now: Date = new Date()): Promise<readonly string[]> {
  const applied = new Set(await appliedMigrations(db))
  const newlyApplied: string[] = []
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue
    try {
      await db.batch([
        ...splitStatements(migration.sql).map((statement) => db.prepare(statement)),
        db
          .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?1, ?2)")
          .bind(migration.name, now.toISOString()),
      ])
    } catch (cause) {
      throw new SnapshotRepositoryError(
        "TRANSIENT_FAILURE",
        `migration ${migration.name} failed to apply`,
        { cause },
      )
    }
    newlyApplied.push(migration.name)
  }
  return newlyApplied
}
