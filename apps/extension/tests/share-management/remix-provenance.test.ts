// Import provenance → first-publication derivedFrom (task 20). The publish
// flow resolves the local dop_v2_imports record, verifies the parent is
// CURRENTLY public via a real GET, and only then attaches the link. A
// definitively unlisted/absent parent withholds it — the public payload and
// its hash carry no reference while the private record survives — and a
// transient check failure aborts BEFORE the durable pendingCreate so the
// same attempt can retry without losing the lineage.
import { describe, expect, it } from "vitest"
import type { LocalV2State } from "../../../../packages/shared/src/local-model"
import { createShareManagementFlow } from "../../src/share/management-flow"
import { IMPORT_RECORDS_KEY, type ImportRecord } from "../../src/share/provenance"
import { InMemoryStorageDriver } from "../../src/storage/driver"
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
  SHARE_ID,
  sharePlaylist,
} from "./fixtures"

const STATE_KEY = "dop_v2_state"
const PARENT_ID = "parentShareId000000001" // exactly 22 chars
const PARENT_SECRET = "fakeParentSecret".padEnd(43, "0")

function importRecord(overrides: Partial<ImportRecord> = {}): ImportRecord {
  return {
    playlistId: "p1",
    shareId: PARENT_ID,
    revision: 3,
    contentHash: "c".repeat(64),
    title: "インポート元リスト",
    itemCount: 2,
    importedAt: NOW,
    ...overrides,
  }
}

function importsFile(records: readonly ImportRecord[]): Record<string, unknown> {
  return { [IMPORT_RECORDS_KEY]: { schemaVersion: 1, records: [...records] } }
}

type Rig = {
  readonly repository: LocalRepository
  readonly driver: InMemoryStorageDriver
  readonly api: FakeApi
  readonly flow: ReturnType<typeof createShareManagementFlow>
}

function rig(
  state: LocalV2State,
  api: FakeApi = fakeShareApi(),
  imports: Record<string, unknown> = {},
): Rig {
  const driver = new InMemoryStorageDriver({ [STATE_KEY]: state, ...imports })
  const repository = createLocalRepository({
    driver,
    now: () => NOW,
    newId: () => crypto.randomUUID(),
  })
  const flow = createShareManagementFlow({
    repository,
    driver,
    fetchImpl: api.fetchImpl,
    now: () => NOW,
    newId: () => crypto.randomUUID(),
  })
  return { repository, driver, api, flow }
}

/** Seed an ACTIVE parent remote so the provenance GET resolves. */
function seedParent(api: FakeApi, visibility: "public" | "unlisted" = "public"): void {
  const playlistSnapshot = sharePlaylist({ visibility })
  api.remotes.set(PARENT_ID, {
    shareId: PARENT_ID,
    secret: PARENT_SECRET,
    revision: 3,
    state: "active",
    playlist: playlistSnapshot,
    contentHash: "d".repeat(64),
    createdAt: NOW,
    updatedAt: NOW,
  })
}

const publishRequest = (op = 1) => ({
  kind: "share-manage-publish" as const,
  operationId: operationId(op),
  playlistId: "p1",
  metadata: { visibility: "public" as const },
})

async function readImports(driver: InMemoryStorageDriver): Promise<readonly ImportRecord[]> {
  const stored = await driver.get([IMPORT_RECORDS_KEY])
  const file = stored[IMPORT_RECORDS_KEY] as { records: ImportRecord[] } | undefined
  return file?.records ?? []
}

