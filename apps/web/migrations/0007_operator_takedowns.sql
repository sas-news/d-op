-- 0007_operator_takedowns: durable audit rows for operator takedowns (task 14).
--
-- Operator takedown is deployment-credential-only (the audited CLI), never a
-- public endpoint. Each executed takedown records one row here: who ran it
-- (an operator-supplied identifier, e.g. a ticket or operator alias — never a
-- credential), which share was removed, why, and whether a live row was
-- actually purged. Statement ordering in the repository guarantees fail-safe
-- partial application: the row is blocked first so an interrupted run can
-- never leave the resource publicly visible.
CREATE TABLE IF NOT EXISTS operator_takedowns (
  operation_key TEXT PRIMARY KEY NOT NULL,
  share_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  removed INTEGER NOT NULL CHECK (removed IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS operator_takedowns_share_idx
  ON operator_takedowns (share_id);
