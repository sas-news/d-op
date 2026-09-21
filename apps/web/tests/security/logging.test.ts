import type { APIRoute } from "astro"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { GET as getRoute, PATCH as patchRoute } from "../../src/pages/api/v1/playlists/[shareId].js"
import { POST as createRoute } from "../../src/pages/api/v1/playlists/index.js"
import { loggedApiRequest } from "../../src/server/services/request-log.js"
import { dataOf, errorOf } from "../publication-api/helpers.js"
import { call, makePlaylist, migratedDb, secureRequest } from "./helpers.js"

// Given: API requests produce structured logs with ONLY {event, requestId,
// route template, status, durationMs}. When: requests carry secrets, share
// ids, IPs and metadata sentinels. Then: no logged record contains them, and
// requestId correlates with the error envelope's requestId.

const SENTINEL_IP = "198.51.100.23"
const SENTINEL_TITLE = "SENTINEL-TITLE-9f27c2"

type LogEntry = Record<string, unknown>

function apiLogEntries(calls: unknown[][]): LogEntry[] {
  const entries: LogEntry[] = []
  for (const callArgs of calls) {
    for (const arg of callArgs) {
      if (typeof arg !== "string") continue
      try {
        const parsed: unknown = JSON.parse(arg)
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as LogEntry)["event"] === "api_request"
        ) {
          entries.push(parsed as LogEntry)
        }
      } catch {
        // not our structured record — ignored
      }
    }
  }
  return entries
}

describe("redacted structured API logging", () => {
  const logSpy = vi.spyOn(console, "log")

  beforeAll(async () => {
    await migratedDb()
  })

  afterEach(() => {
    logSpy.mockClear()
  })

  it("logs template route/status/requestId and never secrets, ids, bodies or IPs", async () => {
    const playlist = makePlaylist({ title: SENTINEL_TITLE })
    const created = await call(
      createRoute as APIRoute,
      secureRequest({
        method: "POST",
        path: "",
        body: playlist,
        idempotencyKey: crypto.randomUUID(),
        ip: SENTINEL_IP,
      }),
    )
    expect(created.status).toBe(201)
    const data = (await dataOf(created)) as { shareId: string; manageSecret: string }

    const patched = await call(
      patchRoute as APIRoute,
      secureRequest({
        method: "PATCH",
        path: `/${data.shareId}`,
        body: { operation: "activate", expectedRevision: 1 },
        bearer: data.manageSecret,
        idempotencyKey: crypto.randomUUID(),
        ip: SENTINEL_IP,
      }),
      { shareId: data.shareId },
    )
    expect(patched.status).toBe(200)

    const missing = await call(
      getRoute as APIRoute,
      secureRequest({ method: "GET", path: "/missingid", ip: SENTINEL_IP }),
      { shareId: "missingid" },
    )
    expect(missing.status).toBe(404)
    const missingError = await errorOf(missing)

    const raw = JSON.stringify(logSpy.mock.calls)
    const entries = apiLogEntries(logSpy.mock.calls)
    expect(entries.length).toBeGreaterThanOrEqual(3)

    const postEntry = entries.find((e) => e["route"] === "POST /api/v1/playlists")
    expect(postEntry).toBeDefined()
    expect(postEntry?.["status"]).toBe(201)
    const patchEntry = entries.find((e) => e["route"] === "PATCH /api/v1/playlists/:shareId")
    expect(patchEntry).toBeDefined()
    expect(patchEntry?.["status"]).toBe(200)
    const getEntry = entries.find((e) => e["route"] === "GET /api/v1/playlists/:shareId")
    expect(getEntry).toBeDefined()
    expect(getEntry?.["status"]).toBe(404)
    // The error envelope's requestId correlates with the log record.
    expect(getEntry?.["requestId"]).toBe(missingError.requestId)

    // Record shape is exactly the allowlist — no extra fields can sneak in.
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual([
        "durationMs",
        "event",
        "requestId",
        "route",
        "status",
      ])
      expect(String(entry["route"])).not.toContain(data.shareId)
    }

    // Sentinels: secret, shareId, raw IP, metadata title, Authorization value.
    expect(raw).not.toContain(data.manageSecret)
    expect(raw).not.toContain(data.shareId)
    expect(raw).not.toContain(SENTINEL_IP)
    expect(raw).not.toContain(SENTINEL_TITLE)
    expect(raw).not.toContain("Bearer")
    expect(raw).not.toContain("authorization")
  })

  it("a thrown handler escape logs a bare 503 and returns the fixed envelope", async () => {
    const request = new Request("https://d-op.sasnews.dev/api/v1/playlists", { method: "POST" })
    const response = await loggedApiRequest(request, "/api/v1/playlists", () => {
      throw new Error("synthetic storage fault with SQL detail")
    })
    expect(response.status).toBe(503)
    const error = await errorOf(response)
    expect(error.code).toBe("TRANSIENT_FAILURE")
    const entries = apiLogEntries(logSpy.mock.calls)
    const entry = entries.find((e) => e["status"] === 503)
    expect(entry).toBeDefined()
    expect(entry?.["requestId"]).toBe(error.requestId)
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain("synthetic storage fault")
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain("SQL")
  })
})
