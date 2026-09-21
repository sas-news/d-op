import { beforeAll, describe, expect, it } from "vitest"
import { SnapshotRepositoryError } from "../../src/server/repositories/errors.js"
import {
  type GuardedMutationPlan,
  pendingOpBinds,
  pendingOpGate,
  readOperationRow,
  runGuardedMutation,
} from "../../src/server/repositories/guard.js"
import { deleteSnapshot } from "../../src/server/repositories/snapshots/delete.js"
import { parsePatchOutcome } from "../../src/server/repositories/snapshots/outcomes.js"
import { getSnapshot, listTagLinks } from "../../src/server/repositories/snapshots/read.js"
import { replaceSnapshot } from "../../src/server/repositories/snapshots/replace.js"
import {
  db,
  hashOf,
  makeActive,
  makePlaylist,
  migratedDb,
  newOperationKey,
  newSecretHash,
  newShareId,
} from "./helpers.js"

// Atomicity proofs on real D1: concurrent CAS losers leave no trace, and a
// mid-batch failure or fired assertion rolls back the whole guarded batch.

const NOW = new Date("2026-03-01T12:00:00.000Z")

describe("guarded mutation concurrency and rollback", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("lets exactly one of two concurrent same-revision replaces win cleanly", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    await makeActive(shareId, secretHash, NOW)
    const winner = makePlaylist({ title: "勝者", tags: ["winner-tag"], itemPrefix: "w" })
    const loser = makePlaylist({ title: "敗者", tags: ["loser-tag"], itemPrefix: "l" })
    const [a, b] = await Promise.all([
      replaceSnapshot(db(), {
        shareId,
        secretHash,
        operationKey: newOperationKey(),
        expectedRevision: 2,
        playlist: winner,
        contentHash: await hashOf(winner),
        now: NOW,
      }),
      replaceSnapshot(db(), {
        shareId,
        secretHash,
        operationKey: newOperationKey(),
        expectedRevision: 2,
        playlist: loser,
        contentHash: await hashOf(loser),
        now: NOW,
      }),
    ])
    const kinds = [a.kind, b.kind].sort()
    expect(kinds).toEqual(["applied", "conflict"])
    const loserResult = a.kind === "conflict" ? a : b
    if (loserResult.kind !== "conflict") throw new Error("expected a losing conflict")
    expect(loserResult.code).toBe("REVISION_CONFLICT")
    // The loser left nothing behind: exactly one winning snapshot state, one
    // tag set, and no receipt row for the loser's key.
    const stored = await getSnapshot(db(), shareId)
    expect(stored?.revision).toBe(3)
    const winnerTitle = a.kind === "applied" ? "勝者" : "敗者"
    const winnerTag = a.kind === "applied" ? "winner-tag" : "loser-tag"
    expect(stored?.snapshot.title).toBe(winnerTitle)
    expect(await listTagLinks(db(), shareId)).toEqual([winnerTag])
    const receiptCount = await db()
      .prepare(
        "SELECT count(*) AS n FROM publication_operations WHERE share_id = ?1 AND method = 'replace'",
      )
      .bind(shareId)
      .first<{ n: number }>()
    expect(receiptCount?.n).toBe(1)
    expect(stored?.importCount).toBe(0)
  })

  it("rolls back the whole batch when a mid-batch statement fails", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    await makeActive(shareId, secretHash, NOW)
    const opKey = newOperationKey()
    const plan: GuardedMutationPlan = {
      operationKey: opKey,
      shareId,
      method: "replace",
      requestHash: "c".repeat(64),
      secretHash,
      expectedRevision: 2,
      newRevision: 3,
      requiredState: "active",
      checkActivationExpiry: false,
      now: NOW.toISOString(),
    }
    const database = db()
    const failing = await runGuardedMutation(
      database,
      plan,
      (nonce) => [
        // Same guarded shape as production: pending op insert gated on the
        // resource predicates, a dependent write gated on the pending row, then
        // a statement that violates NOT NULL and must roll everything back.
        database
          .prepare(
            `INSERT INTO publication_operations
             (operation_key, share_id, method, request_hash, secret_hash, attempt_nonce,
              status, expected_revision, new_revision, created_at, expires_at)
           SELECT ?1, ?2, 'replace', ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9
           WHERE EXISTS (SELECT 1 FROM playlists
                         WHERE share_id = ?2 AND secret_hash = ?4 AND revision = ?6
                           AND state = 'active')
             AND NOT EXISTS (SELECT 1 FROM publication_operations WHERE operation_key = ?1)`,
          )
          .bind(opKey, shareId, plan.requestHash, secretHash, nonce, 2, 3, plan.now, plan.now),
        database
          .prepare(
            `UPDATE playlists SET title = 'corrupt' WHERE share_id = ?1 AND ${pendingOpGate(2)}`,
          )
          .bind(shareId, ...pendingOpBinds(plan, nonce)),
        database.prepare(
          // revision = 0 violates CHECK (revision >= 1): a real constraint
          // failure mid-batch must roll back the guard insert as well.
          `INSERT INTO playlists (
             share_id, revision, state, secret_hash, snapshot_json, content_hash,
             title, description, author, search_text, visibility, tags_json,
             item_count, total_duration_ms, created_at, updated_at)
           VALUES ('injected_failure_row', 0, 'active',
             'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
             '{}', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
             't', 'd', 'a', 's', 'public', '[]', 1, 0, 'x', 'x')`,
        ),
      ],
      parsePatchOutcome,
    ).catch((error: unknown) => error)
    expect(failing).toBeInstanceOf(SnapshotRepositoryError)
    expect((failing as SnapshotRepositoryError).code).toBe("TRANSIENT_FAILURE")
    // Guard insert rolled back too: no receipt, no title change, no new revision.
    expect(await readOperationRow(db(), opKey)).toBeNull()
    const stored = await getSnapshot(db(), shareId)
    expect(stored?.revision).toBe(2)
    expect(stored?.snapshot.title).toBe("共有リスト")
  })

  it("aborts via the write assertion when the pending op exists but the parent cannot move", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    await makeActive(shareId, secretHash, NOW)
    const opKey = newOperationKey()
    const plan: GuardedMutationPlan = {
      operationKey: opKey,
      shareId,
      method: "replace",
      requestHash: "d".repeat(64),
      secretHash,
      expectedRevision: 2,
      newRevision: 3,
      requiredState: "active",
      checkActivationExpiry: false,
      now: NOW.toISOString(),
    }
    const database = db()
    const result = await runGuardedMutation(
      database,
      plan,
      (nonce) => [
        database
          .prepare(
            `INSERT INTO publication_operations
             (operation_key, share_id, method, request_hash, secret_hash, attempt_nonce,
              status, expected_revision, new_revision, created_at, expires_at)
           SELECT ?1, ?2, 'replace', ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9
           WHERE EXISTS (SELECT 1 FROM playlists
                         WHERE share_id = ?2 AND secret_hash = ?4 AND revision = ?6
                           AND state = 'active')
             AND NOT EXISTS (SELECT 1 FROM publication_operations WHERE operation_key = ?1)`,
          )
          .bind(opKey, shareId, plan.requestHash, secretHash, nonce, 2, 3, plan.now, plan.now),
        // Dependent write gated on a FOREIGN nonce: cannot proceed even though
        // the guard inserted a pending row for this attempt.
        database
          .prepare(
            `UPDATE playlists SET title = 'should-never-land' WHERE share_id = ?1
             AND EXISTS (SELECT 1 FROM publication_operations po
                         WHERE po.operation_key = ?2 AND po.attempt_nonce = ?3
                           AND po.status = 'pending')`,
          )
          .bind(shareId, opKey, "a-different-nonce"),
        // The real assert: pending op exists but parent never reached rev 3.
        database
          .prepare(
            `INSERT INTO write_asserts (name)
           SELECT 'replace-parent'
           WHERE EXISTS (SELECT 1 FROM publication_operations po
                         WHERE po.operation_key = ?1 AND po.attempt_nonce = ?2
                           AND po.status = 'pending')
             AND NOT EXISTS (SELECT 1 FROM playlists p
                             WHERE p.share_id = ?3 AND p.revision = ?4)`,
          )
          .bind(opKey, nonce, shareId, 3),
      ],
      parsePatchOutcome,
    ).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(SnapshotRepositoryError)
    expect((result as SnapshotRepositoryError).code).toBe("ASSERTION_FAILED")
    // Everything rolled back, including the guard row.
    expect(await readOperationRow(db(), opKey)).toBeNull()
    expect((await getSnapshot(db(), shareId))?.revision).toBe(2)
    const asserts = await db()
      .prepare("SELECT count(*) AS n FROM write_asserts")
      .first<{ n: number }>()
    expect(asserts?.n).toBe(0)
  })

  it("rejects a double delete: replay gets the receipt, a fresh key sees NOT_FOUND", async () => {
    const shareId = newShareId()
    const secretHash = await newSecretHash(shareId)
    await makeActive(shareId, secretHash, NOW)
    const opKey = newOperationKey()
    const first = await deleteSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: opKey,
      expectedRevision: 2,
      now: NOW,
    })
    expect(first.kind).toBe("applied")
    const replay = await deleteSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: opKey,
      expectedRevision: 2,
      now: NOW,
    })
    expect(replay.kind).toBe("replayed")
    const fresh = await deleteSnapshot(db(), {
      shareId,
      secretHash,
      operationKey: newOperationKey(),
      expectedRevision: 2,
      now: NOW,
    })
    expect(fresh).toEqual({ kind: "conflict", code: "NOT_FOUND" })
  })
})
