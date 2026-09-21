import type { APIRoute } from "astro"
import { notifyImport } from "../../../../../server/services/imports"
import { methodNotAllowed, newRequestId } from "../../../../../server/services/respond"

// POST /api/v1/playlists/:shareId/import — best-effort import accounting;
// always 204 for a well-formed body so existence can never be probed.
export const POST: APIRoute = ({ params, request }) => notifyImport(params["shareId"], request)

export const ALL: APIRoute = () => methodNotAllowed(["POST"], newRequestId())
