import { env } from "cloudflare:workers"
import { ImportNotifyBodySchema, issuePaths } from "../../../../../packages/shared/src/index"
import { requireDb } from "../env"
import { sha256Hex } from "../repositories/hashing"
import { recordImportEvent } from "../repositories/imports"
import { readJsonBody } from "../security/http"
import { checkAdmission } from "./admission"
import { expirePendingProvisionals } from "./maintenance"
import { fieldPaths } from "./publication"
import { errorResponse, noContentResponse, transientFailure } from "./respond"

// POST /api/v1/playlists/:shareId/import (task 13): best-effort aggregate
// accounting. Every well-formed request returns the identical 204 — counted,
// duplicate, unknown, unlisted, pending and deleted ids are deliberately
// indistinguishable (no existence oracle, no ownership disclosure). Only
// active + public + unblocked snapshots move counters, inside the
// repository's exactly-once guarded batch. No importer identity is stored:
// the random event id arrives as a UUID and only its domain-separated SHA-256
// hash is persisted for the 48 h receipt window.

export async function notifyImport(
  shareIdParam: string | undefined,
  request: Request,
  requestId: string,
): Promise<Response> {
  try {
    const denied = await checkAdmission({ env, request, requestId, cls: "import", mutation: true })
    if (denied !== null) return denied
    const body = await readJsonBody(request)
    if (!body.ok) return errorResponse({ ...body.failure, requestId })
    const parsed = ImportNotifyBodySchema.safeParse(body.value)
    if (!parsed.success) {
      return errorResponse({
        status: 422,
        code: "SCHEMA_INVALID",
        message: "request body does not match the import notification schema",
        requestId,
        details: fieldPaths(issuePaths(parsed.error)),
      })
    }
    const db = requireDb(env)
    const now = new Date()
    await expirePendingProvisionals(db, now)
    await recordImportEvent(db, {
      // Raw param is bound into an EXISTS predicate; a malformed or unknown id
      // simply matches nothing and still yields the same 204.
      shareId: shareIdParam ?? "",
      eventHash: await sha256Hex(`dop-import:${parsed.data.eventId}`),
      now,
    })
    return noContentResponse()
  } catch {
    return transientFailure(requestId)
  }
}
