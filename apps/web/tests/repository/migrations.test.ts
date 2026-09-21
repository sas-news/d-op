import { describe, expect, it } from "vitest"
import { appliedMigrations, MIGRATIONS, migrate } from "../../src/server/repositories/migrations.js"
import { db, migratedDb } from "./helpers.js"

// Runs against the real per-file Miniflare D1 database.

const EXPECTED_TABLES = [
  "schema_migrations",
  "playlists",
  "tags",
  "playlist_tags",
  "publication_operations",
  "write_asserts",
  "import_receipts",
  "import_daily",
  "discovery_snapshots",
] as const

async function tableNames(): Promise<readonly string[]> {
  const rows = await db()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>()
  return rows.results.map((row) => row.name)
}

describe("D1 migrations on a fresh database", () => {
  it("applies every migration once, in manifest order", async () => {
    const applied = await migrate(db(), new Date("2026-01-01T00:00:00.000Z"))
    expect(applied).toEqual(MIGRATIONS.map((migration) => migration.name))
    expect(await appliedMigrations(db())).toEqual([...MIGRATIONS.map((m) => m.name)].sort())
    const tables = await tableNames()
    for (const table of EXPECTED_TABLES) expect(tables).toContain(table)
    const indexes = await db()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all<{ name: string }>()
    const indexNames = indexes.results.map((row) => row.name)
    for (const index of [
      "playlists_listing_idx",
      "playlists_activation_expiry_idx",
      "playlist_tags_tag_idx",
      "publication_operations_expiry_idx",
      "import_daily_day_idx",
      "discovery_snapshots_expiry_idx",
    ]) {
      expect(indexNames).toContain(index)
    }
  })

  it("is idempotent: a second run applies nothing and preserves data", async () => {
    const database = await migratedDb()
    const before = await db()
      .prepare("SELECT count(*) AS n FROM schema_migrations")
      .first<{ n: number }>()
    const second = await migrate(database, new Date("2026-02-01T00:00:00.000Z"))
    expect(second).toEqual([])
    const after = await db()
      .prepare("SELECT count(*) AS n FROM schema_migrations")
      .first<{ n: number }>()
    expect(after?.n).toBe(before?.n)
  })
})
