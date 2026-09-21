import type { D1Database } from "@cloudflare/workers-types"
import {
  DISCOVERY_SNAPSHOT_TTL_MS,
  FIRST_PAGE_SNAPSHOT_REUSE_MS,
} from "../../../../../packages/shared/src/index"
import { SnapshotRepositoryError } from "../repositories/errors"
import { GUARD_MAX_ATTEMPTS } from "../repositories/guard"
import { plusMs, toIso } from "../repositories/hashing"
import { newCursorKey } from "./cursor"
import type { FallbackReason, RankingDecision, RankMode, RankWindow } from "./policy"
import type { SnapshotEntry } from "./queries"

// Materialized ranking snapshots (task 19).
//
// A discovery_snapshots row freezes up to 1,000 ordered [shareId, score]
// entries plus the ranking basis (mode/effective_window/fallback_reason/as_of)
// and the query+policy fingerprint for 15 minutes. Two lifecycle rules come
// straight from the contract:
//
//   - first-page requests may REUSE a snapshot for the identical fingerprint
//     only while it is younger than 60 s (then a fresh one is materialized);
//   - cursor continuations keep using THEIR snapshot until the 15-minute
//     expiry — no sliding renewal — then the client restarts (410).
//
// `cursor_key` is a per-snapshot 256-bit CSPRNG HMAC key written here and
// never emitted (see cursor.ts). Snapshot ids are random and internal: they
// appear in cursors but carry no user identity.

export type DiscoverySnapshot = {
  readonly snapshotId: string
  readonly fingerprint: string
  readonly mode: RankMode
  readonly effectiveWindow: RankWindow
  readonly fallbackReason: FallbackReason | null
  readonly asOf: string
  readonly entries: readonly SnapshotEntry[]
  readonly truncated: boolean
  readonly cursorKey: string
  readonly createdAt: string
  readonly expiresAt: string
}

const SNAPSHOT_COLUMNS = `snapshot_id, query_fingerprint, mode, effective_window,
  fallback_reason, as_of, entries_json, truncated, cursor_key, created_at, expires_at`

const RANK_MODES: readonly string[] = ["popular", "new"]
const RANK_WINDOWS: readonly string[] = ["30d", "90d", "lifetime", "none"]
const FALLBACK_REASONS: readonly string[] = ["insufficient-recent-data", "no-imports"]

function corrupt(field: string, reason: string): SnapshotRepositoryError {
  return new SnapshotRepositoryError("CORRUPT_ROW", `discovery_snapshots.${field}: ${reason}`)
}

function reqString(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || value.length === 0) throw corrupt(key, "expected string")
  return value
}

function reqEnum<T extends string>(
  row: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = row[key]
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T
  throw corrupt(key, `expected one of ${allowed.join("/")}`)
}

function parseEntries(json: string): SnapshotEntry[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (cause) {
    throw new SnapshotRepositoryError("CORRUPT_ROW", "entries_json is not valid JSON", { cause })
  }
  if (!Array.isArray(raw)) throw corrupt("entries_json", "expected an array of [id, score]")
  const entries: SnapshotEntry[] = []
  for (const item of raw) {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      typeof item[0] !== "string" ||
      item[0].length === 0 ||
      typeof item[1] !== "number" ||
      !Number.isFinite(item[1]) ||
      item[1] < 0
    ) {
      throw corrupt("entries_json", "expected [shareId, non-negative score] pairs")
    }
    entries.push([item[0], item[1]])
  }
  return entries
}

function toSnapshot(row: Record<string, unknown>): DiscoverySnapshot {
  const truncated = row["truncated"]
  if (truncated !== 0 && truncated !== 1) throw corrupt("truncated", "expected 0 or 1")
  const fallback = row["fallback_reason"]
  if (fallback !== null && (typeof fallback !== "string" || !FALLBACK_REASONS.includes(fallback))) {
    throw corrupt("fallback_reason", "unexpected value")
  }
  return {
    snapshotId: reqString(row, "snapshot_id"),
    fingerprint: reqString(row, "query_fingerprint"),
    mode: reqEnum(row, "mode", RANK_MODES) as RankMode,
    effectiveWindow: reqEnum(row, "effective_window", RANK_WINDOWS) as RankWindow,
    fallbackReason: fallback as FallbackReason | null,
    asOf: reqString(row, "as_of"),
    entries: parseEntries(reqString(row, "entries_json")),
    truncated: truncated === 1,
    cursorKey: reqString(row, "cursor_key"),
    createdAt: reqString(row, "created_at"),
    expiresAt: reqString(row, "expires_at"),
  }
}

