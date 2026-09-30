import type { APIRoute } from "astro"
import type { ListResponse } from "../../../../packages/shared/src/index"
import { POST as importRoute } from "../../src/pages/api/v1/playlists/[shareId]/import.js"
import { GET as getRoute } from "../../src/pages/api/v1/playlists/[shareId].js"
import { GET as listRoute } from "../../src/pages/api/v1/playlists/index.js"
import { GET as tagsRoute } from "../../src/pages/api/v1/playlists/tags.js"
import { loadSharePage, type SharePageResult } from "../../src/server/services/share-page.js"
import { apiRequest, call } from "../publication-api/helpers.js"

// Shared fixtures for the task-27 adversarial integration suite. Same
// discipline as publication-api/discovery/security: everything under test
// goes through the REAL Astro route handlers, services and repositories on
// the per-file Miniflare D1 — no fakes, no stubs. Direct SQL seeds/queries
// are used only to place pre-state or to validate the ACTUAL D1 changes a
// scenario produced (the task requires proving real writes, not responses).

export {
  cursorPayload,
  dayBefore,
  expireSnapshot,
  listData,
  listRequest,
  seedImport,
  seedMany,
  seedPlaylist,
  snapshotCount,
} from "../discovery/helpers.js"
export {
  activateShare,
  apiRequest,
  call,
  dataOf,
  db,
  deleteShare,
  envelopeOf,
  errorOf,
  getShare,
  importNotify,
  makePlaylist,
  migratedDb,
  patchShare,
  postCreate,
  publishPlaylist,
  seedPendingRow,
} from "../publication-api/helpers.js"
export { secureRequest } from "../security/helpers.js"

export const API = "https://d-op.sasnews.dev/api/v1/playlists"

/** Collection GET through the real route (wall clock) — params or a Request. */
export function listViaRoute(
  requestOrParams: Request | Record<string, string> = {},
): Promise<Response> {
  const request =
    requestOrParams instanceof Request
      ? requestOrParams
      : (() => {
          const query = new URLSearchParams(requestOrParams).toString()
          return new Request(`${API}${query === "" ? "" : `?${query}`}`, { method: "GET" })
        })()
  return call(listRoute as APIRoute, request)
}

/** Tag dictionary GET through the real route. */
export function tagsViaRoute(): Promise<Response> {
  return call(tagsRoute as APIRoute, new Request(`${API}/tags`, { method: "GET" }))
}

/** Public snapshot GET through the real route. */
export function getViaRoute(shareId: string): Promise<Response> {
  return call(getRoute as APIRoute, apiRequest({ method: "GET", path: `/${shareId}` }), {
    shareId,
  })
}

/** Import notification POST through the real route. */
export function importViaRoute(shareId: string, eventId: unknown, ip?: string): Promise<Response> {
  return call(
    importRoute as APIRoute,
    apiRequest({ method: "POST", path: `/${shareId}/import`, body: { eventId }, ip }),
    { shareId },
  )
}

/** /p/:shareId view-model load through the real service (admission included). */
export function sharePageView(shareId: string): Promise<SharePageResult> {
  return loadSharePage(
    shareId,
    new Request(`https://d-op.sasnews.dev/p/${shareId}`),
    crypto.randomUUID(),
  )
}

/**
 * Recursively collects every string leaf and every object key in a decoded
 * JSON value — the surface a secret could hide on regardless of field name.
 */
export function flattenJson(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    into.push(String(value))
    return into
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenJson(item, into)
    return into
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.push(key)
      flattenJson(entry, into)
    }
  }
  return into
}

/** Items of a decoded collection response (already validated by callers). */
export async function listBody(res: Response): Promise<ListResponse & { items: unknown[] }> {
  const body = (await res.json()) as { data?: ListResponse & { items: unknown[] }; error?: unknown }
  if (body.data === undefined) {
    throw new Error(`expected data envelope, got ${JSON.stringify(body.error ?? body)}`)
  }
  return body.data
}
