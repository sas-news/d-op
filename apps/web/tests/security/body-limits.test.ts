import { beforeAll, describe, expect, it } from "vitest"
import { SHARE_REQUEST_BODY_MAX_BYTES } from "../../../../packages/shared/src/index"
import { PATCH as patchRoute } from "../../src/pages/api/v1/playlists/[shareId].js"
import { POST as createRoute } from "../../src/pages/api/v1/playlists/index.js"
import { API, call, errorOf, makePlaylist, migratedDb, publishPlaylist } from "./helpers.js"

// Given: request intake enforces the 256 KiB body cap while READING the byte
// stream, before JSON.parse — a Content-Length header is advisory only.
// When: bodies arrive chunked/streamed or under a lying Content-Length.
// Then: oversized bodies fail 413 regardless of declared length, and the
// exact boundary size still parses.

function streamedBody(totalBytes: number, chunkBytes: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let sent = 0
      while (sent < totalBytes) {
        const size = Math.min(chunkBytes, totalBytes - sent)
        controller.enqueue(new Uint8Array(size))
        sent += size
      }
      controller.close()
    },
  })
}

function postStream(
  path: string,
  body: ReadableStream<Uint8Array>,
  contentLength?: string,
): Request {
  const headers = new Headers({ "content-type": "application/json" })
  headers.set("idempotency-key", crypto.randomUUID())
  if (contentLength !== undefined) headers.set("content-length", contentLength)
  return new Request(`${API}${path}`, { method: "POST", headers, body })
}

describe("bounded request-body intake", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("rejects an oversized chunked/streamed body without Content-Length", async () => {
    // 320 KiB in 64 KiB chunks — the stream counter is the only authority.
    const request = postStream("", streamedBody(320 * 1024, 64 * 1024))
    const response = await call(createRoute, request)
    expect(response.status).toBe(413)
    const error = await errorOf(response)
    expect(error.code).toBe("BODY_TOO_LARGE")
  })

  it("rejects an oversized body whose Content-Length lies low", async () => {
    const request = postStream("", streamedBody(320 * 1024, 32 * 1024), "16")
    const response = await call(createRoute, request)
    expect(response.status).toBe(413)
    const error = await errorOf(response)
    expect(error.code).toBe("BODY_TOO_LARGE")
  })

  it("rejects early when declared Content-Length exceeds the cap", async () => {
    const request = postStream("", streamedBody(64, 64), String(SHARE_REQUEST_BODY_MAX_BYTES + 1))
    const response = await call(createRoute, request)
    expect(response.status).toBe(413)
  })

  it("accepts a body at exactly the 256 KiB boundary", async () => {
    const encoder = new TextEncoder()
    const json = JSON.stringify(makePlaylist({}))
    const jsonBytes = encoder.encode(json).length
    expect(jsonBytes).toBeLessThan(SHARE_REQUEST_BODY_MAX_BYTES)
    const padded = json + " ".repeat(SHARE_REQUEST_BODY_MAX_BYTES - jsonBytes)
    expect(encoder.encode(padded).length).toBe(SHARE_REQUEST_BODY_MAX_BYTES)
    const request = new Request(`${API}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: padded,
    })
    const response = await call(createRoute, request)
    expect(response.status).toBe(201)
  })

  it("rejects one byte over the boundary", async () => {
    const encoder = new TextEncoder()
    const json = JSON.stringify(makePlaylist({}))
    const padded = `${json}${" ".repeat(SHARE_REQUEST_BODY_MAX_BYTES - encoder.encode(json).length + 1)}`
    const request = new Request(`${API}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: padded,
    })
    const response = await call(createRoute, request)
    expect(response.status).toBe(413)
  })

  it("bounds PATCH bodies the same way", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const headers = new Headers({
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      authorization: `Bearer ${published.manageSecret}`,
    })
    const request = new Request(`${API}/${published.shareId}`, {
      method: "PATCH",
      headers,
      body: streamedBody(300 * 1024, 64 * 1024),
    })
    const response = await call(patchRoute, request, { shareId: published.shareId })
    expect(response.status).toBe(413)
  })
})
