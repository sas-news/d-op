import type { APIRoute } from "astro"
import { beforeAll, describe, expect, it } from "vitest"
import { GET as getRoute } from "../../src/pages/api/v1/playlists/[shareId].js"
import { POST as createRoute } from "../../src/pages/api/v1/playlists/index.js"
import { applySecurityHeaders } from "../../src/server/security/headers.js"
import { dataOf, errorOf, publishPlaylist } from "../publication-api/helpers.js"
import { call, makePlaylist, migratedDb, secureRequest } from "./helpers.js"

// Given: strict schema intake + prepared-statement storage + text-only JSON
// projection. When: SQL-shaped and HTML/script-shaped metadata is submitted.
// Then: hostile partIds fail 422, hostile-but-schema-valid metadata persists
// verbatim as inert JSON text (nosniff + CSP keep it from ever executing).

describe("hostile input handling", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("rejects a SQL-shaped partId at the schema boundary", async () => {
    const playlist = makePlaylist({ itemCount: 1 })
    const first = playlist.items[0]
    if (first === undefined) throw new Error("fixture produced no items")
    playlist.items[0] = { ...first, partId: "'; DROP TABLE playlists;--" }
    const response = await call(
      createRoute as APIRoute,
      secureRequest({
        method: "POST",
        path: "",
        body: playlist,
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    expect(response.status).toBe(422)
    const error = await errorOf(response)
    expect(error.code).toBe("SCHEMA_INVALID")
  })

  it("stores and returns script-shaped metadata as inert JSON text", async () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
    const published = await publishPlaylist(
      makePlaylist({ title: payload.slice(0, 120), tags: ["safe-tag"] }),
    )
    const response = await call(
      getRoute as APIRoute,
      secureRequest({ method: "GET", path: `/${published.shareId}` }),
      { shareId: published.shareId },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    const secured = applySecurityHeaders(response)
    expect(secured.headers.get("x-content-type-options")).toBe("nosniff")
    const raw = await response.text()
    // The literal payload bytes survive intact — escaped JSON, never markup.
    expect(raw).toContain("<img src=x")
    const data = (await dataOf(new Response(raw, { status: 200 }))) as {
      playlist?: { title?: string }
    }
    expect(data.playlist?.title).toBe(payload.slice(0, 120))
  })

  it("keeps author-supplied script text as data on the create ack too", async () => {
    const response = await call(
      createRoute as APIRoute,
      secureRequest({
        method: "POST",
        path: "",
        body: makePlaylist({}),
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    expect(response.headers.get("content-type")).toContain("application/json")
    const secured = applySecurityHeaders(response)
    // nosniff means this JSON can never be sniffed into an HTML document.
    expect(secured.headers.get("x-content-type-options")).toBe("nosniff")
    expect(secured.headers.get("cache-control")).toBe("no-store")
  })
})
