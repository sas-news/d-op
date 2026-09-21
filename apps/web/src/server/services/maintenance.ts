import type { D1Database } from "@cloudflare/workers-types"
import { DAY_BUCKET_RETENTION_DAYS } from "../../../../../packages/shared/src/index"
import {
  deleteExpiredPending,
  type PruneReport,
  pruneExpiredArtifacts,
} from "../repositories/maintenance"

// Expiry and retention entry points (task 13).
//
// expirePendingProvisionals runs on EVERY API read/write path — lazy expiry
// independent of any cron trigger — and only ever touches rows that are both
// `state='pending'` and past `activation_expires_at`, so valid active
// publications are structurally unreachable by it.
//
// runScheduledCleanup is the scheduled-handler entry point (wired to a Workers
// cron trigger by the deployment task): pending provisionals plus expired
// mutation/import receipts, discovery snapshots and 90-day-old day buckets.
// It shares the same repository deletes, so it can never remove a valid
// active publication either.

const DAY_MS = 86_400_000

export async function expirePendingProvisionals(db: D1Database, now: Date): Promise<number> {
  return deleteExpiredPending(db, now)
}

export async function runScheduledCleanup(
  db: D1Database,
  now: Date = new Date(),
): Promise<PruneReport> {
  const dayCutoff = new Date(now.getTime() - DAY_BUCKET_RETENTION_DAYS * DAY_MS).toISOString()
  return pruneExpiredArtifacts(db, now, dayCutoff)
}
