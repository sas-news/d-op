import type { APIRoute } from "astro"
import { listCollection } from "../../../../server/services/discover"
import { createPublication } from "../../../../server/services/publication"
import { loggedApiRequest } from "../../../../server/services/request-log"
import { methodNotAllowed } from "../../../../server/services/respond"

// GET  /api/v1/playlists — public collection listing (task 19): adaptive
//      popular/new ranking over materialized 15-minute snapshots with
//      HMAC-signed cursors; active+public+unblocked rows only.
// POST /api/v1/playlists — provisional publication create (contract v1).
export const GET: APIRoute = ({ request }) =>
  loggedApiRequest(request, "/api/v1/playlists", (requestId) => listCollection(request, requestId))

export const POST: APIRoute = ({ request }) =>
  loggedApiRequest(request, "/api/v1/playlists", (requestId) =>
    createPublication(request, requestId),
  )

export const ALL: APIRoute = ({ request }) =>
  loggedApiRequest(request, "/api/v1/playlists", (requestId) =>
    methodNotAllowed(["GET", "POST"], requestId),
  )
