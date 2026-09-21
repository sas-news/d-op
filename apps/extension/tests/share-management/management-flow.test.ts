// Publication management state-machine tests (task 15), run against a fake
// Share API implementing the real contract. Asserted invariants:
//  - durable pendingCreate precedes the POST; the manageSecret is persisted
//    to the vault BEFORE activate is sent
//  - a lost activate response is retryable (record + key survive; a repeat
//    activate PATCH completes the publish)
//  - a lost create response replays as CREATE_RECEIPT_UNAVAILABLE under the
//    SAME Idempotency-Key — the attempt is abandoned, never double-created
//  - PATCH replace is revision-guarded; the acknowledged hash only advances
//    on success, so a local edit made mid-request still compares dirty
//  - DELETE is revision-guarded and only drops the key on confirmed deletion;
//    404 reconciles to already-absent, every other failure keeps playlist+key
//  - detached (local-deleted) records stay manageable (inspect/delete) but
//    cannot be updated
import { describe, expect, it } from "vitest"
import type { LocalV2State } from "../../../../packages/shared/src/local-model"
import { publicationDirty } from "../../src/share/dirty-state"
import { createShareManagementFlow } from "../../src/share/management-flow"
import type { ShareManageReply } from "../../src/share/management-protocol"
import { SHARE_ORIGIN } from "../../src/share/origins"
import { InMemoryStorageDriver, StorageWriteError } from "../../src/storage/driver"
import { createLocalRepository, type LocalRepository } from "../../src/storage/repository"
import { playlist } from "../domain/fixtures"
import { v2State } from "../portable/fixtures"
import { operationId } from "../storage/fixtures"
import {
  type FakeApi,
  fakeShareApi,
  header,
  linkedRecord,
  MANAGE_SECRET,
  NOW,
  publicationRecord,
  SHARE_ID,
} from "./fixtures"

const STATE_KEY = "dop_v2_state"

type Rig = {
  readonly repository: LocalRepository
  readonly driver: InMemoryStorageDriver
  readonly api: FakeApi
  readonly flow: ReturnType<typeof createShareManagementFlow>
}

function rig(state: LocalV2State, api: FakeApi = fakeShareApi()): Rig {
  const driver = new InMemoryStorageDriver({ [STATE_KEY]: state })
  const repository = createLocalRepository({
    driver,
    now: () => NOW,
    newId: () => crypto.randomUUID(),
  })
  const flow = createShareManagementFlow({
    repository,
    fetchImpl: api.fetchImpl,
    now: () => NOW,
    newId: () => crypto.randomUUID(),
  })
  return { repository, driver, api, flow }
}

const publishRequest = (op = 1) => ({
  kind: "share-manage-publish" as const,
  operationId: operationId(op),
  playlistId: "p1",
  metadata: { visibility: "public" as const, description: "d", author: "a", tags: ["t"] },
})

function noSecrets(reply: ShareManageReply): void {
  // Replies cross the page boundary — they must never carry key material.
  expect(JSON.stringify(reply)).not.toContain(MANAGE_SECRET)
}

