// Best-effort aggregate import notification (task 18). After a local import
// commit has SUCCEEDED, the background fires one POST {eventId} to the fixed
// API origin's import route so the server can bump its anonymous daily and
// lifetime counters. Privacy contract: the body is a single random UUID —
// no install id, no playlist content, no sender identity — and credentials
// are always omitted. The send is fire-and-forget with a hard timeout: one
// immediate retry reuses the SAME minted event id (the server's 48 h receipt
// dedupes it), there is no persistent retry queue, and every failure is
// swallowed — a lost notification never affects the committed local playlist.

import type { FetchLike, FetchResponse } from "./api-client"

export type ImportNotifyOptions = {
  /** Fixed API origin (never page-supplied). */
  readonly apiOrigin: string
  readonly shareId: string
  readonly fetchImpl?: FetchLike
  /** Mints the event id; injectable for tests. Default crypto.randomUUID. */
  readonly newId?: () => string
  readonly timeoutMs?: number
  /** Total sends including the first attempt. Default 2 = one immediate retry. */
  readonly attempts?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_ATTEMPTS = 2

/**
 * Notify the share service that an import committed. Never throws, never logs
 * identifiers, and resolves only after the bounded attempts finish — callers
 * that want true fire-and-forget should `void` the promise.
 */
export async function notifyImportCommitted(options: ImportNotifyOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? (fetch as FetchLike)
  // Minted once per confirmed flow; every retry of THIS send reuses it so the
  // server-side receipt collapses a lost-response retry into one count.
  const eventId = (options.newId ?? (() => crypto.randomUUID()))()
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = `${options.apiOrigin}/api/v1/playlists/${options.shareId}/import`
  const body = JSON.stringify({ eventId })
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: FetchResponse
    try {
      response = await fetchImpl(url, {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      continue // network/timeout failure — bounded retry or give up quietly
    }
    // Release the stream either way; the 204 contract has no body to consume.
    await response.body?.cancel().catch(() => undefined)
    if (response.ok) return
  }
}
