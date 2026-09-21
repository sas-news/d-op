import { SharedPlaylistSchema } from "../../../../../packages/shared/src/index"
import { SnapshotRepositoryError } from "./errors"
import type { MutationMethod, PlaylistState, StoredSnapshot } from "./types"

// D1 rows are external data: every row read back is checked field-by-field
// before use so a corrupt or unexpected row becomes a named repository error,
// never a silent pass-through. (zod lives in the shared package's dependency
// context, so row checks are hand-rolled here; the snapshot payload itself is
// still parsed by SharedPlaylistSchema.)

type RawRow = Record<string, unknown>

function corrupt(table: string, field: string, reason: string): SnapshotRepositoryError {
  return new SnapshotRepositoryError("CORRUPT_ROW", `${table}.${field}: ${reason}`)
}

function reqString(row: RawRow, key: string, table: string): string {
  const value = row[key]
  if (typeof value !== "string" || value.length === 0) {
    throw corrupt(table, key, "expected non-empty string")
  }
  return value
}

function reqStringOrEmpty(row: RawRow, key: string, table: string): string {
  const value = row[key]
  if (typeof value !== "string") {
    throw corrupt(table, key, "expected string")
  }
  return value
}

function optString(row: RawRow, key: string, table: string): string | null {
  const value = row[key]
  if (value === null) return null
  if (typeof value === "string") return value
  throw corrupt(table, key, "expected string or null")
}

function reqInt(row: RawRow, key: string, table: string, min: number): number {
  const value = row[key]
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw corrupt(table, key, `expected integer >= ${min}`)
  }
  return value
}

function optInt(row: RawRow, key: string, table: string): number | null {
  const value = row[key]
  if (value === null) return null
  if (typeof value === "number" && Number.isInteger(value)) return value
  throw corrupt(table, key, "expected integer or null")
}

function reqEnum<T extends string>(
  row: RawRow,
  key: string,
  table: string,
  allowed: readonly T[],
): T {
  const value = row[key]
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T
  }
  throw corrupt(table, key, `expected one of ${allowed.join("/")}`)
}

const HEX64 = /^[0-9a-f]{64}$/

function reqHash(row: RawRow, key: string, table: string): string {
  const value = reqString(row, key, table)
  if (!HEX64.test(value)) throw corrupt(table, key, "expected sha256 hex")
  return value
}

export type PlaylistRow = {
  readonly share_id: string
  readonly revision: number
  readonly state: PlaylistState
  readonly secret_hash: string
  readonly snapshot_json: string
  readonly content_hash: string
  readonly title: string
  readonly description: string
  readonly author: string
  readonly search_text: string
  readonly visibility: "public" | "unlisted"
  readonly tags_json: string
  readonly item_count: number
  readonly total_duration_ms: number
  readonly import_count: number
  readonly derived_from_share_id: string | null
  readonly derived_from_revision: number | null
  readonly blocked: number
  readonly created_at: string
  readonly first_published_at: string | null
  readonly updated_at: string
  readonly activation_expires_at: string | null
}

export type OperationRow = {
  readonly operation_key: string
  readonly share_id: string
  readonly method: MutationMethod
  readonly request_hash: string
  readonly secret_hash: string
  readonly attempt_nonce: string
  readonly status: "pending" | "completed"
  readonly expected_revision: number | null
  readonly new_revision: number | null
  readonly outcome_json: string | null
  readonly created_at: string
  readonly expires_at: string
}

export type GuardRow = {
  readonly revision: number
  readonly state: PlaylistState
  readonly secret_hash: string
  readonly activation_expires_at: string | null
}

function asRecord(row: unknown, table: string): RawRow {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new SnapshotRepositoryError("CORRUPT_ROW", `${table}: row is not an object`)
  }
  return row as RawRow
}

