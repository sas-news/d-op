// Bounded Share mutation client tests (task 15): every call hits the fixed
// API path with credentials omitted, redirects rejected, an Idempotency-Key
// header, and (for PATCH/DELETE) the manageSecret only as a Bearer header.
// Responses stream through the byte cap before strict zod validation, and
// HTTP failures map to bounded reasons — conflicts disclose the remote
// revision so the UI can offer an explicit overwrite retry.
import { describe, expect, it } from "vitest"
import type { FetchLike } from "../../src/share/api-client"
import {
  createPublication,
  deletePublication,
  patchPublication,
} from "../../src/share/management-client"
import { header, MANAGE_SECRET, NOW, SHARE_ID, sharePlaylist } from "./fixtures"

const API = "https://d-op.sasnews.dev"
const KEY = "00000000-0000-4000-8000-000000000001"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function errorJson(status: number, code: string, details?: { revision: number }): Response {
  return json(
    { error: { code, message: "m", requestId: "r", ...(details ? { details } : {}) } },
    status,
  )
}

const createAck = {
  shareId: SHARE_ID,
  manageSecret: MANAGE_SECRET,
  revision: 1,
  contentHash: "a".repeat(64),
  createdAt: NOW,
  activationExpiresAt: NOW,
  state: "pending",
}

const patchAck = {
  shareId: SHARE_ID,
  revision: 2,
  contentHash: "a".repeat(64),
  publishedAt: NOW,
  updatedAt: NOW,
}

describe("management-client/createPublication", () => {
  it("POSTs the playlist to the fixed path with an Idempotency-Key and no credentials", async () => {
    let seen: { url: string; init: { [k: string]: unknown } } | undefined
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url, init }
      return json({ data: createAck }, 201)
    }
    const result = await createPublication({
      apiOrigin: API,
      fetchImpl,
      playlist: sharePlaylist(),
      idempotencyKey: KEY,
    })
    expect(result).toMatchObject({ kind: "ok", ack: { shareId: SHARE_ID, revision: 1 } })
    expect(seen?.url).toBe(`${API}/api/v1/playlists`)
    expect(seen?.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    })
    const headers = seen?.init["headers"] as Record<string, string>
    expect(header(headers, "idempotency-key")).toBe(KEY)
    expect(header(headers, "authorization")).toBeUndefined()
    expect(headers["content-type"]).toBe("application/json")
  })

  it("maps CREATE_RECEIPT_UNAVAILABLE to receipt-unavailable", async () => {
    const result = await createPublication({
      apiOrigin: API,
      fetchImpl: async () => errorJson(409, "CREATE_RECEIPT_UNAVAILABLE"),
      playlist: sharePlaylist(),
      idempotencyKey: KEY,
    })
    expect(result).toMatchObject({ kind: "error", reason: "receipt-unavailable", status: 409 })
  })

  it("rejects malformed success envelopes and oversized bodies", async () => {
    const bad = await createPublication({
      apiOrigin: API,
      fetchImpl: async () => json({ data: { shareId: "x" } }, 201),
      playlist: sharePlaylist(),
      idempotencyKey: KEY,
    })
    expect(bad).toMatchObject({ kind: "error", reason: "invalid-response", status: 201 })

    const huge = await createPublication({
      apiOrigin: API,
      maxBytes: 16,
      fetchImpl: async () => json({ data: createAck }, 201),
      playlist: sharePlaylist(),
      idempotencyKey: KEY,
    })
    expect(huge).toMatchObject({ kind: "error", reason: "too-large" })
  })
})

