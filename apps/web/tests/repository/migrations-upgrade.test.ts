import { describe, expect, it } from "vitest"
import {
  appliedMigrations,
  MIGRATIONS,
  migrate,
  splitStatements,
} from "../../src/server/repositories/migrations.js"
import { db } from "./helpers.js"

// Upgraded-database coverage: this file owns its own isolated D1 database, so
// it can simulate an older database that only ever ran the first two migration
// files, then prove migrate() applies only the pending tail and preserves data.

describe("D1 migrations on a partially upgraded database", () => {
  it("applies only the pending tail and keeps existing rows", async () => {
    const database = db()
    // Simulate the older database: run files 0001+0002 through the same
    // splitter the runner uses, and record them as applied.
    for (const index of [0, 1]) {
      const migration = MIGRATIONS[index]
      if (migration === undefined) throw new Error("missing migration entry")
      await database.batch(splitStatements(migration.sql).map((sql) => database.prepare(sql)))
      await database
        .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?1, ?2)")
        .bind(migration.name, "2025-12-01T00:00:00.000Z")
        .run()
    }
    // A row written under the "old" schema must survive the upgrade.
    await database
      .prepare(
        `INSERT INTO playlists (
           share_id, revision, state, secret_hash, snapshot_json, content_hash,
           title, description, author, search_text, visibility, tags_json,
           item_count, total_duration_ms, created_at, updated_at)
         VALUES ('survivor_row_00000000', 1, 'active',
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           '{}', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
           't', 'd', 'a', 's', 'public', '[]', 1, 0,
           '2025-12-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z')`,
      )
      .run()
    const applied = await migrate(database, new Date("2026-01-02T00:00:00.000Z"))
    expect(applied).toEqual(MIGRATIONS.map((m) => m.name).slice(2))
    const survivor = await database
      .prepare("SELECT share_id FROM playlists WHERE share_id = 'survivor_row_00000000'")
      .first<{ share_id: string }>()
    expect(survivor?.share_id).toBe("survivor_row_00000000")
    expect(await appliedMigrations(database)).toEqual([...MIGRATIONS.map((m) => m.name)].sort())
    // Re-running over the upgraded database is a no-op.
    expect(await migrate(database)).toEqual([])
  })
})
