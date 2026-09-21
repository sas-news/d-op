import { beforeAll, describe, expect, it } from "vitest"
import {
  CreateAckSchema,
  contentHashOf,
  GetPlaylistResponseSchema,
  PatchAckSchema,
} from "../../../../packages/shared/src/index"
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "../../src/pages/api/v1/playlists/[shareId].js"
import { POST as createRoute } from "../../src/pages/api/v1/playlists/index.js"
import { manageSecretHash } from "../../src/server/security/capability.js"
import {
  activateShare,
  call,
  dataOf,
  db,
  deleteShare,
  errorOf,
  getShare,
  makePlaylist,
  migratedDb,
  patchShare,
  postCreate,
} from "./helpers.js"

// Full publication lifecycle through the real route handlers on real D1:
// POST -> client persists key -> activate -> GET -> replace -> DELETE.

const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/

describe("publication lifecycle", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("POST creates a pending snapshot and returns the manage secret exactly once", async () => {
    const playlist = makePlaylist({})
    const res = await call(createRoute, postCreate(playlist))
    expect(res.status).toBe(201)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const ack = CreateAckSchema.parse(await dataOf(res))
    expect(ack.shareId).toMatch(SHARE_ID_PATTERN)
    expect(ack.manageSecret).toMatch(SECRET_PATTERN)
    expect(ack.revision).toBe(1)
    expect(ack.state).toBe("pending")
    expect(ack.contentHash).toBe(await contentHashOf(playlist))
    const created = Date.parse(ack.createdAt)
    const expires = Date.parse(ack.activationExpiresAt)
    expect(expires - created).toBe(3_600_000)
    // The database stores the domain-separated hash, never the plaintext.
    const row = await db()
      .prepare("SELECT secret_hash, state FROM playlists WHERE share_id = ?1")
      .bind(ack.shareId)
      .first<{ secret_hash: string; state: string }>()
    expect(row?.state).toBe("pending")
    expect(row?.secret_hash).toBe(await manageSecretHash(ack.shareId, ack.manageSecret))
    expect(row?.secret_hash).not.toBe(ack.manageSecret)
  })

  it("keeps a pending snapshot invisible until activate, then serves GET", async () => {
    const playlist = makePlaylist({ title: "Pendingタイトル" })
    const created = await call(createRoute, postCreate(playlist))
    const ack = CreateAckSchema.parse(await dataOf(created))
    const pendingGet = await call(getRoute, getShare(ack.shareId), { shareId: ack.shareId })
    expect(pendingGet.status).toBe(404)

    const activated = await call(patchRoute, activateShare(ack.shareId, ack.manageSecret), {
      shareId: ack.shareId,
    })
    expect(activated.status).toBe(200)
    const patchAck = PatchAckSchema.parse(await dataOf(activated))
    expect(patchAck.revision).toBe(2)
    expect(patchAck.contentHash).toBe(ack.contentHash)

    const got = await call(getRoute, getShare(ack.shareId), { shareId: ack.shareId })
    expect(got.status).toBe(200)
    const body = GetPlaylistResponseSchema.parse(await dataOf(got))
    expect(body.revision).toBe(2)
    expect(body.playlist.title).toBe("Pendingタイトル")
    expect(body.itemCount).toBe(2)
    expect(body.totalDurationMs).toBe(180000)
    expect(body.importCount).toBe(0)
    expect(body.source).toBeNull()
    expect(body.publishedAt).toBe(patchAck.publishedAt)
  })

  it("replaces the snapshot fully at revision+1 and deletes it conditionally", async () => {
    const playlist = makePlaylist({ title: "v2-title" })
    const created = await call(createRoute, postCreate(playlist))
    const ack = CreateAckSchema.parse(await dataOf(created))
    await call(patchRoute, activateShare(ack.shareId, ack.manageSecret), {
      shareId: ack.shareId,
    })
    const replacement = makePlaylist({ title: "v3-title", itemCount: 3 })
    const replaced = await call(
      patchRoute,
      patchShare(ack.shareId, ack.manageSecret, crypto.randomUUID(), {
        operation: "replace",
        expectedRevision: 2,
        playlist: replacement,
      }),
      { shareId: ack.shareId },
    )
    expect(replaced.status).toBe(200)
    const repAck = PatchAckSchema.parse(await dataOf(replaced))
    expect(repAck.revision).toBe(3)
    expect(repAck.contentHash).toBe(await contentHashOf(replacement))

    const got = await call(getRoute, getShare(ack.shareId), { shareId: ack.shareId })
    const body = GetPlaylistResponseSchema.parse(await dataOf(got))
    expect(body.playlist.title).toBe("v3-title")
    expect(body.itemCount).toBe(3)
    expect(body.revision).toBe(3)

    const deleted = await call(
      deleteRoute,
      deleteShare(ack.shareId, ack.manageSecret, crypto.randomUUID(), 3),
      { shareId: ack.shareId },
    )
    expect(deleted.status).toBe(204)
    const afterDelete = await call(getRoute, getShare(ack.shareId), { shareId: ack.shareId })
    expect(afterDelete.status).toBe(404)
    const row = await db()
      .prepare("SELECT share_id FROM playlists WHERE share_id = ?1")
      .bind(ack.shareId)
      .first()
    expect(row).toBeNull()
  })

  it("rejects a wrong capability with 401 and a stale revision with 409 + current revision", async () => {
    const playlist = makePlaylist({})
    const created = await call(createRoute, postCreate(playlist))
    const ack = CreateAckSchema.parse(await dataOf(created))

    const wrongSecret = `${"a".repeat(42)}b`
    const denied = await call(patchRoute, activateShare(ack.shareId, wrongSecret), {
      shareId: ack.shareId,
    })
    expect(denied.status).toBe(401)
    expect((await errorOf(denied)).code).toBe("UNAUTHORIZED")

    await call(patchRoute, activateShare(ack.shareId, ack.manageSecret), {
      shareId: ack.shareId,
    })
    const stale = await call(
      patchRoute,
      patchShare(ack.shareId, ack.manageSecret, crypto.randomUUID(), {
        operation: "replace",
        expectedRevision: 9,
        playlist,
      }),
      { shareId: ack.shareId },
    )
    expect(stale.status).toBe(409)
    const staleError = await errorOf(stale)
    expect(staleError.code).toBe("REVISION_CONFLICT")
    expect((staleError.details as { revision: number }).revision).toBe(2)
  })
})
