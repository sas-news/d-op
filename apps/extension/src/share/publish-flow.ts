// First-publication pipeline (task 15). Ordering contract: durable
// pendingCreate → POST the immutable snapshot → persist the returned
// manageSecret into the vault record BEFORE activation → activate. A lost
// activate response stays retryable because the key is already safe; a lost
// create response replays as 409 CREATE_RECEIPT_UNAVAILABLE and the user
// starts a fresh attempt with a new operation id. On a vault-write failure
// the provisional share is never activated — best-effort authenticated
// cleanup, otherwise it expires invisibly.
import { ACTIVATION_EXPIRES_AFTER_MS } from "../../../../packages/shared/src/limits"
import type { PendingCreate, PublicationRecord } from "../../../../packages/shared/src/local-model"
import { canonicalString, contentHashOf } from "../../../../packages/shared/src/share-canonical"
import type { DerivedFrom } from "../../../../packages/shared/src/share-model"
import {
  type SharedPlaylist,
  UnpublishablePlaylistError,
} from "../../../../packages/shared/src/share-model"
import { toPublishProjection } from "../../../../packages/shared/src/share-projection"
import type { StorageDriver } from "../storage/driver"
import type { LocalRepository } from "../storage/repository"
import { type FetchLike, fetchSharedPlaylist, type ShareFetchResult } from "./api-client"
import { networkFailure, reply, unpublishableReply, type VaultCommitter } from "./flow-helpers"
import { createPublication, deletePublication, patchPublication } from "./management-client"
import type {
  ShareManagePublishRequest,
  ShareManageReply,
  ShareManageSourceState,
} from "./management-protocol"
import { sharePageUrl } from "./origins"
import { type ImportRecord, latestImportFor } from "./provenance"

export type PublishFlowContext = {
  readonly repository: LocalRepository
  readonly vault: VaultCommitter
  readonly clientBase: { readonly apiOrigin: string; readonly fetchImpl?: FetchLike }
  /** Import-provenance store (dop_v2_imports). Absent in tests → no lookup. */
  readonly driver?: StorageDriver
  readonly now: () => string
  readonly newId: () => string
}

/**
 * Resolve the first-publication source link from PRIVATE local provenance.
 * The link is attached only while the parent verifies as currently public —
 * a definitively unlisted/absent parent withholds it (the public payload AND
 * its hash then carry no reference, while the local record survives for
 * future republishes). A transient check failure returns an error marker so
 * the caller aborts BEFORE writing pendingCreate: derivedFrom can never be
 * added later, so publishing blind would permanently lose the lineage.
 */
async function resolveDerivedFrom(
  ctx: PublishFlowContext,
  playlistId: string,
): Promise<
  | {
      readonly kind: "resolved"
      readonly derivedFrom: DerivedFrom | undefined
      readonly sourceState: ShareManageSourceState
    }
  | { readonly kind: "abort"; readonly reply: ShareManageReply }
> {
  const none = { kind: "resolved" as const, derivedFrom: undefined, sourceState: "none" as const }
  if (ctx.driver === undefined) return none
  let record: ImportRecord | undefined
  try {
    record = await latestImportFor(ctx.driver, playlistId)
  } catch {
    record = undefined // malformed advisory data → behave as no provenance
  }
  if (record === undefined) return none
  const parent = await fetchSharedPlaylist({
    ...ctx.clientBase,
    shareId: record.shareId,
  })
  if (parent.kind === "ok") {
    if (parent.response.playlist.visibility !== "public") {
      return { kind: "resolved", derivedFrom: undefined, sourceState: "withheld" }
    }
    return {
      kind: "resolved",
      derivedFrom: { shareId: record.shareId, revision: record.revision },
      sourceState: "linked",
    }
  }
  if (parent.reason === "not-found") {
    return { kind: "resolved", derivedFrom: undefined, sourceState: "withheld" }
  }
  return { kind: "abort", reply: sourceCheckFailure(parent) }
}

/** Parent-visibility check failure → bounded retryable/failed status. */
function sourceCheckFailure(
  error: Extract<ShareFetchResult, { readonly kind: "error" }>,
): ShareManageReply {
  switch (error.reason) {
    case "network":
    case "timeout":
      return reply("offline")
    case "rate-limited":
      return reply("failed", {
        message: "レート制限中です。しばらくしてから再試行してください。",
      })
    default:
      return reply("failed", { message: "インポート元の状態を確認できませんでした。" })
  }
}

