import type { D1Database } from "@cloudflare/workers-types"
import { getSnapshot } from "../repositories/snapshots/read"
import type { ConflictCode, PatchOutcome } from "../repositories/types"
import { dataResponse, errorResponse, notFound, transientFailure, unauthorized } from "./respond"

// Conflict-code mapping and acknowledgement shaping for PATCH/DELETE
// (task 13). Kept separate from mutations.ts so each module stays small;
// all behaviour lives behind the repository's guarded writes — no SQL here.

/** 200 acknowledgement for applied AND receipt-replayed PATCH operations. */
export function patchAck(outcome: PatchOutcome): Response {
  if (outcome.publishedAt === null) {
    // Active rows always carry first_published_at; a missing value means the
    // persisted row is corrupt and must fail closed.
    throw new Error("patch outcome is missing publishedAt")
  }
  return dataResponse(
    {
      shareId: outcome.shareId,
      revision: outcome.revision,
      contentHash: outcome.contentHash,
      publishedAt: outcome.publishedAt,
      updatedAt: outcome.updatedAt,
    },
    200,
  )
}

export type MutationDescriptor = {
  readonly operation: "activate" | "replace" | "delete"
  readonly expectedRevision: number
}

/**
 * Repository conflict codes -> fixed contract statuses. The repository only
 * reports REVISION_CONFLICT / INVALID_STATE after the secret hash matched, so
 * the current revision may be disclosed in `details` (authenticated conflict
 * revision). ACTIVATION_EXPIRED maps to 404: the provisional record is being
 * expired lazily and is therefore absent — no distinct code exists in v1.
 */
export async function mutationConflict(
  db: D1Database,
  shareId: string,
  operation: MutationDescriptor,
  code: ConflictCode,
  requestId: string,
): Promise<Response> {
  switch (code) {
    case "UNAUTHORIZED":
      return unauthorized(requestId)
    case "NOT_FOUND":
    case "ACTIVATION_EXPIRED":
      return notFound(requestId)
    case "IDEMPOTENCY_CONFLICT":
      return errorResponse({
        status: 409,
        code: "IDEMPOTENCY_CONFLICT",
        message: "Idempotency-Key was already used with a different request",
        requestId,
      })
    case "INVALID_STATE":
      return invalidState(db, shareId, operation, requestId)
    case "REVISION_CONFLICT":
      return errorResponse({
        status: 409,
        code: "REVISION_CONFLICT",
        message: "expectedRevision does not match the current publication revision",
        requestId,
        details: await currentRevisionDetails(db, shareId),
      })
    default:
      // RECEIPT_PENDING / ALREADY_EXISTS: storage-layer anomalies.
      return transientFailure(requestId)
  }
}

/**
 * Repeat-activate semantics: a fresh-key activate on a publication that is
 * already active at exactly the activation successor revision (the pending
 * snapshot was activated and never replaced) returns the current state as a
 * 200 ack — the contract's "idempotent repeat activate" — instead of a
 * conflict. Anything else is a genuine revision conflict.
 */
async function invalidState(
  db: D1Database,
  shareId: string,
  operation: MutationDescriptor,
  requestId: string,
): Promise<Response> {
  if (operation.operation === "activate") {
    const current = await getSnapshot(db, shareId)
    if (
      current !== null &&
      current.state === "active" &&
      current.revision === operation.expectedRevision + 1 &&
      current.firstPublishedAt !== null
    ) {
      return dataResponse(
        {
          shareId: current.shareId,
          revision: current.revision,
          contentHash: current.contentHash,
          publishedAt: current.firstPublishedAt,
          updatedAt: current.updatedAt,
        },
        200,
      )
    }
  }
  return errorResponse({
    status: 409,
    code: "REVISION_CONFLICT",
    message: "the publication is not in a state that accepts this operation",
    requestId,
    details: await currentRevisionDetails(db, shareId),
  })
}

async function currentRevisionDetails(
  db: D1Database,
  shareId: string,
): Promise<{ readonly revision: number } | undefined> {
  const row = await getSnapshot(db, shareId)
  return row === null ? undefined : { revision: row.revision }
}
