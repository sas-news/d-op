import {
  canonicalBytes,
  MANAGE_SECRET_LENGTH,
  ManageSecretSchema,
  SHARE_ID_LENGTH,
  sha256HexBytes,
} from "../../../../../packages/shared/src/index"

// Bearer-capability generation and hashing for the publication API (task 13).
//
// shareId and manageSecret are high-entropy random capabilities, never
// passwords: 16 CSPRNG bytes -> 22-char base64url id, 32 CSPRNG bytes ->
// 43-char base64url secret. Only SHA-256 of the domain-separated
// "dop-manage:<shareId>:<secret>" string is persisted; the plaintext secret is
// returned exactly once by POST and is never stored, logged or re-emitted.
//
// Secret comparison deliberately has no JavaScript call site: authentication is
// the `secret_hash = ?` predicate inside the repository's guarded D1 batch, so
// the capability check is atomic with the write it authorizes (a JS pre-check
// would be a TOCTOU bug). The compared value is a fixed-length SHA-256
// verifier, so the storage-layer comparison exposes no useful timing oracle.

const SHARE_ID_BYTES = 16
const MANAGE_SECRET_BYTES = 32
const SECRET_DOMAIN_PREFIX = "dop-manage:"

/** RFC 4648 base64url (no padding) of `count` CSPRNG bytes. */
function base64UrlOfRandomBytes(count: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(count))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

/** New share id: base64url of 16 random bytes -> exactly 22 chars. */
export function generateShareId(): string {
  const shareId = base64UrlOfRandomBytes(SHARE_ID_BYTES)
  if (shareId.length !== SHARE_ID_LENGTH) {
    throw new Error("CSPRNG share id has unexpected length")
  }
  return shareId
}

/** New management secret: base64url of 32 random bytes -> exactly 43 chars. */
export function generateManageSecret(): string {
  const secret = base64UrlOfRandomBytes(MANAGE_SECRET_BYTES)
  if (secret.length !== MANAGE_SECRET_LENGTH) {
    throw new Error("CSPRNG manage secret has unexpected length")
  }
  return secret
}

/** SHA-256 hex of the domain-separated capability verifier. */
export async function manageSecretHash(shareId: string, manageSecret: string): Promise<string> {
  return sha256HexBytes(canonicalBytes(`${SECRET_DOMAIN_PREFIX}${shareId}:${manageSecret}`))
}

/**
 * Extracts the Bearer manage secret from Authorization. Returns null when the
 * header is missing, is not a single Bearer token, or fails the shared
 * 43-char capability format — all map to the same 401, never distinguished.
 */
export function extractBearerSecret(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (header === null) return null
  const parts = header.trim().split(/\s+/)
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null
  const parsed = ManageSecretSchema.safeParse(parts[1])
  return parsed.success ? parsed.data : null
}
