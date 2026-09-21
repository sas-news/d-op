// Share management dialog for the privileged options page (task 15). One
// dialog per playlist covers the whole lifecycle: first publish (explicit
// visibility, no default) → pending activation retry → status/URL/dirty +
// update (revision-guarded, conflict-aware) → remote delete → key discard.
// All Share API traffic goes through the background via ShareManageClient —
// the page never fetches the share origin itself. Confirmations are inline
// sub-views, not nested modals (the shared modal host replaces any open
// dialog). manageSecret/snapshot internals are never rendered.
// Pure DOM/text builders live in share-dialog-views.ts.
import type { LocalPlaylist, PublicationRecord } from "../../../../packages/shared/src/local-model"
import type { ModalHost } from "../player/modal"
import { type PublicationDirty, publicationDirty, snapshotMetadata } from "../share/dirty-state"
import type {
  ShareManageClient,
  ShareManageMetadata,
  ShareManageReply,
} from "../share/management-protocol"
import { sharePageUrl } from "../share/origins"
import {
  actionButton,
  confirmRow,
  describeRemoteReply,
  describeShareReply,
  line,
  metadataSection,
  readShareForm,
  shareDirtyText,
  shareStateText,
  statusBlock,
} from "./share-dialog-views"
import { runMutation, type UiStorageClient } from "./storage-client"

export type ShareDialogDeps = {
  readonly doc: Document
  readonly modal: ModalHost
  readonly storage: Pick<UiStorageClient, "readPublic" | "readVault" | "dispatch">
  readonly manage: ShareManageClient
  readonly newId: () => string
  readonly copyText: (text: string) => Promise<boolean>
  readonly showStatus: (text: string, type?: "success" | "error") => void
  /** Re-render the status line when canonical state changes (local edits). */
  readonly subscribe?: ((listener: () => void) => () => void) | undefined
  readonly log?: ((label: string, data?: unknown) => void) | undefined
  readonly onChanged?: (() => void) | undefined
}

export type ShareDialog = {
  readonly open: (playlistId: string) => Promise<void>
}

type ConfirmKind = "delete-remote" | "discard"

