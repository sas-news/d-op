import type { D1Database } from "@cloudflare/workers-types"
import { POST as importRoute } from "../../src/pages/api/v1/playlists/[shareId]/import.js"
import { DELETE as deleteRoute } from "../../src/pages/api/v1/playlists/[shareId].js"
import { call, deleteShare, importNotify } from "../publication-api/helpers.js"

// Shared helpers for the import-counts acceptance suite (task 18). Everything
// is driven through the REAL Astro route handlers against the per-file
// Miniflare D1 database — no fake repository or service stub.

export {
  call,
  db,
  importNotify,
  makePlaylist,
  migratedDb,
  publishPlaylist,
  seedPendingRow,
} from "../publication-api/helpers.js"

/** POST /:shareId/import through the real route handler. */
export function postImport(shareId: string, eventId: string): Promise<Response> {
  return call(importRoute, importNotify(shareId, eventId), { shareId })
}

/** DELETE /:shareId through the real route handler (owner-authenticated). */
export function deletePublished(
  shareId: string,
  manageSecret: string,
  expectedRevision: number,
): Promise<Response> {
  return call(
    deleteRoute,
    deleteShare(shareId, manageSecret, crypto.randomUUID(), expectedRevision),
    { shareId },
  )
}

/** Lifetime counter on the playlist row; null when the row is gone. */
export async function lifetimeCount(database: D1Database, shareId: string): Promise<number | null> {
  const row = await database
    .prepare("SELECT import_count AS c FROM playlists WHERE share_id = ?1")
    .bind(shareId)
    .first<{ c: number }>()
  return row === null ? null : row.c
}

/** UTC-day bucket total; 0 when no bucket exists. */
export async function dailyCount(
  database: D1Database,
  shareId: string,
  day: string,
): Promise<number> {
  const row = await database
    .prepare("SELECT count AS c FROM import_daily WHERE share_id = ?1 AND day = ?2")
    .bind(shareId, day)
    .first<{ c: number }>()
  return row?.c ?? 0
}

export async function receiptCount(database: D1Database, shareId: string): Promise<number> {
  const row = await database
    .prepare("SELECT COUNT(*) AS c FROM import_receipts WHERE share_id = ?1")
    .bind(shareId)
    .first<{ c: number }>()
  return row?.c ?? 0
}

export async function bucketRows(
  database: D1Database,
  shareId: string,
): Promise<readonly { day: string; count: number }[]> {
  const result = await database
    .prepare("SELECT day, count FROM import_daily WHERE share_id = ?1 ORDER BY day")
    .bind(shareId)
    .all<{ day: string; count: number }>()
  return result.results
}