export async function publishPlaylist(
  ctx: PublishFlowContext,
  input: ShareManagePublishRequest,
): Promise<ShareManageReply> {
  const publicState = await ctx.repository.readPublic()
  const playlist = publicState.playlists.find((entry) => entry.id === input.playlistId)
  if (playlist === undefined) {
    return reply("invalid-state", { message: "プレイリストが見つかりません。" })
  }
  const vault = await ctx.repository.readVault()
  const linked = vault.publications.find(
    (record) => record.localPlaylistId === playlist.id && record.state !== "local-deleted",
  )
  if (linked !== undefined) {
    return reply("invalid-state", { message: "このプレイリストは既に公開済みです。" })
  }
  const provenance = await resolveDerivedFrom(ctx, playlist.id)
  if (provenance.kind === "abort") return provenance.reply
  let projection: SharedPlaylist
  try {
    projection = toPublishProjection(playlist, {
      visibility: input.metadata.visibility,
      ...(input.metadata.description === undefined
        ? {}
        : { description: input.metadata.description }),
      ...(input.metadata.author === undefined ? {} : { author: input.metadata.author }),
      ...(input.metadata.tags === undefined ? {} : { tags: [...input.metadata.tags] }),
      ...(provenance.derivedFrom === undefined ? {} : { derivedFrom: provenance.derivedFrom }),
    })
  } catch (error) {
    if (error instanceof UnpublishablePlaylistError) return unpublishableReply(error.reasons)
    throw error
  }
  const canonical = canonicalString(projection)
  const hash = await contentHashOf(projection)

  // Prune pending creates older than the server activation window — their
  // provisional remote snapshot has expired and they can never resume.
  const cutoff = Date.parse(ctx.now()) - ACTIVATION_EXPIRES_AFTER_MS
  for (const entry of vault.pendingCreates) {
    if (Date.parse(entry.createdAt) < cutoff) await ctx.vault.dropPendingCreate(entry.operationId)
  }

  // Retry of the same attempt (same operationId + same payload) reuses the
  // durable Idempotency-Key so a lost first response replays safely; a
  // changed payload rotates the key.
  const prior = vault.pendingCreates.find((entry) => entry.operationId === input.operationId)
  let idempotencyKey: string
  if (prior !== undefined && prior.payloadHash === hash) {
    idempotencyKey = prior.idempotencyKey
  } else {
    idempotencyKey = ctx.newId()
    const pendingCreate: PendingCreate = {
      operationId: input.operationId,
      idempotencyKey,
      payloadHash: hash,
      createdAt: ctx.now(),
    }
    // Fresh command opId: a same-attempt retry with a CHANGED payload must
    // replace the pending entry, not collide with the prior command's
    // operation receipt. `pendingCreate.operationId` is the dedupe key.
    const recorded = await ctx.vault.commit(ctx.newId(), () => ({
      kind: "put-pending-create",
      pendingCreate,
    }))
    if (recorded.kind !== "committed") {
      return reply("persist-failed", { message: "公開操作をローカルに記録できませんでした。" })
    }
  }

  const created = await createPublication({
    ...ctx.clientBase,
    playlist: projection,
    idempotencyKey,
  })
  if (created.kind === "error") {
    if (created.reason === "receipt-unavailable") {
      // The first response (with the key) was lost server-side; this attempt
      // can never be activated. The next attempt needs a new operation id.
      await ctx.vault.dropPendingCreate(input.operationId)
      return reply("receipt-unavailable")
    }
    // Offline/timeout/transient failures keep the pending create so the
    // dialog can resume the SAME attempt with the SAME key.
    return networkFailure(created)
  }
  const ack = created.ack
  if (ack.contentHash !== hash || ack.state !== "pending") {
    return reply("failed", { message: "サーバーの応答が送信内容と一致しません。" })
  }

  // Key persistence BEFORE activation.
  const record: PublicationRecord = {
    shareId: ack.shareId,
    localPlaylistId: playlist.id,
    manageSecret: ack.manageSecret,
    revision: ack.revision,
    contentHash: hash,
    sentSnapshot: canonical,
    acknowledgedHash: ack.contentHash,
    visibility: projection.visibility,
    createdAt: ack.createdAt,
    updatedAt: ack.createdAt,
    state: "pending",
  }
  const persisted = await ctx.vault.try(ctx.newId(), () => ({
    kind: "put-publication",
    publication: record,
  }))
  if (!persisted) {
    await deletePublication({
      ...ctx.clientBase,
      shareId: ack.shareId,
      secret: ack.manageSecret,
      expectedRevision: ack.revision,
      idempotencyKey: ctx.newId(),
    }).then(
      () => undefined,
      () => undefined,
    )
    await ctx.vault.dropPendingCreate(input.operationId)
    return reply("persist-failed", {
      message: "管理キーをローカルに保存できませんでした。公開版は有効化されていません。",
    })
  }

  const activated = await patchPublication({
    ...ctx.clientBase,
    shareId: ack.shareId,
    secret: ack.manageSecret,
    operation: { operation: "activate", expectedRevision: 1 },
    idempotencyKey: ctx.newId(),
  })
  if (activated.kind === "error") {
    return reply("activate-pending", {
      shareId: ack.shareId,
      url: sharePageUrl(ack.shareId, ctx.clientBase.apiOrigin),
    })
  }
  const finalRecord: PublicationRecord = {
    ...record,
    revision: activated.ack.revision,
    acknowledgedHash: activated.ack.contentHash,
    updatedAt: activated.ack.updatedAt,
    state: "active",
  }
  const finalized = await ctx.vault.try(ctx.newId(), () => ({
    kind: "put-publication",
    publication: finalRecord,
  }))
  if (!finalized) {
    return reply("activate-pending", { shareId: ack.shareId })
  }
  await ctx.vault.dropPendingCreate(input.operationId)
  return reply("published", {
    shareId: ack.shareId,
    url: sharePageUrl(ack.shareId, ctx.clientBase.apiOrigin),
    revision: finalRecord.revision,
    sourceState: provenance.sourceState,
  })
}
