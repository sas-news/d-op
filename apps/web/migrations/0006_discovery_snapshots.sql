-- 0006_discovery_snapshots: short-lived materialized ranking pages.
--
-- A row freezes up to 1000 ordered eligible [share_id, score] entries plus the
-- ranking basis (mode/window/asOf/query fingerprint) for stable cursor
-- pagination. Rows expire after 15 minutes; snapshot ids are random and internal
-- (no user tracking). Deleting a playlist purges referencing snapshots inside the
-- delete batch so cached rankings cannot resurrect a removed resource.
CREATE TABLE IF NOT EXISTS discovery_snapshots (
  snapshot_id TEXT PRIMARY KEY NOT NULL,
  query_fingerprint TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('popular', 'new')),
  effective_window TEXT NOT NULL CHECK (effective_window IN ('30d', '90d', 'lifetime', 'none')),
  fallback_reason TEXT CHECK (fallback_reason IN ('insufficient-recent-data', 'no-imports')),
  as_of TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS discovery_snapshots_expiry_idx
  ON discovery_snapshots (expires_at);
