// Detached share-management list — Local data contract step 7. When a local
// playlist is deleted or the library is JSON-replaced, the command layer
// DETACHES the linked publication record (localPlaylistId=null,
// state="local-deleted") instead of dropping it; this module renders those
// records ('共有管理 / ローカル削除済み'), explains that the remote public
// copy remains, and keeps them manageable: remote status check and remote
// delete go through the background ShareManageClient, and the explicit
// destructive '管理情報を破棄' action stays behind a key-loss warning.
// Key export is intentionally NOT implemented; manageSecret and the
// snapshot/hash fields are never rendered.
import type { PublicationRecord } from "../../../../packages/shared/src/local-model"
import type { ModalHost } from "../player/modal"
import type { ShareManageClient, ShareManageReply } from "../share/management-protocol"
import { runMutation, type UiStorageClient, type VaultReply } from "./storage-client"

export type ShareManagementDeps = {
  readonly doc: Document
  readonly storage: Pick<UiStorageClient, "readPublic" | "readVault" | "dispatch">
  readonly manage: ShareManageClient
  readonly newId: () => string
  readonly modal: ModalHost
  readonly showStatus: (text: string, type?: "success" | "error") => void
  readonly log?: ((label: string, data?: unknown) => void) | undefined
  /** Called after a committed destroy so the list refreshes immediately. */
  readonly onChanged?: (() => void) | undefined
}

export type ShareManagement = {
  readonly render: (container: HTMLElement | null) => Promise<void>
}

