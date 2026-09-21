import { type SharedPlaylist, SharedPlaylistSchema } from "../../../../packages/shared/src/index"
import { GET as listRoute } from "../../src/pages/api/v1/playlists/index.js"
import { loadSharePage, type SharePageResult } from "../../src/server/services/share-page.js"
import { apiRequest, call, dataOf, makePlaylist } from "../publication-api/helpers.js"

// Shared fixtures for the Remix provenance suite (task 20). Same discipline
// as publication-api: everything under test goes through the real Astro
// route handlers and services against the per-file Miniflare D1 — direct
// seeds only where write-path validation must be bypassed on purpose.

export {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "../../src/pages/api/v1/playlists/[shareId].js"
export { POST as createRoute } from "../../src/pages/api/v1/playlists/index.js"
export { seedPlaylist } from "../discovery/helpers.js"
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
  makePlaylist,
  migratedDb,
  patchShare,
  postCreate,
  publishPlaylist,
} from "../publication-api/helpers.js"

/** A valid SharedPlaylist carrying a derivedFrom link (parse-checked). */
export function remixPlaylist(
  derivedFrom: { readonly shareId: string; readonly revision: number },
  title: string,
): SharedPlaylist {
  return SharedPlaylistSchema.parse({ ...makePlaylist({ title }), derivedFrom })
}

/** Collection GET items — the public list surface (`?q=` narrows the search). */
export async function listItems(query = ""): Promise<readonly Record<string, unknown>[]> {
  const res = await call(
    listRoute,
    apiRequest({ method: "GET", path: `?sort=new&limit=50${query}` }),
  )
  const data = (await dataOf(res)) as { items?: Record<string, unknown>[] }
  return data.items ?? []
}

/** /p/:shareId view-model load; `query` is appended verbatim (`?remix=2`). */
export function page(shareId: string, query = ""): Promise<SharePageResult> {
  return loadSharePage(
    shareId,
    new Request(`https://d-op.sasnews.dev/p/${shareId}${query}`),
    crypto.randomUUID(),
  )
}

/** Well-formed but never-created shareId for forged-lineage cases. */
export const PHANTOM_PARENT = "ZZZZZZZZZZZZZZZZZZZZZZ"
