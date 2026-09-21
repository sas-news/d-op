import type { APIRoute } from "astro"
import { deletePublication, patchPublication } from "../../../../server/services/mutations"
import { readPublication } from "../../../../server/services/publication"
import { methodNotAllowed, newRequestId } from "../../../../server/services/respond"

// GET/PATCH/DELETE /api/v1/playlists/:shareId — public snapshot read and
// capability-authenticated activate/replace/delete (contract v1).
export const GET: APIRoute = ({ params }) => readPublication(params["shareId"])

export const PATCH: APIRoute = ({ params, request }) => patchPublication(params["shareId"], request)

export const DELETE: APIRoute = ({ params, request }) =>
  deletePublication(params["shareId"], request)

export const ALL: APIRoute = () => methodNotAllowed(["GET", "PATCH", "DELETE"], newRequestId())
