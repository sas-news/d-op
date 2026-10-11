-- 0009_tag_work_meta: per-work metadata cache for POST /api/v1/tag-suggestions.
--
-- Resolving broadcaster/demographic/studio metadata costs up to three upstream
-- calls per work title; this table caches the resolved WorkTagMeta payload per
-- normalized title key (shared normalizeWorkTitleKey output). Rows go stale
-- after TAG_WORK_META_TTL_MS (30 days) — the service re-resolves and upserts.
-- work_id records the resolved upstream work id (AniList media id when known,
-- else the request-supplied opaque workId); payload_json is the canonical tag
-- source, never a request echo.
CREATE TABLE IF NOT EXISTS tag_work_meta (
  title_key TEXT PRIMARY KEY,
  work_id TEXT,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
