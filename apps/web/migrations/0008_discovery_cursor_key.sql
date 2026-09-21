-- 0008_discovery_cursor_key: per-snapshot HMAC key for cursor signing (task 19).
--
-- Opaque pagination cursors are HMAC-SHA256 signed. Rather than a provisioned
-- Worker secret (which local preview/e2e could never receive without a
-- committed value), each ranking snapshot carries a fresh 256-bit CSPRNG key
-- written at materialization and never emitted by any route. The key rotates
-- with the snapshot's 15-minute TTL and dies with the row, so there is no
-- long-lived signing material to leak. Rows predating this column carry ''
-- and simply fail verification — they are expired within 15 min anyway.
ALTER TABLE discovery_snapshots
  ADD COLUMN cursor_key TEXT NOT NULL DEFAULT '';