export function createShareManagement(deps: ShareManagementDeps): ShareManagement {
  const { doc } = deps
  // After a revision conflict the row's next delete retries against the
  // remote revision the server disclosed — an explicit user re-click, never
  // an automatic overwrite.
  const forceRevisions = new Map<string, number>()

  async function destroy(record: PublicationRecord): Promise<void> {
    const first = await deps.modal.show({
      title: "管理情報の破棄",
      body: `共有 ${record.shareId} の管理情報（管理キー）を破棄します。公開版はリモートに残ったまま、更新・削除する手段が失われます。サイトから消したい場合は「公開版を削除」を選んでください。`,
      buttons: [
        { label: "キャンセル", value: "cancel" },
        { label: "次へ", value: "next" },
      ],
    })
    if (first !== "next") return
    const value = await deps.modal.show({
      title: "管理情報の破棄（最終確認）",
      body: "破棄するとこの公開版を管理する手段は永久に失われ、元に戻せません。本当に破棄しますか？",
      buttons: [
        { label: "キャンセル", value: "cancel" },
        { label: "管理情報を破棄する", value: "destroy", primary: true },
      ],
    })
    if (value !== "destroy") return
    const reply = await runMutation(
      deps.storage,
      () => ({ kind: "discard-publication-management", shareId: record.shareId }),
      deps.newId,
    )
    if (reply.kind === "committed") {
      deps.showStatus("管理情報を破棄しました。")
      deps.onChanged?.()
    } else {
      deps.showStatus("管理情報の破棄に失敗しました。", "error")
    }
  }

  function rowStatus(element: HTMLElement, text: string): void {
    let status = element.querySelector<HTMLElement>(".management-remote")
    if (status === null) {
      status = doc.createElement("span")
      status.className = "management-remote"
      element.appendChild(status)
    }
    status.textContent = text
  }

  function describeRemote(reply: ShareManageReply): string {
    if (reply.status === "consent-required") {
      return "共有機能が無効です（設定の「共有機能」で有効化できます）。"
    }
    if (reply.status !== "inspect") return "確認できませんでした。"
    switch (reply.remote) {
      case "active":
        return `リモート: 公開中（revision ${reply.remoteRevision ?? "?"}）${
          reply.diverged === true ? " — 管理情報と異なります" : ""
        }`
      case "absent":
        return "リモートに公開版が見つかりません（削除済み・期限切れ）。"
      default:
        return "リモートの状態を確認できませんでした（オフラインまたは一時的な障害）。"
    }
  }

  async function inspect(record: PublicationRecord, element: HTMLElement): Promise<void> {
    rowStatus(element, "確認中…")
    const reply = await deps.manage.inspect({ shareId: record.shareId })
    rowStatus(element, "")
    // A one-line span was too cramped for this — show the status in the same
    // modal surface the rest of the extension uses.
    await deps.modal.show({
      title: "公開版の状態",
      body: `${describeRemote(reply)}\n\n共有ID: ${record.shareId}\n最終更新: ${record.updatedAt}`,
      buttons: [{ label: "閉じる", value: "ok", primary: true }],
    })
  }

  async function deleteRemote(record: PublicationRecord, element: HTMLElement): Promise<void> {
    const value = await deps.modal.show({
      title: "公開版の削除",
      body: `共有 ${record.shareId} のリモート公開版を削除します。ローカルのプレイリストはすでに削除済みです。削除が確認できたら管理情報も破棄します。`,
      buttons: [
        { label: "キャンセル", value: "cancel" },
        { label: "公開版を削除", value: "delete", primary: true },
      ],
    })
    if (value !== "delete") return
    rowStatus(element, "削除中…")
    const force = forceRevisions.get(record.shareId)
    const reply = await deps.manage.deleteRemote({
      shareId: record.shareId,
      operationId: deps.newId(),
      ...(force === undefined ? {} : { expectedRevision: force }),
    })
    switch (reply.status) {
      case "deleted":
        deps.showStatus("公開版を削除しました。")
        forceRevisions.delete(record.shareId)
        deps.onChanged?.()
        return
      case "already-absent":
        deps.showStatus("リモートの公開版は既にありませんでした。管理情報を破棄しました。")
        forceRevisions.delete(record.shareId)
        deps.onChanged?.()
        return
      case "conflict":
        if (reply.remoteRevision !== undefined) {
          forceRevisions.set(record.shareId, reply.remoteRevision)
        }
        rowStatus(
          element,
          `リモートが変更されています（revision ${reply.remoteRevision ?? "?"}）。再試行すると上書き削除します。`,
        )
        return
      case "offline":
        rowStatus(element, "ネットワークエラー。削除は実行されていません。")
        return
      case "consent-required":
        rowStatus(element, "共有機能が無効です。削除は実行されていません。")
        return
      default:
        rowStatus(element, "公開版の削除に失敗しました。ローカルの管理情報は保持されています。")
        return
    }
  }

  function row(record: PublicationRecord): HTMLElement {
    const element = doc.createElement("div")
    element.className = "management-row"
    element.dataset["shareId"] = record.shareId
    const id = doc.createElement("span")
    id.className = "management-id"
    id.textContent = record.shareId
    const visibility = doc.createElement("span")
    visibility.className = "management-visibility"
    visibility.textContent = record.visibility === "public" ? "公開" : "限定公開"
    const updated = doc.createElement("span")
    updated.className = "management-updated"
    updated.textContent = `最終更新: ${record.updatedAt}`
    const inspectButton = doc.createElement("button")
    inspectButton.type = "button"
    inspectButton.className = "btn-text management-inspect"
    inspectButton.textContent = "状態を確認"
    inspectButton.addEventListener("click", () => void inspect(record, element))
    const deleteButton = doc.createElement("button")
    deleteButton.type = "button"
    deleteButton.className = "btn-danger-text management-delete-remote"
    deleteButton.textContent = "公開版を削除"
    deleteButton.addEventListener("click", () => void deleteRemote(record, element))
    const destroyButton = doc.createElement("button")
    destroyButton.type = "button"
    destroyButton.className = "btn-danger-text management-destroy"
    destroyButton.textContent = "管理情報を破棄"
    destroyButton.addEventListener("click", () => void destroy(record))
    // Key discard is irreversible and easily mistaken for remote delete —
    // keep it behind a collapsed per-row disclosure, off the main row.
    const danger = doc.createElement("details")
    danger.className = "management-danger"
    const dangerSummary = doc.createElement("summary")
    dangerSummary.textContent = "その他"
    danger.append(dangerSummary, destroyButton)
    element.append(id, visibility, updated, inspectButton, deleteButton, danger)
    return element
  }

  async function render(container: HTMLElement | null): Promise<void> {
    if (container === null) return
    let vault: VaultReply
    try {
      vault = await deps.storage.readVault()
    } catch (error) {
      // Vault read is privileged; a denial/malformed reply empties the list
      // rather than breaking the whole options render.
      deps.log?.("vault-read-failed", error)
      container.replaceChildren()
      return
    }
    const detached = vault.publications.filter((record) => record.state === "local-deleted")
    container.replaceChildren()
    if (detached.length === 0) {
      const empty = doc.createElement("p")
      empty.className = "management-empty"
      empty.textContent = "ローカル削除済みの共有管理情報はありません。"
      container.appendChild(empty)
      return
    }
    const note = doc.createElement("p")
    note.className = "management-note"
    note.textContent =
      "以下の共有はローカルのプレイリストを削除済みです。リモートの公開版はそのまま残っています。"
    container.appendChild(note)
    for (const record of detached) {
      container.appendChild(row(record))
    }
  }

  return { render }
}
