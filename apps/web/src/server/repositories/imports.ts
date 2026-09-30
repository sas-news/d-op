import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { IMPORT_RECEIPT_TTL_MS } from "../../../../../packages/shared/src/index"
import { SnapshotRepositoryError } from "./errors"
import { GUARD_MAX_ATTEMPTS } from "./guard"
import { newAttemptNonce, plusMs, toIso } from "./hashing"
import type { ImportRecordResult } from "./types"

// Import accounting (atomic exactly-once within the 48 h receipt window).
//
// Statements 1-2 clear EXPIRED receipts for this attempt's event hash and
// actor hash — the expiry check at ingestion, so a post-TTL resend behaves
// identically whether or not the scheduled sweep has already run (the receipt
// window is the only dedupe horizon). Statement 3 inserts the actor dedup
// receipt only for an eligible share (active + public + not blocked) and only
// when the actor key is unseen; statement 4 inserts the event receipt only
// when THIS attempt minted the actor receipt; statements 5-6 increment the
// daily bucket and lifetime counter but ONLY when the event receipt carries
// THIS attempt's nonce. A losing concurrent duplicate, an in-window replay,
// or a second event id from the same actor all no-op — there is no
// SELECT-then-increment anywhere, so a share's counters move at most once
// per event and once per actor per 48 h window.

export type ImportEventInput = {
  readonly shareId: string
  /** SHA-256 hex of the client's random event id (never the raw id). */
  readonly eventHash: string
  /**
   * SHA-256 hex of `dop-import-actor:<actorDigest>:<shareId>` — the actor
   * dedup key. actorDigest is the rate-limit module's daily-rotating HMAC of
   * the connecting IP; only its re-hashed form is persisted, never the IP.
   */
  readonly actorHash: string
  readonly now: Date
}

export async function recordImportEvent(
  db: D1Database,
  input: ImportEventInput,
): Promise<ImportRecordResult> {
  const nowIso = toIso(input.now)
  const day = nowIso.slice(0, 10)
  const expiresAt = plusMs(input.now, IMPORT_RECEIPT_TTL_MS)
  let lastBusy: unknown
  for (let attempt = 0; attempt < GUARD_MAX_ATTEMPTS; attempt += 1) {
    const nonce = newAttemptNonce()
    try {
      await db.batch([...buildStatements(db, input, nonce, nowIso, day, expiresAt)])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/busy|locked|deadlock|timed?\s*out/i.test(message)) {
        lastBusy = error
        continue
      }
      throw new SnapshotRepositoryError(
        "TRANSIENT_FAILURE",
        `import event batch failed: ${message}`,
        { cause: error },
      )
    }
    return { counted: await receiptHeldByThisAttempt(db, input.eventHash, nonce) }
  }
  throw new SnapshotRepositoryError(
    "TRANSIENT_FAILURE",
    "import event could not obtain the D1 write lock",
    { cause: lastBusy },
  )
}

function buildStatements(
  db: D1Database,
  input: ImportEventInput,
  nonce: string,
  nowIso: string,
  day: string,
  expiresAt: string,
): readonly D1PreparedStatement[] {
  return [
    // 1-2. Ingestion expiry checks: drop receipts for this event hash and this
    //    actor key whose TTL has already passed so each dedupe window is
    //    exactly 48 h regardless of when the scheduled prune last ran. Live
    //    receipts are untouched.
    db
      .prepare(`DELETE FROM import_receipts WHERE event_hash = ?1 AND expires_at <= ?2`)
      .bind(input.eventHash, nowIso),
    db
      .prepare(`DELETE FROM import_receipts WHERE event_hash = ?1 AND expires_at <= ?2`)
      .bind(input.actorHash, nowIso),
    // 3. Actor dedup receipt: yields a row only for an eligible share with an
    //    unseen actor key. ON CONFLICT keeps a live duplicate at zero rows —
    //    its foreign nonce then fails this attempt's event gate below.
    db
      .prepare(
        `INSERT INTO import_receipts (event_hash, share_id, attempt_nonce, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE EXISTS (
         SELECT 1 FROM playlists p
         WHERE p.share_id = ?2 AND p.state = 'active' AND p.visibility = 'public'
           AND p.blocked = 0)
       ON CONFLICT (event_hash) DO NOTHING`,
      )
      .bind(input.actorHash, input.shareId, nonce, nowIso, expiresAt),
    // 4. Event receipt: only when this attempt minted the actor receipt —
    //    eligibility is inherited transitively through that gate.
    db
      .prepare(
        `INSERT INTO import_receipts (event_hash, share_id, attempt_nonce, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE EXISTS (
         SELECT 1 FROM import_receipts ar
         WHERE ar.event_hash = ?6 AND ar.attempt_nonce = ?3)
       ON CONFLICT (event_hash) DO NOTHING`,
      )
      .bind(input.eventHash, input.shareId, nonce, nowIso, expiresAt, input.actorHash),
    // 5. Daily bucket upsert — both the insert and the conflict-update branch
    //    require the event receipt to carry this attempt's nonce.
    db
      .prepare(
        `INSERT INTO import_daily (share_id, day, count)
       SELECT ?1, ?2, 1
       WHERE EXISTS (
         SELECT 1 FROM import_receipts r
         WHERE r.event_hash = ?3 AND r.attempt_nonce = ?4)
       ON CONFLICT (share_id, day) DO UPDATE SET count = import_daily.count + 1
       WHERE EXISTS (
         SELECT 1 FROM import_receipts r
         WHERE r.event_hash = ?3 AND r.attempt_nonce = ?4)`,
      )
      .bind(input.shareId, day, input.eventHash, nonce),
    // 6. Lifetime counter on the playlist row, same nonce gate.
    db
      .prepare(
        `UPDATE playlists SET import_count = import_count + 1
       WHERE share_id = ?1
         AND EXISTS (
           SELECT 1 FROM import_receipts r
           WHERE r.event_hash = ?2 AND r.attempt_nonce = ?3)`,
      )
      .bind(input.shareId, input.eventHash, nonce),
  ]
}

async function receiptHeldByThisAttempt(
  db: D1Database,
  eventHash: string,
  nonce: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM import_receipts
       WHERE event_hash = ?1 AND attempt_nonce = ?2`,
    )
    .bind(eventHash, nonce)
    .first<{ ok: number }>()
  return row !== null
}
