import type { APIRoute } from "astro"
import { beforeAll, describe, expect, it } from "vitest"
import { POST as importRoute } from "../../src/pages/api/v1/playlists/[shareId]/import.js"
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
  ALL as shareAll,
} from "../../src/pages/api/v1/playlists/[shareId].js"
import { POST as createRoute } from "../../src/pages/api/v1/playlists/index.js"
import { classifyOrigin } from "../../src/server/security/origin.js"
import { dataOf, publishPlaylist } from "../publication-api/helpers.js"
import { call, errorOf, makePlaylist, migratedDb, secureRequest } from "./helpers.js"

// Given: the fixed-origin transport policy — extension background requests
// (absent or extension-scheme Origin, credentials omitted), same-origin page
// requests and non-browser callers are all legitimate; foreign browser
// origins are rejected on mutations only.
// When: the Origin matrix below hits each route class.
// Then: allowed classes reach normal validation; foreign origins get a
// bounded 400; no CORS response headers are ever emitted.

const SAME_ORIGIN = "https://d-op.sasnews.dev"

async function seedPending(): Promise<{ shareId: string; manageSecret: string }> {
  const created = await call(
    createRoute as APIRoute,
    secureRequest({
      method: "POST",
      path: "",
      body: makePlaylist({}),
      idempotencyKey: crypto.randomUUID(),
    }),
  )
  const data = (await dataOf(created)) as { shareId?: string; manageSecret?: string } | undefined
  if (created.status !== 201 || data?.shareId === undefined || data.manageSecret === undefined) {
    throw new Error(`seed failed: ${created.status}`)
  }
  return { shareId: data.shareId, manageSecret: data.manageSecret }
}

describe("origin classification", () => {
  const classify = (origin: string | undefined, url = `${SAME_ORIGIN}/api/v1/playlists`) => {
    const headers = new Headers()
    if (origin !== undefined) headers.set("origin", origin)
    return classifyOrigin(new Request(url, { method: "POST", headers }))
  }

  it("maps the Origin header to the expected class", () => {
    expect(classify(undefined)).toBe("absent")
    expect(classify("")).toBe("absent")
    expect(classify(SAME_ORIGIN)).toBe("same-origin")
    expect(classify("HTTPS://D-OP.SASNEWS.DEV")).toBe("same-origin")
    // Default port normalizes away — genuinely the same origin.
    expect(classify("https://d-op.sasnews.dev:443")).toBe("same-origin")
    expect(classify("chrome-extension://abcdefghijklmnop")).toBe("extension")
    expect(classify("moz-extension://7d3d4d3d-0000-4000-8000-000000000000")).toBe("extension")
    expect(classify("https://evil.example")).toBe("foreign")
    expect(classify("https://d-op.sasnews.dev.evil.example")).toBe("foreign")
    expect(classify("https://evil.example https://d-op.sasnews.dev")).toBe("foreign")
    expect(classify("null")).toBe("foreign")
    expect(classify("file:///etc/hosts")).toBe("foreign")
  })
})

describe("origin policy on the API surface", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  type MutationCase = {
    readonly name: string
    readonly expected: number
    readonly run: (origin: string | undefined, shareId: string, secret: string) => Promise<Response>
  }

  const mutationRoutes: MutationCase[] = [
    {
      name: "POST /api/v1/playlists",
      expected: 201,
      run: (origin) =>
        call(
          createRoute as APIRoute,
          secureRequest({
            method: "POST",
            path: "",
            body: makePlaylist({}),
            idempotencyKey: crypto.randomUUID(),
            ...(origin === undefined ? {} : { origin }),
          }),
        ),
    },
    {
      name: "PATCH /:shareId",
      expected: 200,
      run: (origin, shareId, secret) =>
        call(
          patchRoute as APIRoute,
          secureRequest({
            method: "PATCH",
            path: `/${shareId}`,
            body: { operation: "activate", expectedRevision: 1 },
            bearer: secret,
            idempotencyKey: crypto.randomUUID(),
            ...(origin === undefined ? {} : { origin }),
          }),
          { shareId },
        ),
    },
    {
      name: "DELETE /:shareId",
      expected: 204,
      run: (origin, shareId, secret) =>
        call(
          deleteRoute as APIRoute,
          secureRequest({
            method: "DELETE",
            path: `/${shareId}`,
            body: { expectedRevision: 1 },
            bearer: secret,
            idempotencyKey: crypto.randomUUID(),
            ...(origin === undefined ? {} : { origin }),
          }),
          { shareId },
        ),
    },
    {
      name: "POST /:shareId/import",
      expected: 204,
      run: (origin, shareId) =>
        call(
          importRoute as APIRoute,
          secureRequest({
            method: "POST",
            path: `/${shareId}/import`,
            body: { eventId: crypto.randomUUID() },
            ...(origin === undefined ? {} : { origin }),
          }),
          { shareId },
        ),
    },
  ]

  const allowedOrigins = [
    { label: "absent Origin (extension background / non-browser)", origin: undefined },
    { label: "same-origin page", origin: SAME_ORIGIN },
    { label: "chrome-extension scheme", origin: "chrome-extension://abcdefghijklmnopqrstuvwx" },
    {
      label: "moz-extension scheme",
      origin: "moz-extension://3f8b5d4e-aaaa-4bbb-8ccc-ddddeeeeffff",
    },
  ]

  for (const allowed of allowedOrigins) {
    for (const route of mutationRoutes) {
      it(`${route.name} admits ${allowed.label}`, async () => {
        const pending = await seedPending()
        const response = await route.run(allowed.origin, pending.shareId, pending.manageSecret)
        expect(response.status, `${route.name} with ${allowed.label}`).toBe(route.expected)
        expect(response.headers.get("access-control-allow-origin")).toBeNull()
        expect(response.headers.get("access-control-allow-credentials")).toBeNull()
      })
    }
  }

  const foreignOrigins = [
    "https://evil.example",
    "https://d-op.sasnews.dev.evil.example",
    "null",
    "file:///tmp/x",
    "https://a.example https://d-op.sasnews.dev",
  ]

  for (const foreign of foreignOrigins) {
    for (const route of mutationRoutes) {
      it(`${route.name} rejects foreign Origin ${foreign}`, async () => {
        const pending = await seedPending()
        const response = await route.run(foreign, pending.shareId, pending.manageSecret)
        expect(response.status).toBe(400)
        const error = await errorOf(response)
        expect(error.code).toBe("BAD_REQUEST")
        expect(error.message).toContain("cross-origin")
        expect(response.headers.get("access-control-allow-origin")).toBeNull()
      })
    }
  }

  it("GET stays public for a foreign browser Origin", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const response = await call(
      getRoute as APIRoute,
      secureRequest({
        method: "GET",
        path: `/${published.shareId}`,
        origin: "https://evil.example",
      }),
      { shareId: published.shareId },
    )
    expect(response.status).toBe(200)
  })

  it("OPTIONS preflight is a bare 405 with no CORS headers", async () => {
    const response = await call(
      shareAll as APIRoute,
      secureRequest({ method: "OPTIONS", path: "/whatever", origin: "https://evil.example" }),
      { shareId: "whatever" },
    )
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toContain("GET")
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(response.headers.get("access-control-allow-credentials")).toBeNull()
    expect(response.headers.get("access-control-allow-methods")).toBeNull()
  })
})
