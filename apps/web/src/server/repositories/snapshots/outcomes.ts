import { SnapshotRepositoryError } from "../errors"
import type { CreateOutcome, DeleteOutcome, PatchOutcome } from "../types"

// Receipt outcome parsing. outcome_json is written by the repository itself at
// finalize time, but it is still checked field-by-field on read: a corrupt
// outcome becomes CORRUPT_ROW, never a silent pass-through. Hand-rolled checks
// because zod lives in the shared package's dependency context.

function parseJsonField(json: string | null, table: string): Record<string, unknown> {
  if (json === null) {
    throw new SnapshotRepositoryError("CORRUPT_ROW", `${table}: completed receipt has no outcome`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (cause) {
    throw new SnapshotRepositoryError("CORRUPT_ROW", `${table}: outcome is not JSON`, { cause })
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SnapshotRepositoryError("CORRUPT_ROW", `${table}: outcome is not an object`)
  }
  return raw as Record<string, unknown>
}

function outcomeString(outcome: Record<string, unknown>, key: string): string {
  const value = outcome[key]
  if (typeof value !== "string") {
    throw new SnapshotRepositoryError("CORRUPT_ROW", `receipt outcome ${key} is not a string`)
  }
  return value
}

function outcomeInt(outcome: Record<string, unknown>, key: string): number {
  const value = outcome[key]
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SnapshotRepositoryError("CORRUPT_ROW", `receipt outcome ${key} is not an integer`)
  }
  return value
}

function outcomeNullableString(outcome: Record<string, unknown>, key: string): string | null {
  const value = outcome[key]
  if (value === null) return null
  if (typeof value === "string") return value
  throw new SnapshotRepositoryError("CORRUPT_ROW", `receipt outcome ${key} is not a string`)
}

export function parseCreateOutcome(json: string | null): CreateOutcome {
  const outcome = parseJsonField(json, "publication_operations")
  const revision = outcomeInt(outcome, "revision")
  const state = outcomeString(outcome, "state")
  if (revision !== 1 || state !== "pending") {
    throw new SnapshotRepositoryError("CORRUPT_ROW", "create outcome has wrong revision/state")
  }
  return {
    shareId: outcomeString(outcome, "shareId"),
    revision: 1,
    state: "pending",
    contentHash: outcomeString(outcome, "contentHash"),
    createdAt: outcomeString(outcome, "createdAt"),
    activationExpiresAt: outcomeString(outcome, "activationExpiresAt"),
  }
}

export function parsePatchOutcome(json: string | null): PatchOutcome {
  const outcome = parseJsonField(json, "publication_operations")
  return {
    shareId: outcomeString(outcome, "shareId"),
    revision: outcomeInt(outcome, "revision"),
    contentHash: outcomeString(outcome, "contentHash"),
    publishedAt: outcomeNullableString(outcome, "publishedAt"),
    updatedAt: outcomeString(outcome, "updatedAt"),
  }
}

export function parseDeleteOutcome(json: string | null): DeleteOutcome {
  const outcome = parseJsonField(json, "publication_operations")
  return {
    shareId: outcomeString(outcome, "shareId"),
    deletedRevision: outcomeInt(outcome, "deletedRevision"),
    deletedAt: outcomeString(outcome, "deletedAt"),
  }
}
