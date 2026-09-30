import { beforeAll, describe, expect, it } from "vitest"
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
  errorOf,
  getViaRoute,
  importViaRoute,
  makePlaylist,
  migratedDb,
  patchShare,
  postCreate,
  publishPlaylist,
} from "./helpers.js"

// Task-27 adversarial: concurrency + receipt replay against the real D1.
// The QA matrix requires: simultaneous same-revision updates acknowledge
// exactly one writer; duplicate import notifications count once; replayed
// idempotency keys never produce a second effect. Every assertion below
// checks the ACTUAL D1 rows (revision, counters, receipts, write_asserts)
// so a passing test proves real storage behavior, not just response codes.

type PlaylistRow = {
  readonly revision: number
  readonly state: string
  readonly import_count: number
  readonly first_published_at: string | null
  readonly snapshot_json: string
}

type OperationRow = {
  readonly method: string
  readonly status: string
  readonly new_revision: number | null
}

async function playlistRow(shareId: string): Promise<PlaylistRow | null> {
  return db()
    .prepare("SELECT * FROM playlists WHERE share_id = ?1")
    .bind(shareId)
    .first<PlaylistRow>()
}

async function opsFor(shareId: string): Promise<OperationRow[]> {
  const res = await db()
    .prepare(
      `SELECT method, status, new_revision FROM publication_operations
       WHERE share_id = ?1 ORDER BY created_at`,
    )
    .bind(shareId)
    .all<OperationRow>()
  return res.results
}

async function writeAssertCount(): Promise<number> {
  const row = await db().prepare("SELECT COUNT(*) AS n FROM write_asserts").first<{ n: number }>()
  return row?.n ?? -1
}