describe("management-client/patchPublication", () => {
  it("sends the manageSecret only as a Bearer header", async () => {
    let headers: Record<string, string> | undefined
    const fetchImpl: FetchLike = async (_url, init) => {
      headers = init.headers as Record<string, string>
      return json({ data: patchAck })
    }
    const result = await patchPublication({
      apiOrigin: API,
      fetchImpl,
      shareId: SHARE_ID,
      secret: MANAGE_SECRET,
      operation: { operation: "activate", expectedRevision: 1 },
      idempotencyKey: KEY,
    })
    expect(result).toMatchObject({ kind: "ok", ack: { revision: 2 } })
    expect(header(headers ?? {}, "authorization")).toBe(`Bearer ${MANAGE_SECRET}`)
    expect(header(headers ?? {}, "idempotency-key")).toBe(KEY)
  })

  it("maps 409 REVISION_CONFLICT to conflict + disclosed remote revision", async () => {
    const result = await patchPublication({
      apiOrigin: API,
      fetchImpl: async () => errorJson(409, "REVISION_CONFLICT", { revision: 7 }),
      shareId: SHARE_ID,
      secret: MANAGE_SECRET,
      operation: { operation: "replace", expectedRevision: 2, playlist: sharePlaylist() },
      idempotencyKey: KEY,
    })
    expect(result).toMatchObject({
      kind: "error",
      reason: "revision-conflict",
      remoteRevision: 7,
    })
  })

  it("rejects a malformed shareId without any network call", async () => {
    let called = false
    const result = await patchPublication({
      apiOrigin: API,
      fetchImpl: async () => {
        called = true
        return json({ data: patchAck })
      },
      shareId: "not-a-share-id",
      secret: MANAGE_SECRET,
      operation: { operation: "activate", expectedRevision: 1 },
      idempotencyKey: KEY,
    })
    expect(result).toMatchObject({ kind: "error", reason: "invalid-response" })
    expect(called).toBe(false)
  })

  it("maps 401/404/429/422/500 and network failures to bounded reasons", async () => {
    const cases: [number | "throw", string][] = [
      [401, "unauthorized"],
      [404, "not-found"],
      [429, "rate-limited"],
      [422, "schema-invalid"],
      [500, "unavailable"],
      ["throw", "network"],
    ]
    for (const [status, reason] of cases) {
      const fetchImpl: FetchLike =
        status === "throw"
          ? async () => {
              throw new TypeError("down")
            }
          : async () => errorJson(status, "X")
      const result = await patchPublication({
        apiOrigin: API,
        fetchImpl,
        shareId: SHARE_ID,
        secret: MANAGE_SECRET,
        operation: { operation: "activate", expectedRevision: 1 },
        idempotencyKey: KEY,
      })
      expect(result).toMatchObject({ kind: "error", reason })
    }
  })
})

describe("management-client/deletePublication", () => {
  it("issues a conditional DELETE and maps 204/404/409", async () => {
    let seen: { url: string; method: string | undefined } | undefined
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url, method: init.method }
      return new Response(null, { status: 204 })
    }
    const ok = await deletePublication({
      apiOrigin: API,
      fetchImpl,
      shareId: SHARE_ID,
      secret: MANAGE_SECRET,
      expectedRevision: 2,
      idempotencyKey: KEY,
    })
    expect(ok).toEqual({ kind: "ok" })
    expect(seen).toEqual({ url: `${API}/api/v1/playlists/${SHARE_ID}`, method: "DELETE" })

    const absent = await deletePublication({
      apiOrigin: API,
      fetchImpl: async () => errorJson(404, "NOT_FOUND"),
      shareId: SHARE_ID,
      secret: MANAGE_SECRET,
      expectedRevision: 2,
      idempotencyKey: KEY,
    })
    expect(absent).toMatchObject({ kind: "error", reason: "not-found" })

    const conflict = await deletePublication({
      apiOrigin: API,
      fetchImpl: async () => errorJson(409, "REVISION_CONFLICT", { revision: 9 }),
      shareId: SHARE_ID,
      secret: MANAGE_SECRET,
      expectedRevision: 2,
      idempotencyKey: KEY,
    })
    expect(conflict).toMatchObject({
      kind: "error",
      reason: "revision-conflict",
      remoteRevision: 9,
    })
  })
})
