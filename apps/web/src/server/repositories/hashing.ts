import { canonicalBytes, sha256HexBytes } from "../../../../../packages/shared/src/index"

// Request/receipt hashing helpers. stableStringify fixes key order and drops
// absent optionals so a request hash depends only on validated request
// semantics, never on incoming key order. Reuses the shared canonical byte/SHA
// helpers; no secrets are hashed here (secret_hash arrives pre-computed).

export function stableStringify(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`
  }
  throw new TypeError(`cannot hash request containing ${typeof value}`)
}

/** SHA-256 hex of the canonical request descriptor. */
export async function hashRequest(descriptor: unknown): Promise<string> {
  return sha256HexBytes(canonicalBytes(stableStringify(descriptor)))
}

/** SHA-256 hex of arbitrary text (import event ids, test secrets). */
export async function sha256Hex(text: string): Promise<string> {
  return sha256HexBytes(canonicalBytes(text))
}

/**
 * Server-internal attempt nonce. Generated fresh inside each repository call;
 * dependent writes are gated on it so a pre-existing receipt can never
 * authorize a replay's increments.
 */
export function newAttemptNonce(): string {
  return crypto.randomUUID()
}

export function toIso(date: Date): string {
  return date.toISOString()
}

export function plusMs(date: Date, ms: number): string {
  return new Date(date.getTime() + ms).toISOString()
}