describe("concurrent mutations and duplicate effects", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("two owners racing the same revision: exactly one update lands", async () => {
    const pub = await publishPlaylist(makePlaylist({ title: "race-base" }))
    // Both "owners" hold the same capability and read revision 2; only one
    // may commit. Distinct idempotency keys => both are genuine attempts.
    const [a, b] = await Promise.all([
      call(
        patchRoute,
        patchShare(pub.shareId, pub.manageSecret, crypto.randomUUID(), {
          operation: "replace",
          expectedRevision: 2,
          playlist: makePlaylist({ title: "race-winner-A" }),
        }),
        { shareId: pub.shareId },
      ),
      call(
        patchRoute,
        patchShare(pub.shareId, pub.manageSecret, crypto.randomUUID(), {
          operation: "replace",
          expectedRevision: 2,
          playlist: makePlaylist({ title: "race-winner-B" }),
        }),
        { shareId: pub.shareId },
      ),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 409])
    const loser = a.status === 409 ? a : b
    expect((await errorOf(loser)).code).toBe("REVISION_CONFLICT")

    // D1 truth: exactly one revision move (2 -> 3), snapshot is the winner's.
    const row = await playlistRow(pub.shareId)
    expect(row?.revision).toBe(3)
    const snapshot = JSON.parse(String(row?.snapshot_json)) as { title: string }
    const winnerTitle = a.status === 200 ? "race-winner-A" : "race-winner-B"
    expect(snapshot.title).toBe(winnerTitle)

    // Exactly one completed replace receipt; the loser left no mutation.
    const ops = await opsFor(pub.shareId)
    const replaces = ops.filter((op) => op.method === "replace")
    expect(replaces).toHaveLength(1)
    expect(replaces[0]?.status).toBe("completed")
    expect(replaces[0]?.new_revision).toBe(3)
    expect(await writeAssertCount()).toBe(0)
  })

  it("concurrent activate on one provisional: one transition, honest acks", async () => {
    const created = await call(createRoute, postCreate(makePlaylist({})))
    expect(created.status).toBe(201)
    const ack = (await dataOf(created)) as { shareId: string; manageSecret: string }
    const [a, b] = await Promise.all([
      call(patchRoute, activateShare(ack.shareId, ack.manageSecret), { shareId: ack.shareId }),
      call(patchRoute, activateShare(ack.shareId, ack.manageSecret), { shareId: ack.shareId }),
    ])
    // Both callers must see a truthful outcome: either their own transition
    // ack or the contract's idempotent repeat-activate ack — never a state
    // that says they own something they did not write. What is forbidden is
    // a 5xx or a phantom second activation.
    expect([a.status, b.status]).toEqual([200, 200])
    const row = await playlistRow(ack.shareId)
    expect(row?.state).toBe("active")
    expect(row?.revision).toBe(2) // pending(1) -> active(2) exactly once
    expect(row?.first_published_at).not.toBeNull()
    expect(await writeAssertCount()).toBe(0)
  })

  it("concurrent delete: one 204, loser sees an honest conflict", async () => {
    const pub = await publishPlaylist(makePlaylist({}))
    const [a, b] = await Promise.all([
      call(deleteRoute, deleteShare(pub.shareId, pub.manageSecret, crypto.randomUUID(), 2), {
        shareId: pub.shareId,
      }),
      call(deleteRoute, deleteShare(pub.shareId, pub.manageSecret, crypto.randomUUID(), 2), {
        shareId: pub.shareId,
      }),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses[0]).toBe(204)
    // The loser gets a bounded conflict — and the row is gone either way.
    expect([404, 409]).toContain(statuses[1])
    expect(await playlistRow(pub.shareId)).toBeNull()
    expect(await writeAssertCount()).toBe(0)
  })

  it("duplicate import notification (same eventId) counts exactly once", async () => {
    const pub = await publishPlaylist(makePlaylist({}))
    const eventId = crypto.randomUUID()
    // Sequential replay then a concurrent burst — all through the real route.
    expect((await importViaRoute(pub.shareId, eventId)).status).toBe(204)
    expect((await importViaRoute(pub.shareId, eventId)).status).toBe(204)
    const burst = await Promise.all(
      Array.from({ length: 4 }, () => importViaRoute(pub.shareId, eventId)),
    )
    for (const res of burst) expect(res.status).toBe(204)

    const row = await playlistRow(pub.shareId)
    expect(row?.import_count).toBe(1)
    const daily = await db()
      .prepare("SELECT SUM(count) AS total FROM import_daily WHERE share_id = ?1")
      .bind(pub.shareId)
      .first<{ total: number }>()
    expect(daily?.total).toBe(1)
    const receipts = await db()
      .prepare("SELECT COUNT(*) AS n FROM import_receipts WHERE share_id = ?1")
      .bind(pub.shareId)
      .first<{ n: number }>()
    // Two rows: the per-actor dedup receipt plus the per-event receipt.
    expect(receipts?.n).toBe(2)
    // Public GET reflects exactly one count — no phantom popularity.
    const getRes = await getViaRoute(pub.shareId)
    const data = (await dataOf(getRes)) as { importCount: number }
    expect(data.importCount).toBe(1)
  })

  it("distinct eventIds from distinct actors each count; same-actor regeneration does not", async () => {
    const pub = await publishPlaylist(makePlaylist({}))
    // One count per actor per share — three counts need three actors.
    for (let i = 0; i < 3; i += 1) {
      const res = await importViaRoute(pub.shareId, crypto.randomUUID(), `198.51.100.${i + 1}`)
      expect(res.status).toBe(204)
    }
    // Fresh event ids from an already-counted actor add nothing.
    expect((await importViaRoute(pub.shareId, crypto.randomUUID(), "198.51.100.1")).status).toBe(
      204,
    )
    expect((await playlistRow(pub.shareId))?.import_count).toBe(3)
    // Hostile/invalid event ids: bounded rejection, no counter movement.
    for (const bad of ["", "x".repeat(300), 42, null, { evil: true }]) {
      const res = await importViaRoute(pub.shareId, bad)
      expect([400, 422]).toContain(res.status)
    }
    expect((await playlistRow(pub.shareId))?.import_count).toBe(3)
  })

  it("replayed create idempotency key: receipt unavailable, never a second shareId", async () => {
    const key = crypto.randomUUID()
    const playlist = makePlaylist({ title: "receipt-replay" })
    const first = await call(createRoute, postCreate(playlist, key))
    expect(first.status).toBe(201)
    const ack = (await dataOf(first)) as { shareId: string; manageSecret: string }

    // Same key + same body: the plaintext secret can never be re-emitted.
    const replay = await call(createRoute, postCreate(playlist, key))
    expect(replay.status).toBe(409)
    const replayError = await errorOf(replay)
    expect(replayError.code).toBe("CREATE_RECEIPT_UNAVAILABLE")
    const replayJson = JSON.stringify(replayError)
    expect(replayJson).not.toContain(ack.manageSecret)
    expect(replayJson).not.toContain(ack.shareId)

    // Same key + different body: idempotency conflict, still no new row.
    const mismatched = await call(
      createRoute,
      postCreate(makePlaylist({ title: "receipt-different" }), key),
    )
    expect(mismatched.status).toBe(409)
    expect((await errorOf(mismatched)).code).toBe("IDEMPOTENCY_CONFLICT")

    // Exactly ONE playlists row for this operation; no orphan snapshot.
    const rows = await db()
      .prepare("SELECT COUNT(*) AS n FROM playlists WHERE share_id = ?1")
      .bind(ack.shareId)
      .first<{ n: number }>()
    expect(rows?.n).toBe(1)
    const allRows = await db().prepare("SELECT COUNT(*) AS n FROM playlists").first<{ n: number }>()
    // Fresh key publishes a genuinely new publication — dedupe is per-key,
    // not a content blocklist.
    const fresh = await call(createRoute, postCreate(playlist, crypto.randomUUID()))
    expect(fresh.status).toBe(201)
    const freshAck = (await dataOf(fresh)) as { shareId: string }
    expect(freshAck.shareId).not.toBe(ack.shareId)
    const afterRows = await db()
      .prepare("SELECT COUNT(*) AS n FROM playlists")
      .first<{ n: number }>()
    expect((afterRows?.n ?? 0) - (allRows?.n ?? 0)).toBe(1)
  })

  it("replayed PATCH idempotency key returns the recorded ack with no second effect", async () => {
    const pub = await publishPlaylist(makePlaylist({ title: "idem-base" }))
    const key = crypto.randomUUID()
    const body = {
      operation: "replace",
      expectedRevision: 2,
      playlist: makePlaylist({ title: "idem-once" }),
    }
    const first = await call(patchRoute, patchShare(pub.shareId, pub.manageSecret, key, body), {
      shareId: pub.shareId,
    })
    expect(first.status).toBe(200)
    const firstAck = (await dataOf(first)) as { revision: number; contentHash: string }

    // Byte-identical replay: same ack, revision does not move again.
    const replay = await call(patchRoute, patchShare(pub.shareId, pub.manageSecret, key, body), {
      shareId: pub.shareId,
    })
    expect(replay.status).toBe(200)
    const replayAck = (await dataOf(replay)) as { revision: number; contentHash: string }
    expect(replayAck).toEqual(firstAck)
    expect((await playlistRow(pub.shareId))?.revision).toBe(3)

    // Same key + different payload: honest conflict, still no movement.
    const drift = await call(
      patchRoute,
      patchShare(pub.shareId, pub.manageSecret, key, {
        operation: "replace",
        expectedRevision: 3,
        playlist: makePlaylist({ title: "idem-drift" }),
      }),
      { shareId: pub.shareId },
    )
    expect(drift.status).toBe(409)
    expect((await errorOf(drift)).code).toBe("IDEMPOTENCY_CONFLICT")
    expect((await playlistRow(pub.shareId))?.revision).toBe(3)
    expect(await writeAssertCount()).toBe(0)
  })
})
