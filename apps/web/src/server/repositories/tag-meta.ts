import type { D1Database } from "@cloudflare/workers-types"
import { SnapshotRepositoryError } from "./errors"
import { toIso } from "./hashing"

// tag_work_meta: the per-work metadata cache behind /api/v1/tag-suggestions.
// Keys are normalized title keys (shared normalizeWorkTitleKey); the TTL check
// lives in the service, which decides when a row is stale and re-resolves.

export type TagWorkMetaRow = {
  readonly titleKey: string
  readonly workId: string | null
  readonly payloadJson: string
  readonly fetchedAt: string
}

/** Reads one cache row by normalized title key; absent -> null. */
export async function readTagWorkMeta(
  db: D1Database,
  titleKey: string,
): Promise<TagWorkMetaRow | null> {
  const row = await db
    .prepare(
      `SELECT title_key, work_id, payload_json, fetched_at
       FROM tag_work_meta WHERE title_key = ?1`,
    )
    .bind(titleKey)
    .first()
  if (row === null) return null
  const record = row as Record<string, unknown>
  if (typeof record["title_key"] !== "string" || typeof record["payload_json"] !== "string") {
    throw new SnapshotRepositoryError("CORRUPT_ROW", "tag_work_meta row misses required columns")
  }
  return {
    titleKey: record["title_key"],
    workId: typeof record["work_id"] === "string" ? record["work_id"] : null,
    payloadJson: record["payload_json"],
    fetchedAt: typeof record["fetched_at"] === "string" ? record["fetched_at"] : "",
  }
}

/** Upserts the resolved metadata payload for a title key. */
export async function upsertTagWorkMeta(
  db: D1Database,
  input: {
    readonly titleKey: string
    readonly workId: string | null
    readonly payloadJson: string
    readonly now: Date
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tag_work_meta (title_key, work_id, payload_json, fetched_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (title_key) DO UPDATE SET
         work_id = excluded.work_id,
         payload_json = excluded.payload_json,
         fetched_at = excluded.fetched_at`,
    )
    .bind(input.titleKey, input.workId, input.payloadJson, toIso(input.now))
    .run()
}
