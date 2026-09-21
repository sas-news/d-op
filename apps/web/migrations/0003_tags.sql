-- 0003_tags: canonical tag dictionary and the relational join table.
--
-- playlists.tags_json is the denormalized read copy; playlist_tags is refreshed
-- inside the same guarded batch so tag-based joins stay correct. Tag strings are
-- already canonical (NFC, trimmed, whitespace-collapsed, case-folded, sorted) at
-- the shared-schema boundary, so uniqueness is a plain UNIQUE.
CREATE TABLE IF NOT EXISTS tags (
  tag_id INTEGER PRIMARY KEY,
  tag TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS playlist_tags (
  share_id TEXT NOT NULL REFERENCES playlists (share_id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags (tag_id),
  PRIMARY KEY (share_id, tag_id)
);

-- Tag -> playlists join direction for filtered listing.
CREATE INDEX IF NOT EXISTS playlist_tags_tag_idx
  ON playlist_tags (tag_id, share_id);