/**
 * Newest reusable snapshot for an identical query+policy fingerprint: still
 * live AND younger than the 60 s first-page reuse window.
 */
export async function findReusableSnapshot(
  db: D1Database,
  fingerprint: string,
  now: Date,
): Promise<DiscoverySnapshot | null> {
  const reuseFloor = new Date(now.getTime() - FIRST_PAGE_SNAPSHOT_REUSE_MS).toISOString()
  const row = await db
    .prepare(
      `SELECT ${SNAPSHOT_COLUMNS} FROM discovery_snapshots
       WHERE query_fingerprint = ? AND expires_at > ? AND created_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(fingerprint, toIso(now), reuseFloor)
    .first<Record<string, unknown>>()
  return row === null ? null : toSnapshot(row)
}

/** Continuation read: load by id; expiry is checked by the caller. */
export async function loadSnapshot(
  db: D1Database,
  snapshotId: string,
): Promise<DiscoverySnapshot | null> {
  const row = await db
    .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM discovery_snapshots WHERE snapshot_id = ?`)
    .bind(snapshotId)
    .first<Record<string, unknown>>()
  return row === null ? null : toSnapshot(row)
}

/** Inserts one frozen snapshot row; bounded busy retry like the import path. */
export async function insertSnapshot(
  db: D1Database,
  input: {
    readonly fingerprint: string
    readonly decision: RankingDecision
    readonly entries: readonly SnapshotEntry[]
    readonly truncated: boolean
    readonly now: Date
  },
): Promise<DiscoverySnapshot> {
  const snapshotId = crypto.randomUUID()
  const cursorKey = newCursorKey()
  const nowIso = toIso(input.now)
  const expiresAt = plusMs(input.now, DISCOVERY_SNAPSHOT_TTL_MS)
  const entriesJson = JSON.stringify(input.entries)
  let lastBusy: unknown
  for (let attempt = 0; attempt < GUARD_MAX_ATTEMPTS; attempt += 1) {
    try {
      await db
        .prepare(
          `INSERT INTO discovery_snapshots
           (snapshot_id, query_fingerprint, mode, effective_window, fallback_reason,
            as_of, entries_json, truncated, cursor_key, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          snapshotId,
          input.fingerprint,
          input.decision.mode,
          input.decision.effectiveWindow,
          input.decision.fallbackReason ?? null,
          nowIso,
          entriesJson,
          input.truncated ? 1 : 0,
          cursorKey,
          nowIso,
          expiresAt,
        )
        .run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/busy|locked|deadlock|timed?\s*out/i.test(message)) {
        lastBusy = error
        continue
      }
      throw new SnapshotRepositoryError(
        "TRANSIENT_FAILURE",
        `discovery snapshot insert failed: ${message}`,
        { cause: error },
      )
    }
    return {
      snapshotId,
      fingerprint: input.fingerprint,
      mode: input.decision.mode,
      effectiveWindow: input.decision.effectiveWindow,
      fallbackReason: input.decision.fallbackReason ?? null,
      asOf: nowIso,
      entries: input.entries,
      truncated: input.truncated,
      cursorKey,
      createdAt: nowIso,
      expiresAt,
    }
  }
  throw new SnapshotRepositoryError(
    "TRANSIENT_FAILURE",
    "discovery snapshot could not obtain the D1 write lock",
    { cause: lastBusy },
  )
}

/** True once the snapshot's 15-minute continuation window has closed. */
export function snapshotExpired(snapshot: DiscoverySnapshot, now: Date): boolean {
  return snapshot.expiresAt <= toIso(now)
}
