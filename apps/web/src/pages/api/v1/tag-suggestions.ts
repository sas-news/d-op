import type { APIRoute } from "astro"
import { loggedApiRequest } from "../../../server/services/request-log"
import { methodNotAllowed } from "../../../server/services/respond"
import { suggestTags } from "../../../server/services/tag-suggest"

// POST /api/v1/tag-suggestions — canonical tag candidates for a playlist's
// works, resolved from upstream metadata with a D1 cache. The body carries
// only titles (+ optional opaque work ids); the contract lives in
// packages/shared/src/api.ts (TagSuggestion* schemas).
export const POST: APIRoute = ({ request }) =>
  loggedApiRequest(request, "/api/v1/tag-suggestions", (requestId) =>
    suggestTags(request, requestId),
  )

export const ALL: APIRoute = ({ request }) =>
  loggedApiRequest(request, "/api/v1/tag-suggestions", (requestId) =>
    methodNotAllowed(["POST"], requestId),
  )
