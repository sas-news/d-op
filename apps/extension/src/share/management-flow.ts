// Publication management state machine (task 15), executed inside the
// background worker. publish lives in publish-flow.ts (durable pendingCreate
// → create → persist key → activate); this module owns activate retry,
// revision-guarded update, conditional remote delete and the on-open remote
// reconcile. No timers or background polling: every call answers an explicit
// options-page action.
import type { PublicationRecord } from "../../../../packages/shared/src/local-model"
import { canonicalString, contentHashOf } from "../../../../packages/shared/src/share-canonical"
import {
  type PublishMetadata,
  type SharedPlaylist,
  SharedPlaylistSchema,
  UnpublishablePlaylistError,
} from "../../../../packages/shared/src/share-model"
import { toPublishProjection } from "../../../../packages/shared/src/share-projection"
import type { StorageDriver } from "../storage/driver"
import type { LocalRepository } from "../storage/repository"
import { type FetchLike, fetchSharedPlaylist } from "./api-client"
import { createVaultCommitter, networkFailure, reply, unpublishableReply } from "./flow-helpers"
import { deletePublication, patchPublication } from "./management-client"
import type {
  ShareManageDeleteRequest,
  ShareManagePublishRequest,
  ShareManageReply,
  ShareManageSourceState,
  ShareManageUpdateRequest,
} from "./management-protocol"
import { SHARE_ORIGIN, sharePageUrl } from "./origins"
import { type ImportRecord, latestImportFor } from "./provenance"
import { publishPlaylist } from "./publish-flow"

export type ShareManagementFlowDeps = {
  readonly repository: LocalRepository
  /** Import-provenance store (dop_v2_imports) — powers derivedFrom resolve. */
  readonly driver?: StorageDriver
  readonly apiOrigin?: string
  readonly fetchImpl?: FetchLike
  readonly now?: () => string
  readonly newId?: () => string
}

