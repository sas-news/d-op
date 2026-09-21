// Fixtures + fake Share API for task-15 management tests. The fake implements
// the real contract surface (provisional create, activate/replace PATCH,
// conditional DELETE, public GET) over an in-memory table, records every
// request (method/headers/body) and supports scripted failure modes.
// Synthetic data only — no real d-Anime payloads, no real secrets.
import type { PublicationRecord } from "../../../../packages/shared/src/local-model"
import { canonicalString, contentHashOf } from "../../../../packages/shared/src/share-canonical"
import type { SharedPlaylist } from "../../../../packages/shared/src/share-model"
import {
  type PublishableLocalPlaylist,
  toPublishProjection,
} from "../../../../packages/shared/src/share-projection"
import type { FetchLike } from "../../src/share/api-client"

export const NOW = "2026-09-20T00:00:00.000Z"
export const SHARE_ID = "fakeShareId00000000000" // exactly 22 opaque chars
export const MANAGE_SECRET = "fakeManageSecret".padEnd(43, "0") // exactly 43
export const PLAYLIST_ID = "p1"

/** Plain record builder (snapshot/hash are placeholders — see linkedRecord). */
export function publicationRecord(overrides: Partial<PublicationRecord> = {}): PublicationRecord {
  return {
    shareId: SHARE_ID,
    localPlaylistId: PLAYLIST_ID,
    manageSecret: MANAGE_SECRET,
    revision: 2,
    contentHash: "a".repeat(64),
    sentSnapshot: "{}",
    acknowledgedHash: "b".repeat(64),
    visibility: "public",
    createdAt: NOW,
    updatedAt: NOW,
    state: "active",
    ...overrides,
  }
}

export function sharePlaylist(overrides: Partial<SharedPlaylist> = {}): SharedPlaylist {
  return {
    schemaVersion: 1,
    title: "共有リスト",
    description: "説明",
    author: "作者",
    tags: ["op"],
    visibility: "public",
    items: [
      {
        partId: "part-a",
        workId: "work-a",
        title: "Work a",
        episodeTitle: "Episode a",
        episodeNumber: "a",
        range: { start: 90_123, end: 180_987, name: "My OP" },
      },
    ],
    ...overrides,
  }
}

/** An active publication whose snapshot/hash match the CURRENT projection. */
export async function linkedRecord(
  playlist: PublishableLocalPlaylist,
  overrides: Partial<PublicationRecord> = {},
): Promise<PublicationRecord> {
  const projection = toPublishProjection(playlist, { visibility: "public" })
  const hash = await contentHashOf(projection)
  return {
    shareId: SHARE_ID,
    localPlaylistId: playlist.id,
    manageSecret: MANAGE_SECRET,
    revision: 2,
    contentHash: hash,
    sentSnapshot: canonicalString(projection),
    acknowledgedHash: hash,
    visibility: "public",
    createdAt: NOW,
    updatedAt: NOW,
    state: "active",
    ...overrides,
  }
}

export type ApiCall = {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown> | undefined
}

export type FakeRemote = {
  readonly shareId: string
  readonly secret: string
  revision: number
  state: "pending" | "active"
  playlist: SharedPlaylist
  contentHash: string
  readonly createdAt: string
  updatedAt: string
  publishedAt?: string
}

export type FakeApi = {
  readonly fetchImpl: FetchLike
  readonly calls: ApiCall[]
  readonly remotes: Map<string, FakeRemote>
  /** Process the next create then answer as if the response was lost. */
  dropNextCreateResponse: boolean
  /** Process the next PATCH then answer as if the response was lost. */
  dropNextPatch: boolean
  offline: boolean
}

function errorJson(status: number, code: string, details?: { revision: number }): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message: `fake ${code}`,
        requestId: "req-1",
        ...(details === undefined ? {} : { details }),
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  )
}

