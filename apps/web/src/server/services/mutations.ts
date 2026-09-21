import { env } from "cloudflare:workers"
import type { D1Database } from "@cloudflare/workers-types"
import {
  contentHashOf,
  DeletePlaylistBodySchema,
  type DerivedFrom,
  issuePaths,
  PatchPlaylistBodySchema,
} from "../../../../../packages/shared/src/index"
import { requireDb } from "../env"
import { activateSnapshot } from "../repositories/snapshots/activate"
import { deleteSnapshot } from "../repositories/snapshots/delete"
import { getActiveSnapshot } from "../repositories/snapshots/read"
import { replaceSnapshot } from "../repositories/snapshots/replace"
import { extractBearerSecret, manageSecretHash } from "../security/capability"
import { parseShareIdParam, readIdempotencyKey, readJsonBody } from "../security/http"
import { checkAdmission } from "./admission"
import { expirePendingProvisionals } from "./maintenance"
import { mutationConflict, patchAck } from "./mutation-conflicts"
import { fieldPaths } from "./publication"
import {
  errorResponse,
  noContentResponse,
  notFound,
  transientFailure,
  unauthorized,
} from "./respond"

// PATCH/DELETE /api/v1/playlists/:shareId service policy (task 13).
//
// Intake order: shareId shape (404) -> Bearer capability (401) ->
// Idempotency-Key (400) -> content type (415) -> bounded body (413) -> JSON
// (400) -> schema (422). No row is touched before the capability exists, so a
// revision is never revealed pre-auth; the repository guard then binds
// shareId + secret hash + expected revision + lifecycle state atomically.

export async function patchPublication(
  shareIdParam: string | undefined,
  request: Request,
  requestId: string,
): Promise<Response> {
  try {
    const intake = await mutationIntake(shareIdParam, request, requestId)
    if (!intake.ok) return intake.response
    const parsed = PatchPlaylistBodySchema.safeParse(intake.body)
    if (!parsed.success) {
      return errorResponse({
        status: 422,
        code: "SCHEMA_INVALID",
        message: "request body does not match a supported PATCH operation",
        requestId,
        details: fieldPaths(issuePaths(parsed.error)),
      })
    }
    const { db, shareId, secretHash, operationKey, now } = intake
    const operation = parsed.data
    // Task 20: derivedFrom is first-publication provenance and immutable.
    // A replace that adds, removes or rewrites the stored lineage is a schema
    // error — this also closes self-reference/cycle attempts through update.
    // The pre-check is race-safe: every accepted replace must preserve the
    // stored link, so it can never legitimately change while the row lives.
    if (operation.operation === "replace") {
      const stored = await getActiveSnapshot(db, shareId)
      if (
        stored !== null &&
        !sameDerivedFrom(stored.snapshot.derivedFrom, operation.playlist.derivedFrom)
      ) {
        return errorResponse({
          status: 422,
          code: "SCHEMA_INVALID",
          message: "derivedFrom is fixed at first publication and cannot change",
          requestId,
          details: ["playlist.derivedFrom"],
        })
      }
    }
    const result =
      operation.operation === "activate"
        ? await activateSnapshot(db, {
            shareId,
            secretHash,
            operationKey,
            expectedRevision: operation.expectedRevision,
            now,
          })
        : await replaceSnapshot(db, {
            shareId,
            secretHash,
            operationKey,
            expectedRevision: operation.expectedRevision,
            playlist: operation.playlist,
            contentHash: await contentHashOf(operation.playlist),
            now,
          })
    if (result.kind !== "conflict") return patchAck(result.outcome)
    return mutationConflict(db, shareId, operation, result.code, requestId)
  } catch {
    return transientFailure(requestId)
  }
}

export async function deletePublication(
  shareIdParam: string | undefined,
  request: Request,
  requestId: string,
): Promise<Response> {
  try {
    const intake = await mutationIntake(shareIdParam, request, requestId)
    if (!intake.ok) return intake.response
    const parsed = DeletePlaylistBodySchema.safeParse(intake.body)
    if (!parsed.success) {
      return errorResponse({
        status: 422,
        code: "SCHEMA_INVALID",
        message: "request body does not match the DELETE schema",
        requestId,
        details: fieldPaths(issuePaths(parsed.error)),
      })
    }
    const { db, shareId, secretHash, operationKey, now } = intake
    const result = await deleteSnapshot(db, {
      shareId,
      secretHash,
      operationKey,
      expectedRevision: parsed.data.expectedRevision,
      now,
    })
    if (result.kind !== "conflict") return noContentResponse()
    return mutationConflict(
      db,
      shareId,
      { operation: "delete", expectedRevision: parsed.data.expectedRevision },
      result.code,
      requestId,
    )
  } catch {
    return transientFailure(requestId)
  }
}

/** Exact provenance equality — both absent, or same shareId AND revision. */
function sameDerivedFrom(
  stored: DerivedFrom | undefined,
  incoming: DerivedFrom | undefined,
): boolean {
  if (stored === undefined || incoming === undefined) return stored === incoming
  return stored.shareId === incoming.shareId && stored.revision === incoming.revision
}

// --- shared intake ----------------------------------------------------------

type MutationIntake =
  | {
      readonly ok: true
      readonly db: D1Database
      readonly shareId: string
      readonly secretHash: string
      readonly operationKey: string
      readonly now: Date
      readonly body: unknown
    }
  | { readonly ok: false; readonly response: Response }

async function mutationIntake(
  shareIdParam: string | undefined,
  request: Request,
  requestId: string,
): Promise<MutationIntake> {
  const shareId = parseShareIdParam(shareIdParam)
  if (shareId === null) return { ok: false, response: notFound(requestId) }
  const denied = await checkAdmission({
    env,
    request,
    requestId,
    cls: "mutation",
    shareId,
    mutation: true,
  })
  if (denied !== null) return { ok: false, response: denied }
  const secret = extractBearerSecret(request)
  if (secret === null) return { ok: false, response: unauthorized(requestId) }
  const key = readIdempotencyKey(request)
  if (!key.ok) return { ok: false, response: errorResponse({ ...key.failure, requestId }) }
  const body = await readJsonBody(request)
  if (!body.ok) return { ok: false, response: errorResponse({ ...body.failure, requestId }) }
  const db = requireDb(env)
  const now = new Date()
  await expirePendingProvisionals(db, now)
  return {
    ok: true,
    db,
    shareId,
    secretHash: await manageSecretHash(shareId, secret),
    operationKey: key.key,
    now,
    body: body.value,
  }
}
