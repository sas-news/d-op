import type { SharedPlaylist } from "../../../../../packages/shared/src/index"

// Snapshot repository public types. Inputs are already Zod-validated at the
// service boundary; the repository re-validates persisted rows on read.

export type PlaylistState = "pending" | "active"
export type MutationMethod = "create" | "activate" | "replace" | "delete"

/** Why a guarded mutation refused to write. Services map these to HTTP codes. */
export type ConflictCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "ACTIVATION_EXPIRED"
  | "INVALID_STATE"
  | "ALREADY_EXISTS"
  | "RECEIPT_PENDING"

/** Mirrors the create acknowledgement minus the manage secret (never stored). */
export type CreateOutcome = {
  readonly shareId: string
  readonly revision: 1
  readonly state: "pending"
  readonly contentHash: string
  readonly createdAt: string
  readonly activationExpiresAt: string
}

/** Mirrors the PATCH acknowledgement shape. */
export type PatchOutcome = {
  readonly shareId: string
  readonly revision: number
  readonly contentHash: string
  readonly publishedAt: string | null
  readonly updatedAt: string
}

export type DeleteOutcome = {
  readonly shareId: string
  readonly deletedRevision: number
  readonly deletedAt: string
}

export type MutationResult<O> =
  | { readonly kind: "applied"; readonly outcome: O }
  | { readonly kind: "replayed"; readonly outcome: O }
  | { readonly kind: "conflict"; readonly code: ConflictCode }

/** Decoded, schema-checked snapshot row. */
export type StoredSnapshot = {
  readonly shareId: string
  readonly revision: number
  readonly state: PlaylistState
  readonly snapshot: SharedPlaylist
  readonly contentHash: string
  readonly visibility: "public" | "unlisted"
  readonly tags: readonly string[]
  readonly itemCount: number
  readonly totalDurationMs: number
  readonly importCount: number
  readonly blocked: boolean
  readonly createdAt: string
  readonly firstPublishedAt: string | null
  readonly updatedAt: string
  readonly activationExpiresAt: string | null
}

export type ImportRecordResult = {
  /** true when this attempt's receipt won the insert and counters moved. */
  readonly counted: boolean
}
