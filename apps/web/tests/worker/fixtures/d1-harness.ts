// Task-5 worker D1 harness fixture (TEST-ONLY).
// This setup SQL must never enter production migrations: it creates a scratch
// table used solely to prove real workerd/D1 insert/select in `test:worker`.
// Production D1 schema is owned by later tasks.
export const HARNESS_SETUP_SQL: string =
  "CREATE TABLE IF NOT EXISTS dop_task5_harness (id TEXT PRIMARY KEY, title TEXT NOT NULL)"

export type HarnessRow = {
  readonly id: string
  readonly title: string
}
