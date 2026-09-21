// Detached share-management list — Local data contract step 7. When a local
// playlist is deleted or the library is JSON-replaced, the command layer
// DETACHES the linked publication record (localPlaylistId=null,
// state="local-deleted") instead of dropping it; this module renders those
// records ('共有管理 / ローカル削除済み'), explains that the remote public
// copy remains, and offers the explicit destructive '管理情報を破棄' action —
// a distinct discard-publication-management command behind a key-loss
// warning. Key export is intentionally NOT implemented; manageSecret and the
// snapshot/hash fields are never rendered.
import type { PublicationRecord } from "../../../../packages/shared/src/local-model"
import type { ModalHost } from "../player/modal"
import { runMutation, type UiStorageClient, type VaultReply } from "./storage-client"

export type ShareManagementDeps = {
  readonly doc: Document
  readonly storage: Pick<UiStorageClient, "readPublic" | "readVault" | "dispatch">
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

  async function destroy(record: PublicationRecord): Promise<void> {
    const value = await deps.modal.show({
      title: "管理情報の破棄",
      body: `共有 ${record.shareId} の管理情報（管理キー）を破棄します。破棄するとこの公開版を更新・削除する手段は失われます。リモートの公開版は削除されず残り続けます。この操作は取り消せません。`,
      buttons: [
        { label: "キャンセル", value: "cancel" },
        { label: "破棄する", value: "destroy", primary: true },
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
    const button = doc.createElement("button")
    button.type = "button"
    button.className = "btn-danger-text management-destroy"
    button.textContent = "管理情報を破棄"
    button.addEventListener("click", () => void destroy(record))
    element.append(id, visibility, updated, button)
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
