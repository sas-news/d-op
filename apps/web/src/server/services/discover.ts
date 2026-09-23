import { env } from "cloudflare:workers"
import type { D1Database } from "@cloudflare/workers-types"
import { issuePaths, ListQuerySchema } from "../../../../../packages/shared/src/index"
import {
  type CollectionDeps,
  type CollectionOptions,
  type CollectionOutcome,
  type CollectionParams,
  runCollection,
} from "../discovery/engine"
import { listPublicTagCounts } from "../discovery/queries"
import { requireDb } from "../env"
import { checkAdmission } from "./admission"
import { expirePendingProvisionals } from "./maintenance"
import { fieldPaths } from "./publication"
import { dataResponse, errorResponse, transientFailure } from "./respond"

// GET /api/v1/playlists (collection) and GET /api/v1/playlists/tags (task 19).
// Public reads: same-origin shape contract {data}/{error}, no-store, the
// shared read rate-limit class (which is what makes snapshot creation
// read-rate-limited — materialization only ever happens inside an admitted
// read). No ownership or unlisted surface anywhere in these responses.

/** Parses and validates the collection query string against ListQuerySchema. */
export function parseCollectionQuery(
  request: Request,
):
  | { readonly ok: true; readonly params: CollectionParams }
  | { readonly ok: false; readonly paths: readonly string[] } {
  const url = new URL(request.url)
  const raw = Object.fromEntries(url.searchParams)
  const parsed = ListQuerySchema.safeParse(raw)
  if (!parsed.success) return { ok: false, paths: fieldPaths(issuePaths(parsed.error)) }
  return {
    ok: true,
    params: {
      sort: parsed.data.sort,
      q: parsed.data.q,
      tag: parsed.data.tag,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    },
  }
}

/** Maps the engine outcome to the fixed contract statuses (200/400/410). */
export function collectionOutcomeResponse(outcome: CollectionOutcome, requestId: string): Response {
  if (outcome.kind === "ok") {
    return dataResponse(
      {
        items: outcome.items,
        ...(outcome.nextCursor === null ? {} : { nextCursor: outcome.nextCursor }),
        ...(outcome.truncated ? { truncated: true } : {}),
        ranking: outcome.ranking,
      },
      200,
    )
  }
  if (outcome.kind === "expired-cursor") {
    return errorResponse({
      status: 410,
      code: "CURSOR_EXPIRED",
      message:
        "the pagination snapshot expired; restart the listing from the first page without the cursor parameter",
      requestId,
    })
  }
  return errorResponse({
    status: 400,
    code: "BAD_REQUEST",
    message: "the cursor is malformed, tampered, or belongs to a different query",
    requestId,
  })
}

/**
 * Shared query pipeline behind both the collection API and the /explore page:
 * read admission -> parse -> lazy pending sweep -> engine. `deps.now` is the
 * injected clock the worker tests drive; routes omit it for wall time.
 */
export async function runCollectionRequest(
  request: Request,
  requestId: string,
  deps: CollectionDeps = {},
  options: CollectionOptions = {},
): Promise<
  | { readonly stage: "denied"; readonly response: Response }
  | { readonly stage: "invalid-query"; readonly paths: readonly string[] }
  | { readonly stage: "ok"; readonly db: D1Database; readonly outcome: CollectionOutcome }
> {
  const denied = await checkAdmission({ env, request, requestId, cls: "read", mutation: false })
  if (denied !== null) return { stage: "denied", response: denied }
  const parsed = parseCollectionQuery(request)
  if (!parsed.ok) return { stage: "invalid-query", paths: parsed.paths }
  const db = requireDb(env)
  const now = deps.now ?? new Date()
  await expirePendingProvisionals(db, now)
  const outcome = await runCollection(db, parsed.params, { now }, options)
  return { stage: "ok", db, outcome }
}

export async function listCollection(
  request: Request,
  requestId: string,
  deps: CollectionDeps = {},
): Promise<Response> {
  try {
    const result = await runCollectionRequest(request, requestId, deps)
    if (result.stage === "denied") return result.response
    if (result.stage === "invalid-query") {
      return errorResponse({
        status: 400,
        code: "BAD_REQUEST",
        message: "query parameters do not match the collection schema",
        requestId,
        ...(result.paths.length > 0 ? { details: [...result.paths] } : {}),
      })
    }
    return collectionOutcomeResponse(result.outcome, requestId)
  } catch {
    return transientFailure(requestId)
  }
}

/** Public tag dictionary with public-only counts — for filter UIs. */
export async function listTags(request: Request, requestId: string): Promise<Response> {
  try {
    const denied = await checkAdmission({ env, request, requestId, cls: "read", mutation: false })
    if (denied !== null) return denied
    const db = requireDb(env)
    await expirePendingProvisionals(db, new Date())
    const tags = await listPublicTagCounts(db)
    return dataResponse({ tags }, 200)
  } catch {
    return transientFailure(requestId)
  }
}
