import type { APIRoute } from "astro"
import { notifyImport } from "../../../../../server/services/imports"
import { loggedApiRequest } from "../../../../../server/services/request-log"
import { methodNotAllowed } from "../../../../../server/services/respond"

// POST /api/v1/playlists/:shareId/import — best-effort import accounting;
// always 204 for a well-formed body so existence can never be probed.
export const POST: APIRoute = ({ params, request }) =>
  loggedApiRequest(request, "/api/v1/playlists/:shareId/import", (requestId) =>
    notifyImport(params["shareId"], request, requestId),
  )

export const ALL: APIRoute = ({ request }) =>
  loggedApiRequest(request, "/api/v1/playlists/:shareId/import", (requestId) =>
    methodNotAllowed(["POST"], requestId),
  )
