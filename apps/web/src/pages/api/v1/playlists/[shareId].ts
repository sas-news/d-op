import type { APIRoute } from "astro"
import { deletePublication, patchPublication } from "../../../../server/services/mutations"
import { readPublication } from "../../../../server/services/publication"
import { loggedApiRequest } from "../../../../server/services/request-log"
import { methodNotAllowed } from "../../../../server/services/respond"

// GET/PATCH/DELETE /api/v1/playlists/:shareId — public snapshot read and
// capability-authenticated activate/replace/delete (contract v1).
export const GET: APIRoute = ({ params, request }) =>
  loggedApiRequest(request, "/api/v1/playlists/:shareId", (requestId) =>
    readPublication(params["shareId"], request, requestId),
  )

export const PATCH: APIRoute = ({ params, request }) =>
  loggedApiRequest(request, "/api/v1/playlists/:shareId", (requestId) =>
    patchPublication(params["shareId"], request, requestId),
  )

export const DELETE: APIRoute = ({ params, request }) =>
  loggedApiRequest(request, "/api/v1/playlists/:shareId", (requestId) =>
    deletePublication(params["shareId"], request, requestId),
  )

export const ALL: APIRoute = ({ request }) =>
  loggedApiRequest(request, "/api/v1/playlists/:shareId", (requestId) =>
    methodNotAllowed(["GET", "PATCH", "DELETE"], requestId),
  )
