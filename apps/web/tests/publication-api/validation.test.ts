import { beforeAll, describe, expect, it } from "vitest"
import {
  CreateAckSchema,
  SHARE_REQUEST_BODY_MAX_BYTES,
} from "../../../../packages/shared/src/index"
import { POST as importRoute } from "../../src/pages/api/v1/playlists/[shareId]/import.js"
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "../../src/pages/api/v1/playlists/[shareId].js"
import { POST as createRoute } from "../../src/pages/api/v1/playlists/index.js"
import {
  apiRequest,
  call,
  dataOf,
  errorOf,
  getShare,
  importNotify,
  makePlaylist,
  migratedDb,
  patchShare,
  postCreate,
  publishPlaylist,
} from "./helpers.js"

// Fixed status map: 400 malformed, 401 missing/invalid capability, 404 absent,
// 413 body cap, 415 content type, 422 schema — with validated field paths in
// details and never an echo of the raw request.

describe("request validation and fixed status map", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("maps malformed JSON, wrong content type and oversized bodies to 400/415/413", async () => {
    const malformed = await call(
      createRoute,
      apiRequest({
        method: "POST",
        path: "",
        body: "{not json",
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    expect(malformed.status).toBe(400)
    expect((await errorOf(malformed)).code).toBe("BAD_REQUEST")

    const wrongType = await call(
      createRoute,
      apiRequest({
        method: "POST",
        path: "",
        body: "{}",
        contentType: "text/plain",
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    expect(wrongType.status).toBe(415)
    expect((await errorOf(wrongType)).code).toBe("UNSUPPORTED_MEDIA_TYPE")

    const oversized = await call(
      createRoute,
      apiRequest({
        method: "POST",
        path: "",
        body: `{"pad":"${"x".repeat(SHARE_REQUEST_BODY_MAX_BYTES)}"}`,
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    expect(oversized.status).toBe(413)
    expect((await errorOf(oversized)).code).toBe("BODY_TOO_LARGE")
  })

  it("rejects a missing or non-UUID Idempotency-Key with 400", async () => {
    const missing = await call(createRoute, postCreate(makePlaylist({}), null))
    expect(missing.status).toBe(400)
    const invalid = await call(createRoute, postCreate(makePlaylist({}), "not-a-uuid"))
    expect(invalid.status).toBe(400)
  })

  it("rejects schema-invalid and unknown/future playlist shapes with 422 + field paths", async () => {
    const emptyObject = await call(createRoute, postCreate({}))
    expect(emptyObject.status).toBe(422)
    const emptyError = await errorOf(emptyObject)
    expect(emptyError.code).toBe("SCHEMA_INVALID")
    expect(emptyError.details).toEqual(expect.arrayContaining(["schemaVersion", "title"]))

    // A valid JSON scalar still fails the object schema with a root path.
    const nonObject = await call(createRoute, postCreate(42))
    expect(nonObject.status).toBe(422)
    expect((await errorOf(nonObject)).details).toEqual(["body"])

    const future = await call(createRoute, postCreate({ ...makePlaylist({}), schemaVersion: 2 }))
    expect(future.status).toBe(422)
    expect((await errorOf(future)).details).toEqual(expect.arrayContaining(["schemaVersion"]))

    const unknownKey = await call(createRoute, postCreate({ ...makePlaylist({}), hacker: true }))
    expect(unknownKey.status).toBe(422)

    const emptyItems = await call(createRoute, postCreate({ ...makePlaylist({}), items: [] }))
    expect(emptyItems.status).toBe(422)
    expect((await errorOf(emptyItems)).details).toEqual(expect.arrayContaining(["items"]))

    const badRange = makePlaylist({})
    const firstItem = badRange.items[0]
    const reversed = {
      ...badRange,
      items: [{ ...firstItem, range: { start: 5000, end: 1000 } }],
    }
    const rangeRes = await call(createRoute, postCreate(reversed))
    expect(rangeRes.status).toBe(422)
  })

  it("returns 404 for malformed and unknown shareIds on GET", async () => {
    const malformed = await call(getRoute, getShare("not-a-share-id"), {
      shareId: "not-a-share-id",
    })
    expect(malformed.status).toBe(404)
    const unknown = await call(getRoute, getShare("a".repeat(22)), {
      shareId: "a".repeat(22),
    })
    expect(unknown.status).toBe(404)
    expect((await errorOf(unknown)).code).toBe("NOT_FOUND")
  })

  it("enforces capability presence and shape before touching the publication", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const noAuth = await call(
      patchRoute,
      patchShare(published.shareId, null, crypto.randomUUID(), {
        operation: "replace",
        expectedRevision: 2,
        playlist: makePlaylist({}),
      }),
      { shareId: published.shareId },
    )
    expect(noAuth.status).toBe(401)

    const badShape = await call(
      patchRoute,
      patchShare(published.shareId, "too-short", crypto.randomUUID(), {
        operation: "replace",
        expectedRevision: 2,
        playlist: makePlaylist({}),
      }),
      { shareId: published.shareId },
    )
    expect(badShape.status).toBe(401)

    const noKey = await call(
      patchRoute,
      patchShare(published.shareId, published.manageSecret, null, {
        operation: "replace",
        expectedRevision: 2,
        playlist: makePlaylist({}),
      }),
      { shareId: published.shareId },
    )
    expect(noKey.status).toBe(400)
  })

  it("rejects an activate with a non-1 expectedRevision as a schema error", async () => {
    const created = await call(createRoute, postCreate(makePlaylist({})))
    const ack = CreateAckSchema.parse(await dataOf(created))
    const res = await call(
      patchRoute,
      patchShare(ack.shareId, ack.manageSecret, crypto.randomUUID(), {
        operation: "activate",
        expectedRevision: 2,
      }),
      { shareId: ack.shareId },
    )
    expect(res.status).toBe(422)
    expect((await errorOf(res)).code).toBe("SCHEMA_INVALID")
  })

  it("rejects unknown-operation PATCH bodies and malformed DELETE bodies", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const badOperation = await call(
      patchRoute,
      patchShare(published.shareId, published.manageSecret, crypto.randomUUID(), {
        operation: "merge",
        expectedRevision: 2,
      }),
      { shareId: published.shareId },
    )
    expect(badOperation.status).toBe(422)

    const noBody = await call(
      deleteRoute,
      apiRequest({
        method: "DELETE",
        path: `/${published.shareId}`,
        bearer: published.manageSecret,
        idempotencyKey: crypto.randomUUID(),
        contentType: "application/json",
      }),
      { shareId: published.shareId },
    )
    expect(noBody.status).toBe(400)

    const wrongShape = await call(
      deleteRoute,
      apiRequest({
        method: "DELETE",
        path: `/${published.shareId}`,
        body: { somethingElse: true },
        bearer: published.manageSecret,
        idempotencyKey: crypto.randomUUID(),
      }),
      { shareId: published.shareId },
    )
    expect(wrongShape.status).toBe(422)
  })

  it("validates the import notification body but never leaks existence", async () => {
    const badEvent = await call(importRoute, importNotify("a".repeat(22), "not-a-uuid"), {
      shareId: "a".repeat(22),
    })
    expect(badEvent.status).toBe(422)
    expect((await errorOf(badEvent)).details).toEqual(expect.arrayContaining(["eventId"]))

    const wrongType = await call(
      importRoute,
      apiRequest({
        method: "POST",
        path: "/x/import",
        body: { eventId: crypto.randomUUID() },
        contentType: "text/csv",
      }),
      { shareId: "x" },
    )
    expect(wrongType.status).toBe(415)
  })
})