export function createShareManagementFlow(deps: ShareManagementFlowDeps) {
  const apiOrigin = deps.apiOrigin ?? SHARE_ORIGIN
  const now = deps.now ?? (() => new Date().toISOString())
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const clientBase = {
    apiOrigin,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  }
  const vault = createVaultCommitter(deps.repository, newId)

  const publish = (input: ShareManagePublishRequest): Promise<ShareManageReply> =>
    publishPlaylist(
      {
        repository: deps.repository,
        vault,
        clientBase,
        ...(deps.driver === undefined ? {} : { driver: deps.driver }),
        now,
        newId,
      },
      input,
    )

  /**
   * First-publish provenance preview (task 20): reads the private import
   * record, then verifies whether the source is CURRENTLY public. The result
   * is advisory text for the dialog — publish resolves it again authoritively.
   */
  async function source(playlistId: string): Promise<ShareManageReply> {
    const state = async (
      sourceState: ShareManageSourceState,
      sourceTitle?: string,
    ): Promise<ShareManageReply> =>
      reply("source", {
        sourceState,
        ...(sourceTitle === undefined ? {} : { sourceTitle }),
      })
    if (deps.driver === undefined) return state("none")
    let record: ImportRecord | undefined
    try {
      record = await latestImportFor(deps.driver, playlistId)
    } catch {
      return state("unknown")
    }
    if (record === undefined) return state("none")
    const parent = await fetchSharedPlaylist({ ...clientBase, shareId: record.shareId })
    if (parent.kind === "ok") {
      return state(
        parent.response.playlist.visibility === "public" ? "linked" : "withheld",
        record.title,
      )
    }
    return state(parent.reason === "not-found" ? "withheld" : "unknown", record.title)
  }

  async function activate(input: {
    readonly shareId: string
    readonly operationId: string
  }): Promise<ShareManageReply> {
    const current = await deps.repository.readVault()
    const record = current.publications.find((entry) => entry.shareId === input.shareId)
    if (record === undefined) return reply("not-found")
    if (record.state === "active") {
      // Already acknowledged locally — the repeat-activate contract makes a
      // fresh attempt safe, but there is nothing to do and no call is needed.
      return reply("activated", { shareId: record.shareId, revision: record.revision })
    }
    if (record.state !== "pending" || record.revision !== 1) return reply("invalid-state")
    const patched = await patchPublication({
      ...clientBase,
      shareId: record.shareId,
      secret: record.manageSecret,
      operation: { operation: "activate", expectedRevision: 1 },
      idempotencyKey: input.operationId,
    })
    if (patched.kind === "error") return networkFailure(patched)
    const next: PublicationRecord = {
      ...record,
      revision: patched.ack.revision,
      acknowledgedHash: patched.ack.contentHash,
      updatedAt: patched.ack.updatedAt,
      state: "active",
    }
    const persisted = await vault.try(newId(), () => ({
      kind: "put-publication",
      publication: next,
    }))
    if (!persisted) return reply("persist-failed")
    return reply("activated", {
      shareId: record.shareId,
      url: sharePageUrl(record.shareId, apiOrigin),
      revision: next.revision,
    })
  }

  async function update(input: ShareManageUpdateRequest): Promise<ShareManageReply> {
    const current = await deps.repository.readVault()
    const record = current.publications.find((entry) => entry.shareId === input.shareId)
    if (record === undefined) return reply("not-found")
    if (record.state === "pending") {
      return reply("invalid-state", { message: "先に公開を完了してください。" })
    }
    if (record.state !== "active") {
      return reply("invalid-state", {
        message: "ローカル削除済みの公開版は更新できません。",
      })
    }
    const publicState = await deps.repository.readPublic()
    const playlist = publicState.playlists.find((entry) => entry.id === record.localPlaylistId)
    if (playlist === undefined) return reply("invalid-state")
    let prior: SharedPlaylist
    try {
      prior = SharedPlaylistSchema.parse(JSON.parse(record.sentSnapshot))
    } catch {
      return reply("invalid-state", { message: "保存済みの公開スナップショットを読めません。" })
    }
    // Omitted metadata fields preserve the acknowledged snapshot; derivedFrom
    // is immutable after first publication and is carried over verbatim.
    const metadata: PublishMetadata = {
      visibility: input.metadata?.visibility ?? prior.visibility,
      description: input.metadata?.description ?? prior.description,
      author: input.metadata?.author ?? prior.author,
      tags: input.metadata?.tags === undefined ? prior.tags : [...input.metadata.tags],
      ...(prior.derivedFrom === undefined ? {} : { derivedFrom: prior.derivedFrom }),
    }
    let projection: SharedPlaylist
    try {
      projection = toPublishProjection(playlist, metadata)
    } catch (error) {
      if (error instanceof UnpublishablePlaylistError) return unpublishableReply(error.reasons)
      throw error
    }
    const canonical = canonicalString(projection)
    const hash = await contentHashOf(projection)
    // No remote call when nothing actually changed (an explicit conflict
    // retry revision overrides this — it must hit the server).
    if (hash === record.acknowledgedHash && input.expectedRevision === undefined) {
      return reply("unchanged", { shareId: record.shareId, revision: record.revision })
    }
    const patched = await patchPublication({
      ...clientBase,
      shareId: record.shareId,
      secret: record.manageSecret,
      operation: {
        operation: "replace",
        expectedRevision: input.expectedRevision ?? record.revision,
        playlist: projection,
      },
      idempotencyKey: input.operationId,
    })
    if (patched.kind === "error") return networkFailure(patched)
    // The record stores the IMMUTABLE snapshot just sent — concurrent local
    // edits made during the network wait still compare dirty afterwards.
    const next: PublicationRecord = {
      ...record,
      revision: patched.ack.revision,
      contentHash: hash,
      sentSnapshot: canonical,
      acknowledgedHash: patched.ack.contentHash,
      updatedAt: patched.ack.updatedAt,
      visibility: projection.visibility,
    }
    const persisted = await vault.try(newId(), () => ({
      kind: "put-publication",
      publication: next,
    }))
    if (!persisted) return reply("persist-failed")
    return reply("updated", { shareId: record.shareId, revision: next.revision })
  }

  async function deleteRemote(input: ShareManageDeleteRequest): Promise<ShareManageReply> {
    const current = await deps.repository.readVault()
    const record = current.publications.find((entry) => entry.shareId === input.shareId)
    if (record === undefined) return reply("not-found")
    const deleted = await deletePublication({
      ...clientBase,
      shareId: record.shareId,
      secret: record.manageSecret,
      expectedRevision: input.expectedRevision ?? record.revision,
      idempotencyKey: input.operationId,
    })
    if (deleted.kind === "error") {
      // A confirmed remote absence retires the capability locally too — the
      // key can manage nothing any more. Every other failure keeps the local
      // playlist AND the key untouched.
      if (deleted.reason !== "not-found") return networkFailure(deleted)
      const discardedAbsent = await vault.try(newId(), () => ({
        kind: "discard-publication-management",
        shareId: record.shareId,
      }))
      return discardedAbsent ? reply("already-absent") : reply("persist-failed")
    }
    // Confirmed remote deletion — only now may the local key be dropped.
    const discarded = await vault.try(newId(), () => ({
      kind: "discard-publication-management",
      shareId: record.shareId,
    }))
    return discarded ? reply("deleted") : reply("persist-failed")
  }

  async function inspect(shareId: string): Promise<ShareManageReply> {
    const current = await deps.repository.readVault()
    const record = current.publications.find((entry) => entry.shareId === shareId)
    if (record === undefined) return reply("not-found")
    const remote = await fetchSharedPlaylist({ ...clientBase, shareId })
    if (remote.kind === "ok") {
      return reply("inspect", {
        shareId,
        remote: "active",
        remoteRevision: remote.response.revision,
        remoteUpdatedAt: remote.response.updatedAt,
        diverged: remote.response.contentHash !== record.acknowledgedHash,
      })
    }
    return reply("inspect", {
      shareId,
      remote: remote.reason === "not-found" ? "absent" : "unknown",
    })
  }

  return { publish, activate, update, deleteRemote, inspect, source }
}

export type ShareManagementFlow = ReturnType<typeof createShareManagementFlow>
