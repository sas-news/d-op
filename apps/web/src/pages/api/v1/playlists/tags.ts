import type { APIRoute } from "astro"
import { listTags } from "../../../../server/services/discover"
import { loggedApiRequest } from "../../../../server/services/request-log"
import { methodNotAllowed } from "../../../../server/services/respond"

// GET /api/v1/playlists/tags — the public tag dictionary (task 19):
// canonical tags with counts over active+public+unblocked playlists only.
// A static segment here outranks the dynamic [shareId] route, and "tags" can
// never collide with a real shareId (fixed 22-char base64url shape).
export const GET: APIRoute = ({ request }) =>
  loggedApiRequest(request, "/api/v1/playlists/tags", (requestId) => listTags(request, requestId))

export const ALL: APIRoute = ({ request }) =>
  loggedApiRequest(request, "/api/v1/playlists/tags", (requestId) =>
    methodNotAllowed(["GET"], requestId),
  )
