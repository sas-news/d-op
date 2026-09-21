import { foreignOriginMutation } from "../security/origin"
import type { RateLimitClass, RateLimitEnv } from "../security/rate-limit"
import { enforceRateLimit } from "../security/rate-limit"
import { errorResponse, rateLimited, transientFailure } from "./respond"

// Admission control for /api/v1/playlists routes (task 14). One call per
// service entry point applies, in order:
//   1. fixed-origin transport policy — foreign browser origins are rejected
//      on mutations before any state or body work (see security/origin.ts);
//   2. route-wide + per-class Workers rate limiting — fail-safe: a limiter
//      outage or a missing binding in a deployment that marks protection
//      required maps to 503, a refused limit maps to 429 + Retry-After.
// Origin classification is never authentication: capability, idempotency and
// schema checks still run unchanged for every admitted caller.
export async function checkAdmission(input: {
  readonly env: RateLimitEnv
  readonly request: Request
  readonly requestId: string
  readonly cls: RateLimitClass
  /** Validated shareId when the mutation class is per-share scoped. */
  readonly shareId?: string
  /** Foreign-origin rejection applies to mutations only; reads skip it. */
  readonly mutation: boolean
}): Promise<Response | null> {
  if (input.mutation && foreignOriginMutation(input.request)) {
    return errorResponse({
      status: 400,
      code: "BAD_REQUEST",
      message: "cross-origin browser requests cannot perform mutations",
      requestId: input.requestId,
    })
  }
  const verdict = await enforceRateLimit(input.env, input.request, input.cls, input.shareId)
  if (verdict.allowed) return null
  return verdict.reason === "limited"
    ? rateLimited(input.requestId)
    : transientFailure(input.requestId)
}
