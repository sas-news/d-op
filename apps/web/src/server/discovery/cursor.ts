import { SnapshotRepositoryError } from "../repositories/errors"
import { sha256Hex } from "../repositories/hashing"

// Opaque pagination cursors for the collection endpoint (task 19).
//
// A cursor is `<base64url payload>.<base64url HMAC-SHA256>`. The payload is a
// fixed-key-order JSON document `{v:1, s:snapshotId, o:offset, f:fingerprint}`
// — never user data, never secrets. The signature uses the snapshot row's own
// 256-bit CSPRNG `cursor_key` (migration 0008): a worker-held secret scoped to
// the 15-minute snapshot lifetime, so there is no long-lived key material to
// provision, commit or leak, and rotation is inherent in snapshot expiry.
// Verification rejects on malformed shape, signature mismatch and fingerprint
// mismatch — callers map those to 400, an absent/expired snapshot to 410.

export type CursorPayload = {
  readonly v: 1
  /** Snapshot id the cursor continues from. */
  readonly s: string
  /** Consumed entry positions inside the frozen snapshot. */
  readonly o: number
  /** Query+policy fingerprint digest the cursor is bound to. */
  readonly f: string
}

const CURSOR_VERSION = 1
const CURSOR_KEY_BYTES = 32
const FINGERPRINT_HEX = /^[0-9a-f]{64}$/

/** Fresh base64url cursor-signing key stored on a snapshot row. */
export function newCursorKey(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(CURSOR_KEY_BYTES)))
}

/**
 * SHA-256 hex fingerprint of the canonical query+policy descriptor. The
 * descriptor uses NORMALIZED filter values (already canonicalized by policy
 * helpers) plus the requested sort and the decided mode/window, so a snapshot
 * is reusable only by an equivalent query under the same ranking basis.
 */
export async function queryFingerprint(descriptor: {
  readonly sort: string
  readonly mode: string
  readonly window: string
  readonly q: string | null
  readonly tag: string | null
}): Promise<string> {
  const canonical = JSON.stringify({
    f: 1,
    m: descriptor.mode,
    q: descriptor.q,
    s: descriptor.sort,
    t: descriptor.tag,
    w: descriptor.window,
  })
  return sha256Hex(canonical)
}

/** Signs a cursor payload with the snapshot's key. Returns the opaque token. */
export async function signCursor(payload: CursorPayload, keyBase64: string): Promise<string> {
  const body = base64UrlEncode(utf8(serializePayload(payload)))
  const signature = await hmacSha256(keyBase64, body)
  return `${body}.${signature}`
}

/**
 * Parses the outer `body.signature` shape WITHOUT verifying. Continuations
 * need the snapshot id to find the row that carries the signing key, so the
 * split/parse happens before verification; the payload is not trusted until
 * `verifyCursorSignature` passes.
 */
export function decodeCursorPayload(cursor: string): CursorPayload | null {
  const dot = cursor.indexOf(".")
  if (dot <= 0 || dot === cursor.length - 1 || cursor.indexOf(".", dot + 1) !== -1) {
    return null
  }
  const body = cursor.slice(0, dot)
  const payload = parsePayload(decodeUtf8(body))
  return payload
}

/**
 * Verifies the signature on `cursor` against `keyBase64`. Constant-time
 * comparison on the raw MAC bytes; any parse/tamper failure is one null.
 */
export async function verifyCursorSignature(
  cursor: string,
  keyBase64: string,
): Promise<CursorPayload | null> {
  const dot = cursor.indexOf(".")
  if (dot <= 0 || dot === cursor.length - 1 || cursor.indexOf(".", dot + 1) !== -1) {
    return null
  }
  const body = cursor.slice(0, dot)
  const presented = cursor.slice(dot + 1)
  const key = base64UrlDecode(keyBase64)
  if (key === null || key.length !== CURSOR_KEY_BYTES) return null
  const expected = await hmacSha256(keyBase64, body)
  const presentedBytes = base64UrlDecode(presented)
  const expectedBytes = base64UrlDecode(expected)
  if (
    presentedBytes === null ||
    expectedBytes === null ||
    !constantTimeEqual(presentedBytes, expectedBytes)
  ) {
    return null
  }
  return parsePayload(decodeUtf8(body))
}

function serializePayload(payload: CursorPayload): string {
  return JSON.stringify({ f: payload.f, o: payload.o, s: payload.s, v: payload.v })
}

function parsePayload(json: string | null): CursorPayload | null {
  if (json === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const { v, s, o, f } = record
  if (v !== CURSOR_VERSION) return null
  if (typeof s !== "string" || s.length === 0 || s.length > 64) return null
  if (typeof o !== "number" || !Number.isInteger(o) || o < 0 || o > 1_000_000) return null
  if (typeof f !== "string" || !FINGERPRINT_HEX.test(f)) return null
  return { v: 1, s, o, f }
}

async function hmacSha256(keyBase64: string, message: string): Promise<string> {
  const keyBytes = base64UrlDecode(keyBase64)
  if (keyBytes === null) {
    throw new SnapshotRepositoryError("ASSERTION_FAILED", "snapshot cursor key is not decodable")
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign("HMAC", key, new Uint8Array(utf8(message)))
  return base64UrlEncode(new Uint8Array(mac))
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function decodeUtf8(bodyBase64: string): string | null {
  const bytes = base64UrlDecode(bodyBase64)
  if (bytes === null) return null
  try {
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

function base64UrlDecode(text: string): Uint8Array | null {
  if (text.length === 0 || !BASE64URL_RE.test(text)) return null
  const padded = text.replaceAll("-", "+").replaceAll("_", "/")
  const paddedLength = padded.length + ((4 - (padded.length % 4)) % 4)
  try {
    const binary = atob(padded.padEnd(paddedLength, "="))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  }
  return diff === 0
}
