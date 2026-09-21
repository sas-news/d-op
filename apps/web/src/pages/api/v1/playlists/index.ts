import type { APIRoute } from "astro"
import { createPublication } from "../../../../server/services/publication"
import { methodNotAllowed, newRequestId } from "../../../../server/services/respond"

// POST /api/v1/playlists — provisional publication create (contract v1).
//
// The GET collection route from the contract table is deliberately deferred
// to task 19 (adaptive discovery owns ranking snapshots, HMAC cursors and the
// public listing read it needs — the task-12 repository ships no listing
// read, and SQL may not live outside it). Until then every non-POST method is
// a contract-honest 405 with Allow: POST rather than a fake empty listing.
export const POST: APIRoute = ({ request }) => createPublication(request)

export const ALL: APIRoute = () => methodNotAllowed(["POST"], newRequestId())
