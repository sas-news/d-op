// Pending-import registry (task 17). Deduplicates page requests and carries a
// short-lived token the extension-owned confirmation page uses to fetch the
// preview and confirm. Entries are in-memory only — a service-worker restart
// simply expires the flow (the page times out into "unavailable").
import type { GetPlaylistResponse } from "../../../../packages/shared/src/api"

export type PendingImportState = "awaiting-confirm" | "committed" | "cancelled" | "failed"

export type PendingImport = {
  readonly token: string
  readonly shareId: string
  readonly requestId: string
  readonly tabId?: number
  readonly createdAt: number
  readonly state: PendingImportState
  readonly response?: GetPlaylistResponse
}

export type AdmitResult =
  | { readonly kind: "accepted"; readonly token: string }
  | { readonly kind: "duplicate" }
  | { readonly kind: "throttled" }
  | { readonly kind: "full" }

export type ImportRequestBook = {
  readonly admit: (input: { shareId: string; requestId: string; tabId?: number }) => AdmitResult
  readonly get: (token: string) => PendingImport | undefined
  readonly attachPreview: (token: string, response: GetPlaylistResponse) => boolean
  readonly settle: (
    token: string,
    state: Exclude<PendingImportState, "awaiting-confirm">,
  ) => boolean
}

export type ImportRequestBookOptions = {
  readonly now?: () => number
  readonly newToken?: () => string
  /** Min spacing between distinct requests for the same shareId. */
  readonly throttleMs?: number
  /** How long an unconfirmed request stays confirmable. */
  readonly ttlMs?: number
  /** Max simultaneous live entries. */
  readonly maxPending?: number
}

export function createImportRequestBook(options: ImportRequestBookOptions = {}): ImportRequestBook {
  const now = options.now ?? (() => Date.now())
  const newToken = options.newToken ?? (() => crypto.randomUUID())
  const throttleMs = options.throttleMs ?? 1_500
  const ttlMs = options.ttlMs ?? 60_000
  const maxPending = options.maxPending ?? 8

  const pending = new Map<string, PendingImport>()
  const byRequestId = new Map<string, string>()
  const lastAdmitByShareId = new Map<string, number>()

  const sweep = (): void => {
    const cutoff = now() - ttlMs
    for (const [token, entry] of pending) {
      if (entry.createdAt < cutoff) {
        pending.delete(token)
        if (byRequestId.get(entry.requestId) === token) byRequestId.delete(entry.requestId)
      }
    }
    for (const [shareId, at] of lastAdmitByShareId) {
      if (at < cutoff) lastAdmitByShareId.delete(shareId)
    }
  }

  return {
    admit: ({ shareId, requestId, tabId }) => {
      sweep()
      if (byRequestId.has(requestId)) return { kind: "duplicate" }
      const last = lastAdmitByShareId.get(shareId)
      if (last !== undefined && now() - last < throttleMs) return { kind: "throttled" }
      if (pending.size >= maxPending) return { kind: "full" }
      const token = newToken()
      const entry: PendingImport = {
        token,
        shareId,
        requestId,
        ...(tabId === undefined ? {} : { tabId }),
        createdAt: now(),
        state: "awaiting-confirm",
      }
      pending.set(token, entry)
      byRequestId.set(requestId, token)
      lastAdmitByShareId.set(shareId, now())
      return { kind: "accepted", token }
    },
    get: (token) => {
      sweep()
      return pending.get(token)
    },
    attachPreview: (token, response) => {
      const entry = pending.get(token)
      if (entry === undefined || entry.state !== "awaiting-confirm") return false
      pending.set(token, { ...entry, response })
      return true
    },
    settle: (token, state) => {
      const entry = pending.get(token)
      if (entry === undefined || entry.state !== "awaiting-confirm") return false
      // Terminal transition only — a late cancel must not un-commit a save.
      pending.set(token, { ...entry, state })
      return true
    },
  }
}
