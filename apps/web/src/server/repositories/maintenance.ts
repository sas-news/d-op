import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { DAY_BUCKET_RETENTION_DAYS } from "../../../../../packages/shared/src/index"
import { toIso } from "./hashing"

// Retention sweeps (task 12 scope: pending expiry + TTL pruning). Called on
// read/write paths and by the scheduled handler in later tasks; pure deletes,
// no user identity involved.

export type PruneReport = {
  readonly expiredPendingPlaylists: number
  readonly expiredMutationReceipts: number
  readonly expiredImportReceipts: number
  readonly expiredDiscoverySnapshots: number
  readonly prunedDayBuckets: number
}

/** Delete provisional snapshots whose activation window has closed. */
export async function deleteExpiredPending(db: D1Database, now: Date): Promise<number> {
  const nowIso = toIso(now)
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM playlist_tags
       WHERE share_id IN (
         SELECT share_id FROM playlists
         WHERE state = 'pending' AND activation_expires_at IS NOT NULL
           AND activation_expires_at <= ?1)`,
      )
      .bind(nowIso),
    db
      .prepare(
        `DELETE FROM playlists
       WHERE state = 'pending' AND activation_expires_at IS NOT NULL
         AND activation_expires_at <= ?1`,
      )
      .bind(nowIso),
  ])
  const last = results[results.length - 1]
  return last?.meta.rows_written ?? 0
}

/**
 * Time-based pruning: expired mutation receipts, import receipts and discovery
 * snapshots plus day buckets older than the retention window. `dayCutoff` is
 * the oldest retained UTC day (YYYY-MM-DD); pass
 * `new Date(now - DAY_BUCKET_RETENTION_DAYS * 86400000)` from callers.
 */
export async function pruneExpiredArtifacts(
  db: D1Database,
  now: Date,
  dayCutoffIso: string,
): Promise<PruneReport> {
  const nowIso = toIso(now)
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM publication_operations WHERE expires_at <= ?1").bind(nowIso),
    db.prepare("DELETE FROM import_receipts WHERE expires_at <= ?1").bind(nowIso),
    db.prepare("DELETE FROM discovery_snapshots WHERE expires_at <= ?1").bind(nowIso),
    db.prepare("DELETE FROM import_daily WHERE day < ?1").bind(dayCutoffIso),
  ]
  const results = await db.batch(statements)
  const pending = await deleteExpiredPending(db, now)
  return {
    expiredPendingPlaylists: pending,
    expiredMutationReceipts: results[0]?.meta.rows_written ?? 0,
    expiredImportReceipts: results[1]?.meta.rows_written ?? 0,
    expiredDiscoverySnapshots: results[2]?.meta.rows_written ?? 0,
    prunedDayBuckets: results[3]?.meta.rows_written ?? 0,
  }
}

export { DAY_BUCKET_RETENTION_DAYS }
