import { env } from "cloudflare:workers"
import type { D1Database } from "@cloudflare/workers-types"
import type { APIContext, APIRoute } from "astro"
import {
  contentHashOf,
  type SharedPlaylist,
  SharedPlaylistSchema,
} from "../../../../packages/shared/src/index"
import { PATCH as patchRoute } from "../../src/pages/api/v1/playlists/[shareId].js"
import { POST as createRoute } from "../../src/pages/api/v1/playlists/index.js"
import { type DOpEnv, requireDb } from "../../src/server/env.js"
import { migrate } from "../../src/server/repositories/migrations.js"
import { createPendingSnapshot } from "../../src/server/repositories/snapshots/create.js"
import {
  generateManageSecret,
  generateShareId,
  manageSecretHash,
} from "../../src/server/security/capability.js"

// Shared fixtures for the publication-API worker suite. Everything under test
// is reached through the real Astro route handlers against the real per-file
// Miniflare D1 binding — no fake DB, no stubbed service layer.

export function db(): D1Database {
  return requireDb(env as DOpEnv)
}

export async function migratedDb(): Promise<D1Database> {
  const database = db()
  await migrate(database)
  return database
}

export const API = "https://d-op.sasnews.dev/api/v1/playlists"

/** Invokes an Astro route handler with the minimal context it consumes. */
export function call(
  route: APIRoute,
  request: Request,
  params: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(route({ request, params } as unknown as APIContext))
}

export type ApiRequestInit = {
  readonly method: string
  readonly path: string
  readonly body?: unknown
  readonly contentType?: string | null
  readonly idempotencyKey?: string | null
  readonly bearer?: string | null
  /** cf-connecting-ip value; distinguishes actors for import/rate-limit keys. */
  readonly ip?: string | null | undefined
}

/** Builds a Request; `body` objects are JSON-stringified, strings sent raw. */
export function apiRequest(init: ApiRequestInit): Request {
  const headers = new Headers()
  if (init.ip != null) headers.set("cf-connecting-ip", init.ip)
  if (init.bearer != null) headers.set("authorization", `Bearer ${init.bearer}`)
  if (init.idempotencyKey != null) headers.set("idempotency-key", init.idempotencyKey)
  if (init.contentType != null) headers.set("content-type", init.contentType)
  let body: string | undefined
  if (init.body !== undefined) {
    if (!headers.has("content-type")) headers.set("content-type", "application/json")
    body = typeof init.body === "string" ? init.body : JSON.stringify(init.body)
  }
  return new Request(`${API}${init.path}`, {
    method: init.method,
    headers,
    body: body ?? null,
  })
}

export type ApiErrorBody = {
  readonly code: string
  readonly message: string
  readonly requestId: string
  readonly details?: unknown
}

export type ApiEnvelope = {
  readonly data?: unknown
  readonly error?: ApiErrorBody
}

export async function envelopeOf(res: Response): Promise<ApiEnvelope> {
  return (await res.json()) as ApiEnvelope
}

export async function dataOf(res: Response): Promise<unknown> {
  return (await envelopeOf(res)).data
}

export async function errorOf(res: Response): Promise<ApiErrorBody> {
  const body = await envelopeOf(res)
  if (body.error === undefined) throw new Error(`expected error envelope, got ${res.status}`)
  return body.error
}

export function postCreate(playlist: unknown, key: string | null = crypto.randomUUID()): Request {
  return apiRequest({ method: "POST", path: "", body: playlist, idempotencyKey: key })
}

export function getShare(shareId: string): Request {
  return apiRequest({ method: "GET", path: `/${shareId}` })
}

export function patchShare(
  shareId: string,
  secret: string | null,
  key: string | null,
  body: unknown,
): Request {
  return apiRequest({
    method: "PATCH",
    path: `/${shareId}`,
    body,
    bearer: secret,
    idempotencyKey: key,
  })
}

export function activateShare(shareId: string, secret: string, key = crypto.randomUUID()): Request {
  return patchShare(shareId, secret, key, { operation: "activate", expectedRevision: 1 })
}

export function deleteShare(
  shareId: string,
  secret: string | null,
  key: string | null,
  expectedRevision: number,
): Request {
  return apiRequest({
    method: "DELETE",
    path: `/${shareId}`,
    body: { expectedRevision },
    bearer: secret,
    idempotencyKey: key,
  })
}

export function importNotify(shareId: string, eventId: unknown, ip?: string): Request {
  return apiRequest({ method: "POST", path: `/${shareId}/import`, body: { eventId }, ip })
}

export function makePlaylist(overrides: {
  readonly title?: string
  readonly tags?: readonly string[]
  readonly visibility?: "public" | "unlisted"
  readonly itemCount?: number
}): SharedPlaylist {
  const count = overrides.itemCount ?? 2
  const items = Array.from({ length: count }, (_, index) => ({
    partId: `part_${index}`,
    workId: `work_${index}`,
    title: `作品${index}`,
    episodeTitle: `第${index + 1}話`,
    episodeNumber: `${index + 1}`,
    range: { start: index * 1000, end: index * 1000 + 90000, name: "OP" },
  }))
  return SharedPlaylistSchema.parse({
    schemaVersion: 1,
    title: overrides.title ?? "共有リスト",
    description: "説明文",
    author: "author",
    tags: overrides.tags ?? ["tag-one"],
    visibility: overrides.visibility ?? "public",
    items,
  })
}

export type PublishedShare = {
  readonly shareId: string
  readonly manageSecret: string
  readonly contentHash: string
}

/** Drives the real POST + activate PATCH handlers to an active revision-2 row. */
export async function publishPlaylist(playlist: SharedPlaylist): Promise<PublishedShare> {
  const created = await call(createRoute, postCreate(playlist))
  if (created.status !== 201) throw new Error(`setup create failed: ${created.status}`)
  const ack = (await dataOf(created)) as {
    shareId: string
    manageSecret: string
    contentHash: string
  }
  const activated = await call(patchRoute, activateShare(ack.shareId, ack.manageSecret), {
    shareId: ack.shareId,
  })
  if (activated.status !== 200) throw new Error(`setup activate failed: ${activated.status}`)
  return { shareId: ack.shareId, manageSecret: ack.manageSecret, contentHash: ack.contentHash }
}

/** Seeds a pending row directly via the repository so `now` can be in the past. */
export async function seedPendingRow(
  now: Date,
): Promise<{ readonly shareId: string; readonly manageSecret: string }> {
  const shareId = generateShareId()
  const manageSecret = generateManageSecret()
  const playlist = makePlaylist({})
  const result = await createPendingSnapshot(db(), {
    shareId,
    secretHash: await manageSecretHash(shareId, manageSecret),
    operationKey: crypto.randomUUID(),
    playlist,
    contentHash: await contentHashOf(playlist),
    now,
  })
  if (result.kind !== "applied") throw new Error("seed pending failed")
  return { shareId, manageSecret }
}