export function toPlaylistRow(row: unknown): PlaylistRow {
  const raw = asRecord(row, "playlists")
  return {
    share_id: reqString(raw, "share_id", "playlists"),
    revision: reqInt(raw, "revision", "playlists", 1),
    state: reqEnum(raw, "state", "playlists", ["pending", "active"] as const),
    secret_hash: reqHash(raw, "secret_hash", "playlists"),
    snapshot_json: reqString(raw, "snapshot_json", "playlists"),
    content_hash: reqHash(raw, "content_hash", "playlists"),
    title: reqString(raw, "title", "playlists"),
    description: reqStringOrEmpty(raw, "description", "playlists"),
    author: reqStringOrEmpty(raw, "author", "playlists"),
    search_text: reqStringOrEmpty(raw, "search_text", "playlists"),
    visibility: reqEnum(raw, "visibility", "playlists", ["public", "unlisted"] as const),
    tags_json: reqString(raw, "tags_json", "playlists"),
    item_count: reqInt(raw, "item_count", "playlists", 1),
    total_duration_ms: reqInt(raw, "total_duration_ms", "playlists", 0),
    import_count: reqInt(raw, "import_count", "playlists", 0),
    derived_from_share_id: optString(raw, "derived_from_share_id", "playlists"),
    derived_from_revision: optInt(raw, "derived_from_revision", "playlists"),
    blocked: reqInt(raw, "blocked", "playlists", 0),
    created_at: reqString(raw, "created_at", "playlists"),
    first_published_at: optString(raw, "first_published_at", "playlists"),
    updated_at: reqString(raw, "updated_at", "playlists"),
    activation_expires_at: optString(raw, "activation_expires_at", "playlists"),
  }
}

export function toOperationRow(row: unknown): OperationRow {
  const raw = asRecord(row, "publication_operations")
  return {
    operation_key: reqString(raw, "operation_key", "publication_operations"),
    share_id: reqString(raw, "share_id", "publication_operations"),
    method: reqEnum(raw, "method", "publication_operations", [
      "create",
      "activate",
      "replace",
      "delete",
    ] as const),
    request_hash: reqHash(raw, "request_hash", "publication_operations"),
    secret_hash: reqHash(raw, "secret_hash", "publication_operations"),
    attempt_nonce: reqString(raw, "attempt_nonce", "publication_operations"),
    status: reqEnum(raw, "status", "publication_operations", ["pending", "completed"] as const),
    expected_revision: optInt(raw, "expected_revision", "publication_operations"),
    new_revision: optInt(raw, "new_revision", "publication_operations"),
    outcome_json: optString(raw, "outcome_json", "publication_operations"),
    created_at: reqString(raw, "created_at", "publication_operations"),
    expires_at: reqString(raw, "expires_at", "publication_operations"),
  }
}

export function toGuardRow(row: unknown): GuardRow {
  const raw = asRecord(row, "playlists")
  return {
    revision: reqInt(raw, "revision", "playlists", 1),
    state: reqEnum(raw, "state", "playlists", ["pending", "active"] as const),
    secret_hash: reqHash(raw, "secret_hash", "playlists"),
    activation_expires_at: optString(raw, "activation_expires_at", "playlists"),
  }
}

export function toStoredSnapshot(row: PlaylistRow): StoredSnapshot {
  let rawSnapshot: unknown
  let rawTags: unknown
  try {
    rawSnapshot = JSON.parse(row.snapshot_json)
    rawTags = JSON.parse(row.tags_json)
  } catch (cause) {
    throw new SnapshotRepositoryError("CORRUPT_ROW", "snapshot row holds invalid JSON", { cause })
  }
  const snapshot = SharedPlaylistSchema.safeParse(rawSnapshot)
  if (!snapshot.success) {
    throw new SnapshotRepositoryError(
      "CORRUPT_ROW",
      "snapshot row payload failed SharedPlaylist validation",
    )
  }
  if (!Array.isArray(rawTags) || rawTags.some((tag) => typeof tag !== "string")) {
    throw new SnapshotRepositoryError("CORRUPT_ROW", "snapshot row tags are invalid")
  }
  return {
    shareId: row.share_id,
    revision: row.revision,
    state: row.state,
    snapshot: snapshot.data,
    contentHash: row.content_hash,
    visibility: row.visibility,
    tags: rawTags as readonly string[],
    itemCount: row.item_count,
    totalDurationMs: row.total_duration_ms,
    importCount: row.import_count,
    blocked: row.blocked !== 0,
    createdAt: row.created_at,
    firstPublishedAt: row.first_published_at,
    updatedAt: row.updated_at,
    activationExpiresAt: row.activation_expires_at,
  }
}
