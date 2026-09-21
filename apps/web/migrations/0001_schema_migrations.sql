-- 0001_schema_migrations: migration bookkeeping for the d-OP share D1 schema.
-- Every later file is applied once in name order and recorded here; all files are
-- written with IF NOT EXISTS so a partially applied database can be re-run safely.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL
);
