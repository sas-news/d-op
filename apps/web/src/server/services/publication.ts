import { env } from "cloudflare:workers"
import type { D1Database } from "@cloudflare/workers-types"
import {
  contentHashOf,
  type DerivedFrom,
  issuePaths,
  projectPublicPlaylist,
  SharedPlaylistSchema,
} from "../../../../../packages/shared/src/index"
import { requireDb } from "../env"
import { createPendingSnapshot } from "../repositories/snapshots/create"
import { getActiveSnapshot } from "../repositories/snapshots/read"
import type { ConflictCode } from "../repositories/types"
import { generateManageSecret, generateShareId, manageSecretHash } from "../security/capability"
import { parseShareIdParam, readIdempotencyKey, readJsonBody } from "../security/http"
import { checkAdmission } from "./admission"
import { expirePendingProvisionals } from "./maintenance"
import { dataResponse, errorResponse, notFound, transientFailure } from "./respond"

// POST /api/v1/playlists and GET /api/v1/playlists/:shareId service policy.
// Route files stay thin: all validation, capability handling and repository
// orchestration lives here. SQL never leaves the repositories layer.

/**
 * Provisional create: validates the SharedPlaylist body + Idempotency-Key,
 * generates the shareId/manageSecret capabilities, stores only the
 * domain-separated secret hash and a non-readable pending snapshot, then
 * returns the plaintext secret exactly once (201). A replayed create receipt
 * can never return the lost secret — it maps to 409 CREATE_RECEIPT_UNAVAILABLE.
 */
export async function createPublication(request: Request, requestId: string): Promise<Response> {
  try {
    const denied = await checkAdmission({ env, request, requestId, cls: "create", mutation: true })
    if (denied !== null) return denied
    const key = readIdempotencyKey(request)
    if (!key.ok) return errorResponse({ ...key.failure, requestId })
    const body = await readJsonBody(request)
    if (!body.ok) return errorResponse({ ...body.failure, requestId })
    const parsed = SharedPlaylistSchema.safeParse(body.value)
    if (!parsed.success) {
      return errorResponse({
        status: 422,
        code: "SCHEMA_INVALID",
        message: "request body does not match the SharedPlaylist schema",
        requestId,
        details: fieldPaths(issuePaths(parsed.error)),
      })
    }
    const db = requireDb(env)
    const now = new Date()
    await expirePendingProvisionals(db, now)
    const shareId = generateShareId()
    const manageSecret = generateManageSecret()
    const result = await createPendingSnapshot(db, {
      shareId,
      secretHash: await manageSecretHash(shareId, manageSecret),
      operationKey: key.key,
      playlist: parsed.data,
      contentHash: await contentHashOf(parsed.data),
      now,
    })
    if (result.kind === "applied") {
      return dataResponse({ ...result.outcome, manageSecret }, 201)
    }
    if (result.kind === "replayed") {
      return errorResponse({
        status: 409,
        code: "CREATE_RECEIPT_UNAVAILABLE",
        message:
          "a publication already exists for this Idempotency-Key; its management secret was returned once and cannot be recovered — submit a new publish attempt with a new operation id",
        requestId,
      })
    }
    return createConflict(result.code, requestId)
  } catch {
    return transientFailure(requestId)
  }
}

/**
 * Public snapshot read: active, unblocked rows only — absent, pending,
 * deleted, blocked and expired-provisional ids are all the same 404, and a
 * lazy expiry sweep runs first so stale pending rows are gone rather than
 * merely hidden. `source` is projected only while the parent stays active and
 * public (derivedFrom is redacted from the playlist payload otherwise).
 */
export async function readPublication(
  shareIdParam: string | undefined,
  request: Request,
  requestId: string,
): Promise<Response> {
  try {
    const denied = await checkAdmission({ env, request, requestId, cls: "read", mutation: false })
    if (denied !== null) return denied
    const shareId = parseShareIdParam(shareIdParam)
    if (shareId === null) return notFound(requestId)
    const db = requireDb(env)
    const now = new Date()
    await expirePendingProvisionals(db, now)
    const snapshot = await getActiveSnapshot(db, shareId)
    if (snapshot === null || snapshot.blocked) return notFound(requestId)
    if (snapshot.firstPublishedAt === null) {
      // Active rows always carry first_published_at; anything else is a
      // corrupt persisted row and must fail closed, not silently re-derived.
      return transientFailure(requestId)
    }
    const projection = projectPublicPlaylist({
      playlist: snapshot.snapshot,
      parentPublic: await parentIsPublic(db, snapshot.snapshot.derivedFrom),
    })
    return dataResponse(
      {
        shareId: snapshot.shareId,
        revision: snapshot.revision,
        publishedAt: snapshot.firstPublishedAt,
        updatedAt: snapshot.updatedAt,
        contentHash: snapshot.contentHash,
        playlist: projection.playlist,
        itemCount: snapshot.itemCount,
        totalDurationMs: snapshot.totalDurationMs,
        importCount: snapshot.importCount,
        source: projection.source,
      },
      200,
    )
  } catch {
    return transientFailure(requestId)
  }
}

async function parentIsPublic(
  db: D1Database,
  derivedFrom: DerivedFrom | undefined,
): Promise<boolean> {
  if (derivedFrom === undefined) return false
  const parent = await getActiveSnapshot(db, derivedFrom.shareId)
  return parent !== null && parent.visibility === "public" && !parent.blocked
}

/** Field paths for `details` — validated issue paths only, root becomes "body". */
export function fieldPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    const normalized = path === "" ? "body" : path
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function createConflict(code: ConflictCode, requestId: string): Response {
  if (code === "IDEMPOTENCY_CONFLICT") {
    return errorResponse({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      message: "Idempotency-Key was already used with a different request",
      requestId,
    })
  }
  // ALREADY_EXISTS (generated-id collision), RECEIPT_PENDING and every other
  // unexpected conflict are server-side anomalies that retry cleanly.
  return transientFailure(requestId)
}
