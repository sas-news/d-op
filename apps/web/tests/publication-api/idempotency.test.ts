import { beforeAll, describe, expect, it } from "vitest"
import { CreateAckSchema, PatchAckSchema } from "../../../../packages/shared/src/index"
import {
  DELETE as deleteRoute,
  PATCH as patchRoute,
} from "../../src/pages/api/v1/playlists/[shareId].js"
import { POST as createRoute } from "../../src/pages/api/v1/playlists/index.js"
import {
  activateShare,
  call,
  dataOf,
  db,
  deleteShare,
  envelopeOf,
  errorOf,
  makePlaylist,
  migratedDb,
  patchShare,
  postCreate,
} from "./helpers.js"

// Mutation idempotency: receipts bind method + resource + authenticated secret
// hash + request hash + operation key for 24 h. Same key + same request
// replays the recorded ack; same key + different request is a conflict; a
// create replay can never recover the lost secret.

describe("mutation idempotency receipts", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("replays an identical PATCH activate with the original ack, without re-writing", async () => {
    const playlist = makePlaylist({})
    const created = await call(createRoute, postCreate(playlist))
    const ack = CreateAckSchema.parse(await dataOf(created))
    const key = crypto.randomUUID()
    const first = await call(patchRoute, activateShare(ack.shareId, ack.manageSecret, key), {
      shareId: ack.shareId,
    })
    const replay = await call(patchRoute, activateShare(ack.shareId, ack.manageSecret, key), {
      shareId: ack.shareId,
    })
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    const firstAck = PatchAckSchema.parse(await dataOf(first))
    const replayAck = PatchAckSchema.parse(await dataOf(replay))
    expect(replayAck).toEqual(firstAck)
    // A replay must not bump the revision again.
    const row = await db()
      .prepare("SELECT revision FROM playlists WHERE share_id = ?1")
      .bind(ack.shareId)
      .first<{ revision: number }>()
    expect(row?.revision).toBe(2)
  })

  it("returns 204 on an authenticated DELETE replay", async () => {
    const playlist = makePlaylist({})
    const created = await call(createRoute, postCreate(playlist))
    const ack = CreateAckSchema.parse(await dataOf(created))
    const key = crypto.randomUUID()
    const first = await call(deleteRoute, deleteShare(ack.shareId, ack.manageSecret, key, 1), {
      shareId: ack.shareId,
    })
    expect(first.status).toBe(204)
    const replay = await call(deleteRoute, deleteShare(ack.shareId, ack.manageSecret, key, 1), {
      shareId: ack.shareId,
    })
    expect(replay.status).toBe(204)
  })

  it("returns 409 IDEMPOTENCY_CONFLICT when the same key carries a different request", async () => {
    const playlist = makePlaylist({})
    const created = await call(createRoute, postCreate(playlist))
    const ack = CreateAckSchema.parse(await dataOf(created))
    await call(patchRoute, activateShare(ack.shareId, ack.manageSecret), {
      shareId: ack.shareId,
    })
    const key = crypto.randomUUID()
    const first = await call(
      patchRoute,
      patchShare(ack.shareId, ack.manageSecret, key, {
        operation: "replace",
        expectedRevision: 2,
        playlist: makePlaylist({ title: "first-replace" }),
      }),
      { shareId: ack.shareId },
    )
    expect(first.status).toBe(200)
    const conflict = await call(
      patchRoute,
      patchShare(ack.shareId, ack.manageSecret, key, {
        operation: "replace",
        expectedRevision: 2,
        playlist: makePlaylist({ title: "different-body" }),
      }),
      { shareId: ack.shareId },
    )
    expect(conflict.status).toBe(409)
    expect((await errorOf(conflict)).code).toBe("IDEMPOTENCY_CONFLICT")
  })

  it("returns 409 CREATE_RECEIPT_UNAVAILABLE on a POST replay and never re-emits the secret", async () => {
    const playlist = makePlaylist({})
    const key = crypto.randomUUID()
    const first = await call(createRoute, postCreate(playlist, key))
    expect(first.status).toBe(201)
    const ack = CreateAckSchema.parse(await dataOf(first))

    const replay = await call(createRoute, postCreate(playlist, key))
    expect(replay.status).toBe(409)
    const replayBody = await envelopeOf(replay)
    expect(replayBody.error?.code).toBe("CREATE_RECEIPT_UNAVAILABLE")
    // No substitute secret and no data payload may come back from a replay.
    expect(replayBody.data).toBeUndefined()
    expect(JSON.stringify(replayBody)).not.toContain(ack.manageSecret)

    // The same key with a different body is an idempotency conflict instead.
    const changed = await call(createRoute, postCreate(makePlaylist({ title: "other" }), key))
    expect(changed.status).toBe(409)
    expect((await errorOf(changed)).code).toBe("IDEMPOTENCY_CONFLICT")
  })

  it("returns 200 current-state on a repeat activate while the publication is unchanged", async () => {
    const playlist = makePlaylist({})
    const created = await call(createRoute, postCreate(playlist))
    const ack = CreateAckSchema.parse(await dataOf(created))
    const first = await call(patchRoute, activateShare(ack.shareId, ack.manageSecret), {
      shareId: ack.shareId,
    })
    expect(first.status).toBe(200)
    // A fresh-key activate on the already-active, unreplaced publication is an
    // idempotent repeat: the contract returns the current state, not a conflict.
    const repeat = await call(patchRoute, activateShare(ack.shareId, ack.manageSecret), {
      shareId: ack.shareId,
    })
    expect(repeat.status).toBe(200)
    const repeatAck = PatchAckSchema.parse(await dataOf(repeat))
    expect(repeatAck.revision).toBe(2)

    // Once the snapshot was replaced, the same activate is a real conflict.
    await call(
      patchRoute,
      patchShare(ack.shareId, ack.manageSecret, crypto.randomUUID(), {
        operation: "replace",
        expectedRevision: 2,
        playlist: makePlaylist({ title: "replaced" }),
      }),
      { shareId: ack.shareId },
    )
    const staleActivate = await call(patchRoute, activateShare(ack.shareId, ack.manageSecret), {
      shareId: ack.shareId,
    })
    expect(staleActivate.status).toBe(409)
    const error = await errorOf(staleActivate)
    expect(error.code).toBe("REVISION_CONFLICT")
    expect((error.details as { revision: number }).revision).toBe(3)
  })
})