describe("management-flow/publish", () => {
  it("create → persist key → activate → published; record and URL land", async () => {
    const { repository, api, flow } = rig(v2State())
    const reply = await flow.publish(publishRequest())
    noSecrets(reply)
    expect(reply).toMatchObject({
      kind: "share-manage-result",
      status: "published",
      shareId: SHARE_ID,
      url: `${SHARE_ORIGIN}/p/${SHARE_ID}`,
      revision: 2,
    })
    // POST carried no secret; the PATCH carried it as a Bearer header.
    const [post, patch] = api.calls
    expect(post?.method).toBe("POST")
    expect(header(post?.headers ?? {}, "authorization")).toBeUndefined()
    expect(typeof header(post?.headers ?? {}, "idempotency-key")).toBe("string")
    expect(patch?.method).toBe("PATCH")
    expect(header(patch?.headers ?? {}, "authorization")).toBe(`Bearer ${MANAGE_SECRET}`)
    expect(patch?.body).toMatchObject({ operation: "activate", expectedRevision: 1 })

    const vault = await repository.readVault()
    expect(vault.pendingCreates).toHaveLength(0)
    const record = vault.publications[0]
    expect(record).toMatchObject({
      shareId: SHARE_ID,
      localPlaylistId: "p1",
      manageSecret: MANAGE_SECRET,
      revision: 2,
      state: "active",
    })
    const local = (await repository.readPublic()).playlists.find((p) => p.id === "p1")
    if (record === undefined) throw new Error("publication record missing")
    expect(await publicationDirty(record, local)).toEqual({ kind: "clean" })
  })

  it("persists pendingCreate BEFORE the POST and the key BEFORE activate", async () => {
    const { repository, api } = rig(v2State())
    const checks: string[] = []
    const wrapped: typeof api.fetchImpl = async (url, init) => {
      const vault = await repository.readVault()
      if (init.method === "POST") {
        checks.push(vault.pendingCreates.length === 1 ? "pending-first" : "pending-missing")
      }
      if (init.method === "PATCH") {
        checks.push(
          vault.publications[0]?.manageSecret === MANAGE_SECRET ? "key-first" : "key-missing",
        )
      }
      return api.fetchImpl(url, init)
    }
    const flow2 = createShareManagementFlow({
      repository,
      fetchImpl: wrapped,
      now: () => NOW,
      newId: () => crypto.randomUUID(),
    })
    const reply = await flow2.publish(publishRequest())
    expect(reply.status).toBe("published")
    expect(checks).toEqual(["pending-first", "key-first"])
  })

  it("a lost activate response leaves the key safe and activates on retry", async () => {
    const { repository, api, flow } = rig(v2State())
    api.dropNextPatch = true // PATCH applied server-side, response lost
    const first = await flow.publish(publishRequest())
    noSecrets(first)
    expect(first).toMatchObject({ status: "activate-pending", shareId: SHARE_ID })

    // The provisional record + key survived locally — no data was lost.
    const vault = await repository.readVault()
    const record = vault.publications[0]
    expect(record).toMatchObject({ shareId: SHARE_ID, state: "pending", revision: 1 })
    expect(record?.manageSecret).toBe(MANAGE_SECRET)

    // Retry activate with a fresh operation id — repeat-activate replays.
    const second = await flow.activate({
      shareId: SHARE_ID,
      operationId: operationId(9),
    })
    expect(second).toMatchObject({ status: "activated", shareId: SHARE_ID, revision: 2 })
    const after = await repository.readVault()
    expect(after.publications[0]).toMatchObject({ state: "active", revision: 2 })
    expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(2)
  })

  it("a lost create response keeps the pending create; same-key retry gets CREATE_RECEIPT_UNAVAILABLE", async () => {
    const { repository, api, flow } = rig(v2State())
    api.dropNextCreateResponse = true
    const first = await flow.publish(publishRequest())
    expect(first.status).toBe("offline")

    // The durable pendingCreate survives so the retry replays the SAME key.
    const vault = await repository.readVault()
    expect(vault.pendingCreates).toHaveLength(1)
    expect(vault.pendingCreates[0]?.operationId).toBe(operationId(1))

    const retry = await flow.publish(publishRequest())
    expect(retry.status).toBe("receipt-unavailable")
    expect((await repository.readVault()).pendingCreates).toHaveLength(0)
    const posts = api.calls.filter((call) => call.method === "POST")
    expect(header(posts[0]?.headers ?? {}, "idempotency-key")).toBe(
      header(posts[1]?.headers ?? {}, "idempotency-key"),
    )
    // A fresh attempt (new operation id) succeeds with a NEW key.
    const fresh = await flow.publish(publishRequest(2))
    expect(fresh.status).toBe("published")
    expect(header(posts[2]?.headers ?? {}, "idempotency-key")).not.toBe(
      header(posts[0]?.headers ?? {}, "idempotency-key"),
    )
  })

  it("a vault-write failure after create never activates and cleans up remotely", async () => {
    const { repository, driver, api } = rig(v2State())
    const wrapped: typeof api.fetchImpl = async (url, init) => {
      if (init.method === "POST") driver.failNextSet(new StorageWriteError("quota"))
      return api.fetchImpl(url, init)
    }
    const flow2 = createShareManagementFlow({
      repository,
      fetchImpl: wrapped,
      now: () => NOW,
      newId: () => crypto.randomUUID(),
    })
    const reply = await flow2.publish(publishRequest())
    expect(reply.status).toBe("persist-failed")
    // Best-effort authenticated cleanup DELETE was issued; nothing activated.
    expect(api.calls.map((call) => call.method)).toEqual(["POST", "DELETE"])
    const remote = api.remotes.get(SHARE_ID)
    expect(remote).toBeUndefined()
    const vault = await repository.readVault()
    expect(vault.publications).toHaveLength(0)
    expect(vault.pendingCreates).toHaveLength(0)
  })

  it("rejects a second publish for an already-linked playlist", async () => {
    const local = playlist("p1", ["a", "b"])
    const record = await linkedRecord(local)
    const { api, flow } = rig(v2State({ playlists: [local], publications: [record] }))
    const reply = await flow.publish(publishRequest())
    expect(reply.status).toBe("invalid-state")
    expect(api.calls).toHaveLength(0)
  })

  it("rejects unpublishable playlists locally without any network call", async () => {
    const broken = playlist("p1", ["a"])
    const first = broken.items[0]
    if (first === undefined) throw new Error("fixture playlist empty")
    broken.items = [{ ...first, range: null }]
    const { api, flow } = rig(v2State({ playlists: [broken] }))
    const reply = await flow.publish(publishRequest())
    expect(reply.status).toBe("unpublishable")
    expect(reply.reasons?.some((reason) => reason.path.includes("range"))).toBe(true)
    expect(api.calls).toHaveLength(0)
  })
})

