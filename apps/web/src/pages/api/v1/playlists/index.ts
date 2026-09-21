import type { APIRoute } from "astro"
import { createPublication } from "../../../../server/services/publication"
import { loggedApiRequest } from "../../../../server/services/request-log"
import { methodNotAllowed } from "../../../../server/services/respond"

// POST /api/v1/playlists — provisional publication create (contract v1).
//
// The GET collection route from the contract table is deliberately deferred
// to task 19 (adaptive discovery owns ranking snapshots, HMAC cursors and the
// public listing read it needs — the task-12 repository ships no listing
// read, and SQL may not live outside it). Until then every non-POST method is
// a contract-honest 405 with Allow: POST rather than a fake empty listing.
export const POST: APIRoute = ({ request }) =>
  loggedApiRequest(request, "/api/v1/playlists", (requestId) =>
    createPublication(request, requestId),
  )

export const ALL: APIRoute = ({ request }) =>
  loggedApiRequest(request, "/api/v1/playlists", (requestId) =>
    methodNotAllowed(["POST"], requestId),
  )