export function createShareDialog(deps: ShareDialogDeps): ShareDialog {
  const { doc } = deps
  const copyText = deps.copyText

  async function open(playlistId: string): Promise<void> {
    let playlist: LocalPlaylist | undefined
    let record: PublicationRecord | undefined
    let dirty: PublicationDirty | undefined
    let busy = false
    let confirm: ConfirmKind | undefined
    let resultText = ""
    let resultError = false
    let remoteText = ""
    let forceRevision: number | undefined
    let publishOpId = deps.newId()
    let updateOpId: string | undefined
    let deleteOpId: string | undefined
    // Draft survives re-renders after failed actions.
    let draft: ShareManageMetadata = {}
    let closeModal: (value: string | null) => void = () => undefined

    const container = doc.createElement("div")
    container.className = "share-dialog"

    const reload = async (): Promise<void> => {
      const [publicState, vault] = await Promise.all([
        deps.storage.readPublic(),
        deps.storage.readVault(),
      ])
      playlist = publicState.playlists.find((entry) => entry.id === playlistId)
      record = vault.publications.find(
        (entry) => entry.localPlaylistId === playlistId && entry.state !== "local-deleted",
      )
      dirty = undefined
      if (record !== undefined && playlist !== undefined) {
        dirty = await publicationDirty(record, playlist)
      }
    }

    const readForm = (): ShareManageMetadata => {
      draft = readShareForm(container)
      return draft
    }

    const button = (
      label: string,
      className: string,
      onClick: () => void,
      disabled = false,
    ): HTMLButtonElement => actionButton(doc, label, className, onClick, busy || disabled)

    async function applyReply(reply: ShareManageReply): Promise<void> {
      switch (reply.status) {
        case "published":
        case "activated":
        case "updated":
          updateOpId = undefined
          forceRevision = undefined
          deps.onChanged?.()
          break
        case "unchanged":
          updateOpId = undefined
          break
        case "deleted":
        case "already-absent":
          deps.showStatus(
            reply.status === "deleted"
              ? "公開版を削除しました。"
              : "リモートの公開版は既にありませんでした。管理情報を破棄しました。",
          )
          deps.onChanged?.()
          closeModal("close")
          return
        case "inspect":
          // Inspect renders into the remote line only — no result text.
          return
        case "conflict":
          updateOpId = undefined
          deleteOpId = undefined
          if (reply.remoteRevision !== undefined) forceRevision = reply.remoteRevision
          break
        case "receipt-unavailable":
          publishOpId = deps.newId()
          break
        case "offline":
          break // operationIds retained — the retry replays the same attempt
        default:
          break
      }
      resultText = describeShareReply(reply)
      resultError =
        reply.status !== "published" &&
        reply.status !== "activated" &&
        reply.status !== "updated" &&
        reply.status !== "unchanged"
      await reload()
    }

    async function run(action: () => Promise<ShareManageReply>): Promise<void> {
      busy = true
      resultText = ""
      render()
      try {
        await applyReply(await action())
      } catch (error) {
        deps.log?.("share-manage-failed", error)
        resultText = "失敗しました。"
        resultError = true
      }
      busy = false
      render()
    }

    async function doInspect(): Promise<void> {
      if (record === undefined) return
      const shareId = record.shareId
      await run(async () => {
        const reply = await deps.manage.inspect({ shareId })
        if (reply.status === "inspect") {
          remoteText = describeRemoteReply(reply)
          return { kind: "share-manage-result", status: "inspect" }
        }
        return reply
      })
    }

    function discardConfirmed(shareId: string): void {
      void (async () => {
        busy = true
        render()
        const mutation = await runMutation(
          deps.storage,
          () => ({ kind: "discard-publication-management", shareId }),
          deps.newId,
        )
        busy = false
        if (mutation.kind === "committed") {
          deps.showStatus("管理情報を破棄しました。")
          deps.onChanged?.()
          closeModal("close")
          return
        }
        resultText = "管理情報の破棄に失敗しました。"
        resultError = true
        render()
      })()
    }

    function actions(): HTMLElement {
      const row = doc.createElement("div")
      row.className = "share-actions"
      if (confirm === "delete-remote" || confirm === "discard") {
        const onCancel = (): void => {
          confirm = undefined
          render()
        }
        if (confirm === "delete-remote") {
          return confirmRow(
            doc,
            "リモートの公開版を削除します。ローカルのプレイリストは残ります。よろしいですか？",
            "公開版を削除する",
            "share-confirm-delete",
            busy,
            () => {
              confirm = undefined
              const shareId = record?.shareId
              if (shareId === undefined) return
              deleteOpId ??= deps.newId()
              const operationId = deleteOpId
              void run(() =>
                deps.manage.deleteRemote({
                  shareId,
                  operationId,
                  ...(forceRevision === undefined ? {} : { expectedRevision: forceRevision }),
                }),
              )
            },
            onCancel,
          )
        }
        return confirmRow(
          doc,
          "管理情報（管理キー）を破棄します。破棄するとこの公開版を更新・削除する手段は失われます。リモートの公開版は削除されず残り続けます。この操作は取り消せません。",
          "破棄する",
          "share-confirm-discard",
          busy,
          () => {
            confirm = undefined
            const shareId = record?.shareId
            if (shareId === undefined) return
            discardConfirmed(shareId)
          },
          onCancel,
        )
      }
      if (record === undefined) {
        row.append(
          button(
            "公開する",
            "btn-primary-text share-publish",
            () => {
              const meta = readForm()
              const visibility = meta.visibility
              if (visibility === undefined) return
              void run(() =>
                deps.manage.publish({
                  operationId: publishOpId,
                  playlistId,
                  metadata: { ...meta, visibility },
                }),
              )
            },
            draft.visibility === undefined,
          ),
        )
      } else if (record.state === "pending") {
        row.append(
          button("公開を完了する", "btn-primary-text share-activate", () => {
            if (record === undefined) return
            const shareId = record.shareId
            void run(() => deps.manage.activate({ shareId, operationId: deps.newId() }))
          }),
        )
      } else {
        row.append(
          button("更新を公開", "btn-primary-text share-update", () => {
            if (record === undefined) return
            const shareId = record.shareId
            updateOpId ??= deps.newId()
            const operationId = updateOpId
            const metadata = readForm()
            void run(() =>
              deps.manage.update({
                shareId,
                operationId,
                metadata,
                ...(forceRevision === undefined ? {} : { expectedRevision: forceRevision }),
              }),
            )
          }),
          button("状態を確認", "btn-text share-inspect", () => void doInspect()),
        )
      }
      if (record !== undefined) {
        row.append(
          button("公開版を削除", "btn-danger-text share-delete", () => {
            confirm = "delete-remote"
            render()
          }),
          button("管理情報を破棄", "btn-danger-text share-discard", () => {
            confirm = "discard"
            render()
          }),
        )
      }
      return row
    }

    function render(): void {
      container.replaceChildren()
      container.append(
        ...statusBlock(doc, record, dirty, remoteText, busy, (shareId) => {
          void copyText(sharePageUrl(shareId)).then((ok) =>
            deps.showStatus(
              ok ? "URLをコピーしました。" : "コピーできませんでした。",
              ok ? "success" : "error",
            ),
          )
        }),
      )
      if (record === undefined || record.state === "active") {
        container.append(
          ...metadataSection(
            doc,
            playlist,
            draft,
            record?.visibility,
            (visibility) => {
              draft = { ...readForm(), visibility }
              render()
            },
            () => {
              draft = { ...draft, ...readForm() }
            },
          ),
        )
      }
      if (busy) container.appendChild(line(doc, "share-busy", "通信中…"))
      container.appendChild(actions())
      const result = line(doc, `share-result ${resultError ? "error" : "success"}`, resultText)
      result.dataset["testid"] = "share-result"
      container.appendChild(result)
    }

    await reload()
    if (playlist === undefined) return
    // Prefill the draft from the acknowledged snapshot (update preserves the
    // existing visibility unless explicitly changed).
    if (record !== undefined) {
      const prior = snapshotMetadata(record)
      if (prior !== undefined) {
        draft = {
          visibility: prior.visibility,
          description: prior.description,
          author: prior.author,
          tags: [...(prior.tags ?? [])],
        }
      }
    }
    render()

    const renderStatus = (): void => {
      const state = container.querySelector<HTMLElement>(".share-state")
      if (state !== null) state.textContent = shareStateText(record)
      const badge = container.querySelector<HTMLElement>(".share-dirty")
      if (badge !== null) {
        badge.className = `share-dirty share-dirty-${dirty?.kind ?? "clean"}`
        badge.textContent = shareDirtyText(dirty)
      }
    }

    // Recompute the dirty badge on every local edit while the dialog is open
    // (no network — pure projection-vs-snapshot compare).
    const unsubscribe = deps.subscribe?.(() => {
      if (busy || confirm !== undefined) return
      void reload().then(renderStatus)
    })

    const modalPromise = deps.modal.show({
      title: `共有: ${playlist.name}`,
      body: "",
      bodyNode: container,
      buttons: [{ label: "閉じる", value: "close", primary: true }],
      onReady: (handle) => {
        closeModal = handle.close
      },
    })

    // Opening management reconciles remote state once (explicit action only).
    if (record !== undefined && record.state === "active") void doInspect()

    await modalPromise
    unsubscribe?.()
  }

  return { open }
}