describe("management-flow/update", () => {
  it("PATCH replace bumps revision, stores the immutable sent snapshot, and clears dirty", async () => {
    const local = playlist("p1", ["a", "b"])
    const record = await linkedRecord(local)
    const { repository, api, flow } = rig(v2State({ playlists: [local], publications: [record] }))
    // Seed the matching remote so GET/paths stay consistent.
    api.remotes.set(SHARE_ID, {
      shareId: SHARE_ID,
      secret: MANAGE_SECRET,
      revision: 2,
      state: "active",
      playlist: JSON.parse(record.sentSnapshot),
      contentHash: record.acknowledgedHash,
      createdAt: NOW,
      updatedAt: NOW,
    })
    // Local edit first → dirty, then update.
    await repository.dispatch({
      kind: "rename-playlist",
      operationId: operationId(3),
      expectedRevision: 0,
      playlistId: "p1",
      name: "Renamed",
    })
    expect(await publicationDirty(record, (await repository.readPublic()).playlists[0])).toEqual({
      kind: "dirty",
    })
    const reply = await flow.update({
      kind: "share-manage-update",
      shareId: SHARE_ID,
      operationId: operationId(4),
    })
    noSecrets(reply)
    expect(reply).toMatchObject({ status: "updated", shareId: SHARE_ID, revision: 3 })
    const patch = api.calls.find((call) => call.method === "PATCH")
    expect(patch?.body).toMatchObject({ operation: "replace", expectedRevision: 2 })
    const updated = (await repository.readVault()).publications[0]
    expect(updated).toMatchObject({ revision: 3, state: "active" })
    expect(updated?.sentSnapshot).not.toBe(record.sentSnapshot)
    const current = (await repository.readPublic()).playlists[0]
    if (updated === undefined) throw new Error("publication record missing")
    expect(await publicationDirty(updated, current)).toEqual({ kind: "clean" })
  })

  it("a local edit committed DURING the PATCH still compares dirty afterwards", async () => {
    const local = playlist("p1", ["a", "b"])
    const record = await linkedRecord(local)
    const { repository, api } = rig(v2State({ playlists: [local], publications: [record] }))
    api.remotes.set(SHARE_ID, {
      shareId: SHARE_ID,
      secret: MANAGE_SECRET,
      revision: 2,
      state: "active",
      playlist: JSON.parse(record.sentSnapshot),
      contentHash: record.acknowledgedHash,
      createdAt: NOW,
      updatedAt: NOW,
    })
    let release!: () => void
    let patchReached!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const patchSeen = new Promise<void>((resolve) => {
      patchReached = resolve
    })
    const wrapped: typeof api.fetchImpl = async (url, init) => {
      if (init.method === "PATCH") {
        patchReached() // signal BEFORE gating — the log entry lands on release
        await gate
      }
      return api.fetchImpl(url, init)
    }
    const flow2 = createShareManagementFlow({
      repository,
      fetchImpl: wrapped,
      now: () => NOW,
      newId: () => crypto.randomUUID(),
    })
    const pending = flow2.update({
      kind: "share-manage-update",
      shareId: SHARE_ID,
      operationId: operationId(4),
      metadata: { description: "updated description" },
    })
    // Wait until the PATCH is actually in flight, then commit a local edit.
    await patchSeen
    await repository.dispatch({
      kind: "rename-playlist",
      operationId: operationId(5),
      expectedRevision: 0, // no writes precede the in-flight PATCH
      playlistId: "p1",
      name: "Edited while in flight",
    })
    release()
    const reply = await pending
    expect(reply.status).toBe("updated")
    // The acknowledged snapshot is the OLD projection; the in-flight edit is dirty.
    const updated = (await repository.readVault()).publications[0]
    if (updated === undefined) throw new Error("publication record missing")
    expect(JSON.parse(updated.sentSnapshot).title).not.toBe("Edited while in flight")
    const current = (await repository.readPublic()).playlists[0]
    expect(await publicationDirty(updated, current)).toEqual({ kind: "dirty" })
  })

  it("no local change → unchanged, with zero network calls", async () => {
    const local = playlist("p1", ["a", "b"])
    const record = await linkedRecord(local)
    const { api, flow } = rig(v2State({ playlists: [local], publications: [record] }))
    const reply = await flow.update({
      kind: "share-manage-update",
      shareId: SHARE_ID,
      operationId: operationId(4),
    })
    expect(reply).toMatchObject({ status: "unchanged", revision: 2 })
    expect(api.calls).toHaveLength(0)
  })

  it("a revision conflict surfaces remoteRevision; an explicit retry overwrites", async () => {
    const local = playlist("p1", ["a", "b"])
    const record = await linkedRecord(local)
    const { repository, api, flow } = rig(v2State({ playlists: [local], publications: [record] }))
    api.remotes.set(SHARE_ID, {
      shareId: SHARE_ID,
      secret: MANAGE_SECRET,
      revision: 5, // remote moved ahead
      state: "active",
      playlist: JSON.parse(record.sentSnapshot),
      contentHash: record.acknowledgedHash,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await repository.dispatch({
      kind: "rename-playlist",
      operationId: operationId(3),
      expectedRevision: 0,
      playlistId: "p1",
      name: "Renamed",
    })
    const conflict = await flow.update({
      kind: "share-manage-update",
      shareId: SHARE_ID,
      operationId: operationId(4),
    })
    expect(conflict).toMatchObject({ status: "conflict", remoteRevision: 5 })
    // Local record untouched by the conflict.
    expect((await repository.readVault()).publications[0]).toMatchObject({ revision: 2 })
    const retry = await flow.update({
      kind: "share-manage-update",
      shareId: SHARE_ID,
      operationId: operationId(5),
      expectedRevision: 5,
    })
    expect(retry).toMatchObject({ status: "updated", revision: 6 })
  })

  it("refuses update on pending and detached records", async () => {
    const pending = publicationRecord({ state: "pending", revision: 1 })
    const { api, flow } = rig(v2State({ publications: [pending] }))
    const reply = await flow.update({
      kind: "share-manage-update",
      shareId: SHARE_ID,
      operationId: operationId(4),
    })
    expect(reply.status).toBe("invalid-state")

    const detached = publicationRecord({ state: "local-deleted", localPlaylistId: null })
    const rig2 = rig(v2State({ publications: [detached] }))
    const reply2 = await rig2.flow.update({
      kind: "share-manage-update",
      shareId: SHARE_ID,
      operationId: operationId(4),
    })
    expect(reply2.status).toBe("invalid-state")
    expect(api.calls).toHaveLength(0)
  })
})

describe("management-flow/deleteRemote + inspect", () => {
  function seededRemote(api: FakeApi, record: ReturnType<typeof publicationRecord>): void {
    api.remotes.set(SHARE_ID, {
      shareId: SHARE_ID,
      secret: MANAGE_SECRET,
      revision: record.revision,
      state: "active",
      playlist: JSON.parse(record.sentSnapshot),
      contentHash: record.acknowledgedHash,
      createdAt: NOW,
      updatedAt: NOW,
    })
  }

  it("204 deletes the record but keeps the local playlist", async () => {
    const local = playlist("p1", ["a"])
    const record = await linkedRecord(local)
    const { repository, api, flow } = rig(v2State({ playlists: [local], publications: [record] }))
    seededRemote(api, record)
    const reply = await flow.deleteRemote({
      kind: "share-manage-delete",
      shareId: SHARE_ID,
      operationId: operationId(4),
    })
    expect(reply.status).toBe("deleted")
    expect((await repository.readVault()).publications).toHaveLength(0)
    expect((await repository.readPublic()).playlists.map((p) => p.id)).toContain("p1")
    const del = api.calls.find((call) => call.method === "DELETE")
    expect(del?.body).toMatchObject({ expectedRevision: 2 })
    expect(header(del?.headers ?? {}, "authorization")).toBe(`Bearer ${MANAGE_SECRET}`)
  })

  it("404 reconciles to already-absent and retires the key locally", async () => {
    const record = publicationRecord({ state: "local-deleted", localPlaylistId: null })
    const { repository, flow } = rig(v2State({ publications: [record] }))
    const reply = await flow.deleteRemote({
      kind: "share-manage-delete",
      shareId: SHARE_ID,
      operationId: operationId(4),
    })
    expect(reply.status).toBe("already-absent")
    expect((await repository.readVault()).publications).toHaveLength(0)
  })

  it("conflict and offline failures keep the playlist AND the key", async () => {
    const local = playlist("p1", ["a"])
    const record = await linkedRecord(local)
    const { repository, api, flow } = rig(v2State({ playlists: [local], publications: [record] }))
    seededRemote(api, record)
    const remote = api.remotes.get(SHARE_ID)
    if (remote === undefined) throw new Error("remote not seeded")
    remote.revision = 9 // remote moved ahead
    const conflict = await flow.deleteRemote({
      kind: "share-manage-delete",
      shareId: SHARE_ID,
      operationId: operationId(4),
    })
    expect(conflict).toMatchObject({ status: "conflict", remoteRevision: 9 })
    expect((await repository.readVault()).publications).toHaveLength(1)

    api.offline = true
    const offline = await flow.deleteRemote({
      kind: "share-manage-delete",
      shareId: SHARE_ID,
      operationId: operationId(5),
      expectedRevision: 9,
    })
    expect(offline.status).toBe("offline")
    expect((await repository.readVault()).publications).toHaveLength(1)
    api.offline = false
    const retry = await flow.deleteRemote({
      kind: "share-manage-delete",
      shareId: SHARE_ID,
      operationId: operationId(6),
      expectedRevision: 9,
    })
    expect(retry.status).toBe("deleted")
  })

  it("inspect reconciles active / diverged / absent / unknown distinctly", async () => {
    const local = playlist("p1", ["a"])
    const record = await linkedRecord(local)
    const { api, flow } = rig(v2State({ playlists: [local], publications: [record] }))
    seededRemote(api, record)
    const active = await flow.inspect(SHARE_ID)
    expect(active).toMatchObject({
      status: "inspect",
      remote: "active",
      remoteRevision: 2,
      diverged: false,
    })
    const remote = api.remotes.get(SHARE_ID)
    if (remote === undefined) throw new Error("remote not seeded")
    remote.contentHash = "f".repeat(64)
    const diverged = await flow.inspect(SHARE_ID)
    expect(diverged).toMatchObject({ remote: "active", diverged: true })
    api.remotes.delete(SHARE_ID)
    expect(await flow.inspect(SHARE_ID)).toMatchObject({ remote: "absent" })
    api.offline = true
    expect(await flow.inspect(SHARE_ID)).toMatchObject({ remote: "unknown" })
    // Inspect never discloses the secret.
    noSecrets(active)
  })
})
