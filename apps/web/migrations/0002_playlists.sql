-- 0002_playlists: capability-published snapshot rows.
--
-- A row is the full published resource: ordered items live inside the bounded
-- canonical JSON snapshot (SharedPlaylist v1, <= 200 items, request body capped at
-- 256 KiB upstream), so replacement is a single-row write and can never leave a
-- partially replaced item list. Denormalized columns (title/search_text/tags_json/
-- counts) exist for read/list correctness and are refreshed inside the same
-- guarded batch as the snapshot.
--
--   state: 'pending' (provisional, non-readable, expires) -> 'active'.
--   Delete is a hard delete (row + associations purged); replay semantics are
--   carried by publication_operations receipts, not by a tombstone.
CREATE TABLE IF NOT EXISTS playlists (
  share_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active')),
  secret_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  author TEXT NOT NULL,
  search_text TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted')),
  tags_json TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count >= 1),
  total_duration_ms INTEGER NOT NULL CHECK (total_duration_ms >= 0),
  import_count INTEGER NOT NULL DEFAULT 0 CHECK (import_count >= 0),
  derived_from_share_id TEXT,
  derived_from_revision INTEGER,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
  created_at TEXT NOT NULL,
  first_published_at TEXT,
  updated_at TEXT NOT NULL,
  activation_expires_at TEXT
);

-- Discover ordering/filtering: eligible rows are state='active',
-- visibility='public', blocked=0 ordered by first_published_at DESC, share_id ASC.
CREATE INDEX IF NOT EXISTS playlists_listing_idx
  ON playlists (state, visibility, first_published_at, share_id);

-- Expiry sweep for provisional pending rows (activation_expires_at IS NOT NULL
-- only while pending).
CREATE INDEX IF NOT EXISTS playlists_activation_expiry_idx
  ON playlists (state, activation_expires_at);