describe("publish provenance → derivedFrom", () => {
  it("attaches the recorded source link when the parent is currently public", async () => {
    const api = fakeShareApi()
    seedParent(api)
    const { driver, flow } = rig(v2State(), api, importsFile([importRecord()]))
    const reply = await flow.publish(publishRequest())
    expect(reply).toMatchObject({ status: "published", sourceState: "linked" })
    // Request order: GET parent (visibility check) → POST create → PATCH activate.
    const [check, post, patch] = api.calls
    expect(check?.method).toBe("GET")
    expect(check?.url).toContain(`/api/v1/playlists/${PARENT_ID}`)
    expect(post?.body).toMatchObject({
      derivedFrom: { shareId: PARENT_ID, revision: 3 },
    })
    expect(header(post?.headers ?? {}, "authorization")).toBeUndefined()
    expect(patch?.body).toMatchObject({ operation: "activate" })
    // The private provenance record is untouched by publication.
    expect(await readImports(driver)).toHaveLength(1)
  })

  it("withholds the link when the parent is unlisted — payload and hash carry no reference", async () => {
    const api = fakeShareApi()
    seedParent(api, "unlisted")
    const { driver, flow } = rig(v2State(), api, importsFile([importRecord()]))
    const reply = await flow.publish(publishRequest())
    expect(reply).toMatchObject({ status: "published", sourceState: "withheld" })
    const post = api.calls.find((call) => call.method === "POST")
    expect(post?.body).not.toHaveProperty("derivedFrom")
    expect(JSON.stringify(post?.body)).not.toContain(PARENT_ID)
    // Private provenance survives for future republishes.
    expect(await readImports(driver)).toHaveLength(1)
  })

  it("withholds the link when the parent is gone (404)", async () => {
    const api = fakeShareApi() // no parent remote seeded
    const { flow } = rig(v2State(), api, importsFile([importRecord()]))
    const reply = await flow.publish(publishRequest())
    expect(reply).toMatchObject({ status: "published", sourceState: "withheld" })
    const post = api.calls.find((call) => call.method === "POST")
    expect(post?.body).not.toHaveProperty("derivedFrom")
  })

  it("aborts retryably on a transient parent-check failure — before pendingCreate", async () => {
    const api = fakeShareApi()
    api.offline = true
    const { repository, flow } = rig(v2State(), api, importsFile([importRecord()]))
    const reply = await flow.publish(publishRequest())
    expect(reply.status).toBe("offline")
    // Only the visibility GET ran — no POST, no durable pendingCreate.
    expect(api.calls).toHaveLength(1)
    expect(api.calls[0]?.method).toBe("GET")
    expect((await repository.readVault()).pendingCreates).toHaveLength(0)
  })

  it("publishes without any check when no import record exists", async () => {
    const api = fakeShareApi()
    const { flow } = rig(v2State(), api)
    const reply = await flow.publish(publishRequest())
    expect(reply).toMatchObject({ status: "published", sourceState: "none" })
    expect(api.calls.map((call) => call.method)).toEqual(["POST", "PATCH"])
    expect(api.calls[0]?.body).not.toHaveProperty("derivedFrom")
  })

  it("update carries the stored derivedFrom verbatim — provenance never re-resolves", async () => {
    const local = playlist("p1", ["a", "b"])
    const derived = { shareId: PARENT_ID, revision: 3 }
    // A record whose acknowledged snapshot carries the first-publish link.
    const base = await linkedRecord(local)
    const snapshot = JSON.parse(base.sentSnapshot) as Record<string, unknown>
    snapshot["derivedFrom"] = derived
    const record = { ...base, sentSnapshot: JSON.stringify(snapshot) }
    const api = fakeShareApi()
    api.remotes.set(SHARE_ID, {
      shareId: SHARE_ID,
      secret: MANAGE_SECRET,
      revision: 2,
      state: "active",
      playlist: snapshot as never,
      contentHash: record.acknowledgedHash,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const { repository, flow } = rig(v2State({ playlists: [local], publications: [record] }), api)
    // No import record for p1 — the update must STILL keep the stored link.
    await repository.dispatch({
      kind: "rename-playlist",
      operationId: operationId(3),
      expectedRevision: 0,
      playlistId: "p1",
      name: "Remix edited",
    })
    const reply = await flow.update({
      kind: "share-manage-update",
      shareId: SHARE_ID,
      operationId: operationId(4),
    })
    expect(reply.status).toBe("updated")
    const patch = api.calls.find((call) => call.method === "PATCH")
    expect(patch?.body).toMatchObject({
      operation: "replace",
      playlist: { derivedFrom: derived },
    })
  })
})

describe("source preview (share-manage-source)", () => {
  it("reports linked / withheld / none / unknown from provenance + live check", async () => {
    const api = fakeShareApi()
    seedParent(api)
    const { flow } = rig(v2State(), api, importsFile([importRecord()]))
    const linked = await flow.source("p1")
    expect(linked).toMatchObject({
      status: "source",
      sourceState: "linked",
      sourceTitle: "インポート元リスト",
    })

    // Unlisted parent → withheld.
    const unlisted = fakeShareApi()
    seedParent(unlisted, "unlisted")
    const rig2 = rig(v2State(), unlisted, importsFile([importRecord()]))
    expect(await rig2.flow.source("p1")).toMatchObject({
      status: "source",
      sourceState: "withheld",
    })

    // No provenance → none (no network call at all).
    const clean = fakeShareApi()
    const rig3 = rig(v2State(), clean)
    expect(await rig3.flow.source("p1")).toMatchObject({ sourceState: "none" })
    expect(clean.calls).toHaveLength(0)

    // Parent deleted → withheld; unreachable → unknown.
    const missing = fakeShareApi()
    const rig4 = rig(v2State(), missing, importsFile([importRecord()]))
    expect(await rig4.flow.source("p1")).toMatchObject({ sourceState: "withheld" })
    missing.offline = true
    expect(await rig4.flow.source("p1")).toMatchObject({ sourceState: "unknown" })
  })

  it("the source reply never carries secret material", async () => {
    const api = fakeShareApi()
    seedParent(api)
    const { flow } = rig(v2State(), api, importsFile([importRecord()]))
    const reply = await flow.source("p1")
    expect(JSON.stringify(reply)).not.toContain(PARENT_SECRET)
    expect(JSON.stringify(reply)).not.toContain(MANAGE_SECRET)
  })
})
