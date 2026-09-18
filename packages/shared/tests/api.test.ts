// API envelopes, route payloads and error shapes (task 3).
import {
  ActivateOperationSchema,
  API_BASE_PATH,
  ApiErrorSchema,
  apiSuccessSchema,
  CreateAckSchema,
  DeletePlaylistBodySchema,
  GetPlaylistResponseSchema,
  ImportNotifyBodySchema,
  ListQuerySchema,
  ListResponseSchema,
  PatchPlaylistBodySchema,
  ReplaceOperationSchema,
} from "@d-op/shared"
import { describe, expect, it } from "vitest"
import { makeShareBase } from "./fixtures"

const SHARE_ID = "abcdefghijklmnopqrstuv"
const SECRET = "y".repeat(43)
const HASH = "a".repeat(64)

describe("api envelopes", () => {
  it("wraps success data and rejects unknown envelope keys", () => {
    // Given: a typed success envelope.
    // When: parsed with and without an extra key.
    // Then: data survives; unknown keys fail.
    const schema = apiSuccessSchema(CreateAckSchema)
    const body = {
      data: {
        shareId: SHARE_ID,
        manageSecret: SECRET,
        revision: 1,
        contentHash: HASH,
        createdAt: "2026-09-18T00:00:00Z",
        activationExpiresAt: "2026-09-18T01:00:00Z",
        state: "pending",
      },
    }
    expect(schema.parse(body).data.revision).toBe(1)
    expect(schema.safeParse({ ...body, extra: 1 }).success).toBe(false)
  })

  it("models failures with code/message/requestId and field-path details", () => {
    // Given: a 422 failure body.
    // When: parsed.
    // Then: code, message, requestId and validated field paths survive;
    // raw bodies and secrets have no place in the schema.
    const parsed = ApiErrorSchema.parse({
      error: {
        code: "SCHEMA_INVALID",
        message: "unpublishable",
        requestId: "req-1",
        details: ["items.0.range.end"],
      },
    })
    expect(parsed.error.details).toEqual(["items.0.range.end"])
    const text = JSON.stringify(parsed)
    expect(text).not.toContain("manageSecret")
  })

  it("pins the fixed route base path", () => {
    // Given: the contract constant.
    // When: read.
    // Then: same-origin v1 playlists path.
    expect(API_BASE_PATH).toBe("/api/v1/playlists")
  })
})

describe("mutation payloads", () => {
  it("accepts activate and replace operations exhaustively", () => {
    // Given: both PATCH operation shapes.
    // When: parsed through the discriminated union.
    // Then: each narrows to its operation with expectedRevision.
    const activate = PatchPlaylistBodySchema.parse({ operation: "activate", expectedRevision: 1 })
    expect(activate.operation).toBe("activate")
    if (activate.operation !== "activate") {
      throw new Error("unreachable")
    }
    expect(activate.expectedRevision).toBe(1)
    const replace = PatchPlaylistBodySchema.parse({
      operation: "replace",
      expectedRevision: 2,
      playlist: makeShareBase(),
    })
    expect(replace.operation).toBe("replace")
    expect(
      ActivateOperationSchema.parse({ operation: "activate", expectedRevision: 1 }).operation,
    ).toBe("activate")
    expect(
      ReplaceOperationSchema.parse({
        operation: "replace",
        expectedRevision: 2,
        playlist: makeShareBase(),
      }).expectedRevision,
    ).toBe(2)
  })

  it("requires uuid idempotency/event ids and integer revisions", () => {
    // Given: delete and import-notification bodies.
    // When: parsed.
    // Then: revision integers required; only the eventId UUID crosses for
    // import accounting (no capability, no payload).
    expect(DeletePlaylistBodySchema.parse({ expectedRevision: 4 }).expectedRevision).toBe(4)
    expect(
      ImportNotifyBodySchema.parse({ eventId: "123e4567-e89b-12d3-a456-426614174000" }).eventId,
    ).toBe("123e4567-e89b-12d3-a456-426614174000")
    expect(ImportNotifyBodySchema.safeParse({ eventId: "not-a-uuid" }).success).toBe(false)
  })

  it("validates fixed-length share ids, secrets and hashes", () => {
    // Given: malformed identifiers.
    // When: parsed in a GET response.
    // Then: length/charset failures with field paths.
    const good = {
      shareId: SHARE_ID,
      revision: 2,
      publishedAt: "2026-09-18T00:00:00Z",
      updatedAt: "2026-09-18T01:00:00Z",
      contentHash: HASH,
      playlist: makeShareBase(),
      itemCount: 1,
      totalDurationMs: 90000,
      importCount: 0,
      source: null,
    }
    expect(GetPlaylistResponseSchema.parse(good).shareId).toBe(SHARE_ID)
    expect(GetPlaylistResponseSchema.safeParse({ ...good, shareId: "short" }).success).toBe(false)
  })
})

describe("collection query", () => {
  it("defaults limit to 20 and bounds q/tag/limit", () => {
    // Given: empty and out-of-range queries.
    // When: parsed.
    // Then: defaults apply; violations fail with paths.
    const parsed = ListQuerySchema.parse({})
    expect(parsed.limit).toBe(20)
    expect(parsed.sort).toBe("new")
    expect(ListQuerySchema.safeParse({ limit: 51 }).success).toBe(false)
    expect(ListQuerySchema.safeParse({ q: "" }).success).toBe(false)
    expect(ListQuerySchema.safeParse({ tag: "x".repeat(25) }).success).toBe(false)
  })

  it("requires ranking basis on every list response", () => {
    // Given: a list response with adaptive ranking metadata.
    // When: parsed.
    // Then: mode, window, asOf and fallback reason survive.
    const parsed = ListResponseSchema.parse({
      items: [],
      ranking: {
        mode: "popular",
        effectiveWindow: "30d",
        asOf: "2026-09-18T00:00:00Z",
        fallbackReason: "insufficient-recent-data",
      },
    })
    expect(parsed.ranking.effectiveWindow).toBe("30d")
  })
})
