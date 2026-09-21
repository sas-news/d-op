-- 0004_publication_operations: guarded-operation rows and mutation receipts.
--
-- One row per Idempotency-Key. A mutation batch begins by inserting this row in
-- 'pending' status, and the INSERT only yields a row when the resource predicates
-- (share_id + secret_hash + expected revision + lifecycle state) hold and no
-- receipt already exists for the key. Every dependent snapshot/tag/counter write
-- in the same batch is gated on this pending row (matched by operation_key plus
-- the per-attempt nonce plus the exact request hash and expected/new revision),
-- and the final statement marks it 'completed' with the recorded outcome, so a
-- committed batch means "guard passed AND the whole mutation applied".
--
-- attempt_nonce is generated fresh inside each repository call; it prevents a
-- pre-existing receipt from authorizing a replay's dependent writes.
--
-- Receipts carry only hashes and outcomes (no raw manage secrets) and expire
-- after the 24 h mutation-receipt window.
CREATE TABLE IF NOT EXISTS publication_operations (
  operation_key TEXT PRIMARY KEY NOT NULL,
  share_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('create', 'activate', 'replace', 'delete')),
  request_hash TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  attempt_nonce TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  expected_revision INTEGER,
  new_revision INTEGER,
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS publication_operations_share_idx
  ON publication_operations (share_id);
CREATE INDEX IF NOT EXISTS publication_operations_expiry_idx
  ON publication_operations (expires_at);

-- write_asserts is an assertion sink, not data: guarded batches end with
-- INSERT INTO write_asserts SELECT ... statements that only produce a row when a
-- batch invariant was violated (e.g. the pending guard row exists but the parent
-- row did not move to the new revision). The trigger aborts the statement, which
-- rolls back the whole D1 batch; in a correct run this table stays empty.
CREATE TABLE IF NOT EXISTS write_asserts (
  name TEXT PRIMARY KEY NOT NULL
);

CREATE TRIGGER IF NOT EXISTS write_asserts_abort
BEFORE INSERT ON write_asserts
BEGIN
  SELECT RAISE(ABORT, 'guarded write assertion fired');
END;
