import { env } from "cloudflare:test"
import { beforeAll, describe, expect, it } from "vitest"
import { type DOpEnv, requireDb } from "../../src/server/env.js"
import { HARNESS_SETUP_SQL, type HarnessRow } from "./fixtures/d1-harness.js"

// Given: this suite executes inside the workerd runtime via @cloudflare/vitest-plugin
// with an isolated per-file D1 database (no fake repository, no in-memory fallback).
// When: a test inserts a uniquely-identified row and selects it back.
// Then: the exact row round-trips through real D1 SQL.
describe("worker D1 harness insert/select", () => {
  beforeAll(async () => {
    const db = requireDb(env as unknown as DOpEnv)
    await db.exec(HARNESS_SETUP_SQL)
  })

  it("inserts and selects a row through real D1", async () => {
    const db = requireDb(env as unknown as DOpEnv)
    const id = `harness-${crypto.randomUUID()}`
    const written = await db
      .prepare("INSERT INTO dop_task5_harness (id, title) VALUES (?1, ?2)")
      .bind(id, "task-5 harness")
      .run()
    expect(written.success).toBe(true)
    // Miniflare reports rows_written: 2 for a single-row insert where
    // production D1 reports 1; assert the lower bound and let the
    // select-back below carry the exactness proof.
    expect(written.meta.rows_written).toBeGreaterThanOrEqual(1)
    const row = await db
      .prepare("SELECT id, title FROM dop_task5_harness WHERE id = ?1")
      .bind(id)
      .first<HarnessRow>()
    expect(row?.id).toBe(id)
    expect(row?.title).toBe("task-5 harness")
  })

  it("keeps rows isolated per test via unique ids", async () => {
    const db = requireDb(env as unknown as DOpEnv)
    const id = `harness-${crypto.randomUUID()}`
    await db
      .prepare("INSERT INTO dop_task5_harness (id, title) VALUES (?1, ?2)")
      .bind(id, "isolated row")
      .run()
    const row = await db
      .prepare("SELECT id, title FROM dop_task5_harness WHERE id = ?1")
      .bind(id)
      .first<HarnessRow>()
    expect(row?.id).toBe(id)
    expect(row?.title).toBe("isolated row")
  })
})
