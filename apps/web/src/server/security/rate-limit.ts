import {
  canonicalBytes,
  RATE_LIMITS,
  sha256HexBytes,
} from "../../../../../packages/shared/src/index"

// Workers rate-limit binding wiring (task 14).
//
// Each route class consults its own binding plus a route-wide protective
// binding, per the plan's defaults: creates 5/min and reads 120/min per actor,
// authenticated mutations 30/min per share, import notifications 30/min per
// actor. Period is always 60s and limits are approximate per-PoP (the binding
// contract), so no global-quota claim is made anywhere.
//
// Fail-safe contract:
//   - limiter call throws            -> "unavailable" -> service maps 503
//   - limiter reports !success       -> "limited"     -> service maps 429
//   - binding missing while the deployment marks protection required
//     (DOP_RATE_LIMIT_REQUIRED="true" in production vars)
//                                    -> "unavailable" -> 503, never silent
//       unlimited mutation access
//   - binding missing in dev/test (required flag unset)
//                                    -> allowed, so Miniflare suites can
//       inject fake bindings explicitly instead of relying on absence
//
// Actor keys never contain the raw IP: the connecting IP is HMACed with the
// RATE_LIMIT_HMAC_KEY secret when provisioned, else domain-separated SHA-256,
// and the digest input includes the UTC day so keys rotate daily. Keys exist
// only inside the limiter service — they are never logged or written to D1.

export type RateLimiterBinding = {
  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>
}

/** Structural view of the Worker env this module consumes. */
export type RateLimitEnv = {
  readonly RATE_LIMIT_API?: RateLimiterBinding | undefined
  readonly RATE_LIMIT_CREATE?: RateLimiterBinding | undefined
  readonly RATE_LIMIT_MUTATION?: RateLimiterBinding | undefined
  readonly RATE_LIMIT_IMPORT?: RateLimiterBinding | undefined
  readonly RATE_LIMIT_READ?: RateLimiterBinding | undefined
  readonly RATE_LIMIT_HMAC_KEY?: string | undefined
  readonly DOP_RATE_LIMIT_REQUIRED?: string | undefined
}

export type RateLimitClass = "create" | "mutation" | "import" | "read"

export type RateLimitVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "limited" | "unavailable" }

// Only binding-valued env keys — indexing stays `RateLimiterBinding | undefined`.
type BindingKey =
  | "RATE_LIMIT_CREATE"
  | "RATE_LIMIT_MUTATION"
  | "RATE_LIMIT_IMPORT"
  | "RATE_LIMIT_READ"

const CLASS_BINDINGS: Record<RateLimitClass, BindingKey> = {
  create: "RATE_LIMIT_CREATE",
  mutation: "RATE_LIMIT_MUTATION",
  import: "RATE_LIMIT_IMPORT",
  read: "RATE_LIMIT_READ",
}

const limited: RateLimitVerdict = { allowed: false, reason: "limited" }
const unavailable: RateLimitVerdict = { allowed: false, reason: "unavailable" }
const allowed: RateLimitVerdict = { allowed: true }

/** Single binding call, fail-safe: a throwing limiter is an outage, not a pass. */
export async function consultLimiter(
  binding: RateLimiterBinding,
  key: string,
): Promise<RateLimitVerdict> {
  try {
    const outcome = await binding.limit({ key })
    return outcome.success ? allowed : limited
  } catch {
    return unavailable
  }
}

/**
 * Admission decision for one request: route-wide protective limit first, then
 * the per-class limit. `shareId` scopes the mutation class per the contract.
 */
export async function enforceRateLimit(
  env: RateLimitEnv,
  request: Request,
  cls: RateLimitClass,
  shareId?: string,
): Promise<RateLimitVerdict> {
  const classBinding = env[CLASS_BINDINGS[cls]]
  const apiBinding = env.RATE_LIMIT_API
  if (classBinding === undefined || apiBinding === undefined) {
    return env.DOP_RATE_LIMIT_REQUIRED === "true" ? unavailable : allowed
  }
  const apiKey = `api:${await actorDigest(env, request)}`
  const apiVerdict = await consultLimiter(apiBinding, apiKey)
  if (!apiVerdict.allowed) return apiVerdict
  const classKey =
    cls === "mutation"
      ? `mutation:${shareId ?? "unknown-share"}`
      : `${cls}:${await actorDigest(env, request)}`
  return consultLimiter(classBinding, classKey)
}

/**
 * Daily-rotating, non-reversible actor key. HMAC-SHA256 keyed by the
 * deployment secret when RATE_LIMIT_HMAC_KEY is provisioned; otherwise a
 * domain-separated SHA-256 (the digest still never leaves the limiter and is
 * never logged — the secret additionally resists dictionary reversal of the
 * small IPv4 space, which is why production should provision it).
 */
async function actorDigest(env: RateLimitEnv, request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "no-actor-ip"
  const day = new Date().toISOString().slice(0, 10)
  const message = `dop-rl:${day}:${ip}`
  const secret = env.RATE_LIMIT_HMAC_KEY
  if (secret !== undefined && secret !== "") {
    // Fresh ArrayBuffer-backed copies: subtle crypto requires BufferSource.
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(canonicalBytes(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const signature = await crypto.subtle.sign("HMAC", key, new Uint8Array(canonicalBytes(message)))
    return toHex(new Uint8Array(signature))
  }
  return sha256HexBytes(canonicalBytes(message))
}

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

export { RATE_LIMITS }
