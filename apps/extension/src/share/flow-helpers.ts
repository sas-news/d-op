// Shared helpers for the publication management flows (task 15): the reply
// shape, API-error → reply mapping, and the serialized vault-write loop.
// Vault writes go through the repository's revision-checked dispatch with a
// stable operationId so a lost ack replays the receipt instead of
// double-applying; storage-write failures fold into `false`.
import type {
  LocalCommand,
  PendingCreate,
  PublicationRecord,
  ShareConsentChoice,
} from "../../../../packages/shared/src/local-model"
import type { UnpublishableReason } from "../../../../packages/shared/src/share-model"
import type { CommandReply, LocalRepository, PublicationVault } from "../storage/repository"
import type { ShareMutationError } from "./management-client"
import type { ShareManageReply, ShareManageStatus } from "./management-protocol"

export type VaultCommandBody =
  | { readonly kind: "put-publication"; readonly publication: PublicationRecord }
  | { readonly kind: "discard-publication-management"; readonly shareId: string }
  | { readonly kind: "put-pending-create"; readonly pendingCreate: PendingCreate }
  | { readonly kind: "remove-pending-create"; readonly pendingOperationId: string }
  | {
      readonly kind: "set-share-consent"
      readonly choice: ShareConsentChoice
      readonly decidedAt: string
    }

const VAULT_MAX_ATTEMPTS = 4

export function reply(
  status: ShareManageStatus,
  extra: Partial<ShareManageReply> = {},
): ShareManageReply {
  return { kind: "share-manage-result", status, ...extra }
}

/** Share API failure → UI status. Offline/timeout stay distinct from server
 *  rejections so the dialog can offer resume-with-same-key on the former. */
export function networkFailure(error: ShareMutationError): ShareManageReply {
  switch (error.reason) {
    case "network":
    case "timeout":
      return reply("offline")
    case "not-found":
      return reply("not-found")
    case "revision-conflict":
      return reply("conflict", {
        ...(error.remoteRevision === undefined ? {} : { remoteRevision: error.remoteRevision }),
      })
    case "unauthorized":
      return reply("failed", { message: "管理キーが拒否されました。" })
    case "rate-limited":
      return reply("failed", {
        message: "レート制限中です。しばらくしてから再試行してください。",
      })
    case "unpublishable":
      return reply("unpublishable", {
        reasons: (error.paths ?? []).map((path) => ({ path, message: path })),
      })
    default:
      return reply("failed")
  }
}

export function unpublishableReply(reasons: readonly UnpublishableReason[]): ShareManageReply {
  return reply("unpublishable", {
    reasons: reasons.map((reason) => ({ path: reason.path, message: reason.message })),
  })
}

export type VaultCommitter = {
  /** Revision-checked write; returns the raw CommandReply. */
  readonly commit: (
    operationId: string,
    build: (vault: PublicationVault) => VaultCommandBody,
  ) => Promise<CommandReply>
  /** Same, folding storage errors / exhausted retries into false. */
  readonly try: (
    operationId: string,
    build: (vault: PublicationVault) => VaultCommandBody,
  ) => Promise<boolean>
  /** Best-effort pending-create cleanup — never throws, never gates. */
  readonly dropPendingCreate: (operationId: string) => Promise<void>
}

export function createVaultCommitter(
  repository: LocalRepository,
  newId: () => string,
): VaultCommitter {
  const commit = async (
    operationId: string,
    build: (vault: PublicationVault) => VaultCommandBody,
  ): Promise<CommandReply> => {
    for (let attempt = 0; attempt < VAULT_MAX_ATTEMPTS; attempt += 1) {
      const vault = await repository.readVault()
      const sent = await repository.dispatch({
        ...build(vault),
        operationId,
        expectedRevision: vault.revision,
      } as LocalCommand)
      if (sent.kind !== "revision-conflict") return sent
    }
    return { kind: "revision-conflict", actualRevision: -1, expectedRevision: -1 }
  }
  const tryCommit: VaultCommitter["try"] = async (operationId, build) => {
    try {
      return (await commit(operationId, build)).kind === "committed"
    } catch {
      return false
    }
  }
  return {
    commit,
    try: tryCommit,
    dropPendingCreate: async (operationId) => {
      await tryCommit(newId(), () => ({
        kind: "remove-pending-create",
        pendingOperationId: operationId,
      }))
    },
  }
}
