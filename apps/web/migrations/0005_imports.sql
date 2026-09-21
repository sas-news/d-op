-- 0005_imports: best-effort import accounting.
--
-- import_receipts is the exactly-once guard: the first batch to insert a given
-- event_hash wins, and the daily/lifetime increments in that same batch are
-- gated on the receipt carrying that attempt's nonce, so concurrent or replayed
-- duplicates can never double-count. event_hash is a SHA-256 of the client's
-- random event id; no raw importer identity is stored. Receipts expire after 48 h
-- so an honest client cannot replay beyond the window.
CREATE TABLE IF NOT EXISTS import_receipts (
  event_hash TEXT PRIMARY KEY NOT NULL,
  share_id TEXT NOT NULL,
  attempt_nonce TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS import_receipts_share_idx
  ON import_receipts (share_id);
CREATE INDEX IF NOT EXISTS import_receipts_expiry_idx
  ON import_receipts (expires_at);

-- UTC calendar-day buckets per playlist; retained ~90 days for ranking windows.
-- The lifetime count lives on playlists.import_count and is incremented in the
-- same guarded batch.
CREATE TABLE IF NOT EXISTS import_daily (
  share_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (share_id, day)
);

-- Window scans aggregate over a day range across all shares.
CREATE INDEX IF NOT EXISTS import_daily_day_idx
  ON import_daily (day, share_id);
