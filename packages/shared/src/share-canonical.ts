import { InvalidCanonicalValueError } from "./share-errors"
import type { ContentHash, SharedPlaylist } from "./share-model"
import { SharedPlaylistSchema } from "./share-model"

function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
  }
  throw new InvalidCanonicalValueError(typeof value)
}
export function canonicalString(playlist: SharedPlaylist): string {
  return canonicalJson(playlist)
}
export function canonicalBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
export async function contentHashOf(playlist: SharedPlaylist): Promise<ContentHash> {
  return (await sha256HexBytes(canonicalBytes(canonicalString(playlist)))) as ContentHash
}
export function isDirty(currentCanonical: string, acknowledgedCanonical: string): boolean {
  return currentCanonical !== acknowledgedCanonical
}
export function validateSharedPlaylist(input: unknown): SharedPlaylist {
  return SharedPlaylistSchema.parse(input)
}