function dataJson(status: number, data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function headersOf(init: { headers?: HeadersInit }): Record<string, string> {
  const raw = init.headers
  if (raw === undefined) return {}
  if (raw instanceof Headers) return Object.fromEntries(raw.entries())
  if (Array.isArray(raw)) return Object.fromEntries(raw)
  return { ...raw }
}

/** Header names are case-insensitive — the client sends canonical casing. */
export function header(headers: Record<string, string>, name: string): string | undefined {
  const lowered = name.toLowerCase()
  return Object.entries(headers).find(([key]) => key.toLowerCase() === lowered)?.[1]
}

export function fakeShareApi(seedId = SHARE_ID, secret = MANAGE_SECRET): FakeApi {
  const calls: ApiCall[] = []
  const remotes = new Map<string, FakeRemote>()
  const createReceipts = new Set<string>()
  const api: FakeApi = {
    calls,
    remotes,
    dropNextCreateResponse: false,
    dropNextPatch: false,
    offline: false,
    fetchImpl: async (url, init) => {
      const headers = headersOf(init)
      const body =
        typeof init.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined
      calls.push({ method: init.method ?? "GET", url, headers, body })
      if (api.offline) throw new TypeError("fetch failed")
      const parsed = new URL(url)
      const match = /^\/api\/v1\/playlists(?:\/([A-Za-z0-9_-]+))?$/.exec(parsed.pathname)
      const id = match?.[1]
      const key = header(headers, "idempotency-key")
      const auth = header(headers, "authorization")
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined
      if (init.method === "POST" && id === undefined) {
        if (key === undefined) return errorJson(400, "BAD_REQUEST")
        if (createReceipts.has(key)) {
          return errorJson(409, "CREATE_RECEIPT_UNAVAILABLE")
        }
        createReceipts.add(key)
        const remote: FakeRemote = {
          shareId: seedId,
          secret,
          revision: 1,
          state: "pending",
          playlist: body as unknown as SharedPlaylist,
          contentHash: await contentHashOf(body as unknown as SharedPlaylist),
          createdAt: NOW,
          updatedAt: NOW,
        }
        remotes.set(seedId, remote)
        if (api.dropNextCreateResponse) {
          api.dropNextCreateResponse = false
          throw new TypeError("response lost")
        }
        return dataJson(201, {
          shareId: seedId,
          manageSecret: secret,
          revision: 1,
          contentHash: remote.contentHash,
          createdAt: NOW,
          activationExpiresAt: "2026-09-20T01:00:00.000Z",
          state: "pending",
        })
      }
      const remote = id === undefined ? undefined : remotes.get(id)
      if (init.method === "GET" && id !== undefined) {
        if (remote === undefined || remote.state !== "active") {
          return errorJson(404, "NOT_FOUND")
        }
        return dataJson(200, {
          shareId: remote.shareId,
          revision: remote.revision,
          publishedAt: remote.publishedAt ?? NOW,
          updatedAt: remote.updatedAt,
          contentHash: remote.contentHash,
          playlist: remote.playlist,
          itemCount: remote.playlist.items.length,
          totalDurationMs: remote.playlist.items.reduce(
            (sum, entry) => sum + (entry.range.end - entry.range.start),
            0,
          ),
          importCount: 0,
          source: null,
        })
      }
      if (remote === undefined) return errorJson(404, "NOT_FOUND")
      if (bearer !== remote.secret) return errorJson(401, "UNAUTHORIZED")
      if (key === undefined) return errorJson(400, "BAD_REQUEST")
      const respond = (response: Response): Response => {
        if (api.dropNextPatch && init.method === "PATCH") {
          api.dropNextPatch = false
          throw new TypeError("response lost")
        }
        return response
      }
      if (init.method === "PATCH") {
        if (body?.["operation"] === "activate") {
          if (remote.state === "active" && remote.revision === 2) {
            // Repeat-activate: the first ack was lost, server already applied.
            return respond(
              dataJson(200, {
                shareId: remote.shareId,
                revision: remote.revision,
                contentHash: remote.contentHash,
                publishedAt: remote.publishedAt ?? NOW,
                updatedAt: remote.updatedAt,
              }),
            )
          }
          if (remote.state !== "pending" || body["expectedRevision"] !== 1) {
            return respond(errorJson(409, "REVISION_CONFLICT", { revision: remote.revision }))
          }
          remote.state = "active"
          remote.revision = 2
          remote.publishedAt = NOW
          remote.updatedAt = NOW
          return respond(
            dataJson(200, {
              shareId: remote.shareId,
              revision: 2,
              contentHash: remote.contentHash,
              publishedAt: NOW,
              updatedAt: NOW,
            }),
          )
        }
        if (body?.["operation"] === "replace") {
          if (body["expectedRevision"] !== remote.revision) {
            return respond(errorJson(409, "REVISION_CONFLICT", { revision: remote.revision }))
          }
          remote.revision += 1
          remote.playlist = body["playlist"] as SharedPlaylist
          remote.contentHash = await contentHashOf(remote.playlist)
          remote.updatedAt = "2026-09-20T02:00:00.000Z"
          return respond(
            dataJson(200, {
              shareId: remote.shareId,
              revision: remote.revision,
              contentHash: remote.contentHash,
              publishedAt: remote.publishedAt ?? NOW,
              updatedAt: remote.updatedAt,
            }),
          )
        }
        return respond(errorJson(422, "SCHEMA_INVALID"))
      }
      if (init.method === "DELETE") {
        if (body?.["expectedRevision"] !== remote.revision) {
          return errorJson(409, "REVISION_CONFLICT", { revision: remote.revision })
        }
        remotes.delete(remote.shareId)
        return new Response(null, { status: 204 })
      }
      return errorJson(405, "METHOD_NOT_ALLOWED")
    },
  }
  return api
}
