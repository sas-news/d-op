import { beforeAll, describe, expect, it } from "vitest"
import { CreateAckSchema } from "../../../../packages/shared/src/index"
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "../../src/pages/api/v1/playlists/[shareId].js"
import { POST as createRoute } from "../../src/pages/api/v1/playlists/index.js"
import { sha256Hex } from "../../src/server/repositories/hashing.js"
import { manageSecretHash } from "../../src/server/security/capability.js"
import {
  apiRequest,
  call,
  dataOf,
  db,
  deleteShare,
  envelopeOf,
  getShare,
  makePlaylist,
  migratedDb,
  postCreate,
  publishPlaylist,
} from "./helpers.js"

// Capability storage proof: DB inspection must find only the domain-separated
// SHA-256 hash — never the plaintext secret — in every table and receipt.

describe("capability secret storage", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("stores only the domain-separated secret hash in playlists and receipts", async () => {
    const playlist = makePlaylist({})
    const created = await call(createRoute, postCreate(playlist))
    const ack = CreateAckSchema.parse(await dataOf(created))

    const row = await db()
      .prepare("SELECT secret_hash, snapshot_json FROM playlists WHERE share_id = ?1")
      .bind(ack.shareId)
      .first<{ secret_hash: string; snapshot_json: string }>()
    const expected = await manageSecretHash(ack.shareId, ack.manageSecret)
    expect(row?.secret_hash).toBe(expected)
    expect(row?.secret_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.secret_hash).not.toBe(ack.manageSecret)
    // Domain separation: the bare hash of the secret is NOT what is stored.
    expect(row?.secret_hash).not.toBe(await sha256Hex(ack.manageSecret))
    expect(row?.snapshot_json).not.toContain(ack.manageSecret)

    const receipts = await db()
      .prepare(
        "SELECT secret_hash, request_hash, outcome_json FROM publication_operations WHERE share_id = ?1",
      )
      .bind(ack.shareId)
      .all<{ secret_hash: string; request_hash: string; outcome_json: string | null }>()
    expect(receipts.results.length).toBeGreaterThanOrEqual(1)
    for (const receipt of receipts.results) {
      expect(receipt.secret_hash).toBe(expected)
      expect(receipt.request_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(receipt.outcome_json ?? "").not.toContain(ack.manageSecret)
    }
  })

  it("never returns the secret from GET, PATCH replays or DELETE", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const key = crypto.randomUUID()
    await call(
      patchRoute,
      apiRequest({
        method: "PATCH",
        path: `/${published.shareId}`,
        body: {
          operation: "replace",
          expectedRevision: 2,
          playlist: makePlaylist({ title: "r2" }),
        },
        bearer: published.manageSecret,
        idempotencyKey: key,
      }),
      { shareId: published.shareId },
    )
    const replay = await call(
      patchRoute,
      apiRequest({
        method: "PATCH",
        path: `/${published.shareId}`,
        body: {
          operation: "replace",
          expectedRevision: 2,
          playlist: makePlaylist({ title: "r2" }),
        },
        bearer: published.manageSecret,
        idempotencyKey: key,
      }),
      { shareId: published.shareId },
    )
    expect(replay.status).toBe(200)
    expect(JSON.stringify(await envelopeOf(replay))).not.toContain(published.manageSecret)

    const got = await call(getRoute, getShare(published.shareId), {
      shareId: published.shareId,
    })
    expect(JSON.stringify(await envelopeOf(got))).not.toContain(published.manageSecret)

    const del = await call(
      deleteRoute,
      deleteShare(published.shareId, published.manageSecret, crypto.randomUUID(), 3),
      { shareId: published.shareId },
    )
    expect(del.status).toBe(204)
    expect(await del.text()).toBe("")
  })
})
