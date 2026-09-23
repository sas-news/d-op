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
import { type DataPermissions, writeShareConsent } from "../share/consent"
import { type PublicationDirty, publicationDirty, snapshotMetadata } from "../share/dirty-state"
import type {
  ShareManageClient,
  ShareManageMetadata,
  ShareManageReply,
} from "../share/management-protocol"
import { sharePageUrl, shareSiteUrl } from "../share/origins"
import {
  actionButton,
  confirmRow,
  describeRemoteReply,
  describeShareReply,
  describeSourceState,
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
  /** Task 22: Firefox ≥140 native data-consent prompt surface. */
  readonly dataPermissions?: DataPermissions | undefined
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

type ConfirmKind = "delete-remote" | "discard" | "discard-final"

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
    // Sub-view swap inside the fixed-size dialog: the destructive key-discard
    // and the inspect result live behind dedicated views instead of inline
    // expansion, so nothing ever changes the dialog's footprint.
    let view: "main" | "danger" | "inspect" = "main"
    // Task 20: first-publish provenance preview line (async, advisory).
    let sourceText = ""
    let forceRevision: number | undefined
    let publishOpId = deps.newId()
    let updateOpId: string | undefined
    let deleteOpId: string | undefined
    // Draft survives re-renders after failed actions.
    let draft: ShareManageMetadata = {}
    // Task 22: the dialog replaces the management actions with an explicit
    // consent prompt while Share consent is not granted — the background
    // gate rejects every management call with `consent-required` anyway, so
    // this is the UX surface, not the enforcement.
    let consentRequired = false
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
      consentRequired = vault.shareConsent?.choice !== "granted"
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
        case "source":
          // Inspect/source render into their own lines only — no result text.
          return
        case "consent-required":
          // Firefox ≥140 can revoke the native data consent independently of
          // the stored record — surface the prompt even when the vault still
          // reads "granted".
          consentRequired = true
          break
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

    /**
     * Task 22 consent prompt inside the dialog. Grant runs the Firefox ≥140
     * native data-consent prompt first (where it exists) and persists the
     * choice through the repository single writer; decline records the
     * explicit "declined" decision and closes — every local feature keeps
     * working and nothing has been transmitted either way.
     */
    async function decideConsent(choice: "granted" | "declined"): Promise<void> {
      busy = true
      resultText = ""
      render()
      try {
        const result = await writeShareConsent(
          deps.storage,
          deps.dataPermissions,
          choice,
          deps.newId,
        )
        if (result === "written") {
          if (choice === "declined") {
            deps.showStatus("共有機能は無効です。ローカルの機能はそのまま利用できます。")
            closeModal("close")
            return
          }
          deps.showStatus("共有機能を有効にしました。")
          deps.onChanged?.()
        } else if (result === "native-denied") {
          resultText = "ブラウザのデータ収集設定で許可されませんでした。共有機能は無効のままです。"
          resultError = true
        } else {
          resultText = "設定の保存に失敗しました。"
          resultError = true
        }
        await reload()
      } catch (error) {
        deps.log?.("share-consent-failed", error)
        resultText = "設定の保存に失敗しました。"
        resultError = true
      }
      busy = false
      render()
    }

    /** Consent prompt sub-view shown in place of the management actions. */
    function consentPanel(): HTMLElement[] {
      const text = line(
        doc,
        "share-consent-text",
        "共有機能は現在無効です。共有プレイリストの公開・更新・削除・状態確認を行うには、" +
          "d-op.sasnews.dev との通信を許可する必要があります。送信されるのは公開用の" +
          "スナップショットのみで、自動同期は行いません。",
      )
      const privacy = doc.createElement("p")
      privacy.className = "share-consent-privacy"
      const link = doc.createElement("a")
      link.href = shareSiteUrl("/privacy")
      link.target = "_blank"
      link.rel = "noopener"
      link.dataset["testid"] = "share-consent-privacy"
      link.textContent = "プライバシーポリシー"
      privacy.append("送信内容の詳細は ", link, " をご覧ください。")
      const row = doc.createElement("div")
      row.className = "share-actions"
      row.append(
        actionButton(
          doc,
          "共有機能を有効にする",
          "btn-primary share-consent-grant",
          () => void decideConsent("granted"),
          busy,
        ),
        actionButton(
          doc,
          "利用しない",
          "btn-text share-consent-decline",
          () => void decideConsent("declined"),
          busy,
        ),
      )
      return [text, privacy, row]
    }

    async function doInspect(showView = false): Promise<void> {
      if (record === undefined) return
      const shareId = record.shareId
      // The button opens the dedicated status view; the automatic reconcile
      // on dialog open stays inline (it feeds the .share-remote status line).
      if (showView) {
        view = "inspect"
        remoteText = ""
      }
      await run(async () => {
        const reply = await deps.manage.inspect({ shareId })
        if (reply.status === "inspect") {
          remoteText = describeRemoteReply(reply)
          return { kind: "share-manage-result", status: "inspect" }
        }
        return reply
      })
    }

    /**
     * First-publish provenance preview (task 20): one advisory background
     * call, result rendered as a status line only while the playlist is still
     * unpublished. The publish flow re-resolves authoritively — this text
     * never decides the payload.
     */
    async function doSource(): Promise<void> {
      const reply = await deps.manage.source({ playlistId })
      if (reply.status !== "source") return
      sourceText = describeSourceState(reply)
      if (record === undefined) render()
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
          () => {
            confirm = undefined
            render()
          },
        )
      }
      if (record === undefined) {
        row.append(
          button(
            "公開する",
            "btn-primary share-publish",
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
          button("公開を完了する", "btn-primary share-activate", () => {
            if (record === undefined) return
            const shareId = record.shareId
            void run(() => deps.manage.activate({ shareId, operationId: deps.newId() }))
          }),
        )
      } else {
        row.append(
          button("更新を公開", "btn-primary share-update", () => {
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
          button("状態を確認", "btn-text share-inspect", () => void doInspect(true)),
        )
      }
      if (record !== undefined) {
        row.append(
          button("公開版を削除", "btn-danger-text share-delete", () => {
            confirm = "delete-remote"
            render()
          }),
        )
      }
      return row
    }

    function dangerView(): HTMLElement[] {
      const nodes: HTMLElement[] = [line(doc, "share-subview-title", "その他の操作")]
      const cancel = (): void => {
        confirm = undefined
        render()
      }
      if (confirm === "discard") {
        nodes.push(
          confirmRow(
            doc,
            "管理情報（管理キー）を破棄します。公開版はリモートに残ったまま、更新・削除する手段が失われます。サイトから消したい場合は「公開版を削除」を使ってください。",
            "次へ",
            "share-discard-step1",
            busy,
            () => {
              confirm = "discard-final"
              render()
            },
            cancel,
          ),
        )
        return nodes
      }
      if (confirm === "discard-final") {
        nodes.push(
          confirmRow(
            doc,
            "最終確認: 破棄するとこの公開版を管理する手段は永久に失われ、元に戻せません。本当に破棄しますか？",
            "管理情報を破棄する",
            "share-confirm-discard",
            busy,
            () => {
              confirm = undefined
              const shareId = record?.shareId
              if (shareId === undefined) return
              discardConfirmed(shareId)
            },
            cancel,
          ),
        )
        return nodes
      }
      const row = doc.createElement("div")
      row.className = "share-actions"
      row.append(
        button("管理情報を破棄", "btn-danger-text share-discard", () => {
          confirm = "discard"
          render()
        }),
        button("戻る", "btn-text share-back", () => {
          view = "main"
          render()
        }),
      )
      nodes.push(
        line(
          doc,
          "share-danger-desc",
          "公開版をサイトから消すには「公開版を削除」を使います。ここにあるのは管理キーの破棄だけです。",
        ),
        row,
      )
      return nodes
    }

    function inspectView(): HTMLElement[] {
      const nodes: HTMLElement[] = [
        line(doc, "share-subview-title", "公開版の状態"),
        line(doc, "share-remote-detail", remoteText === "" ? "確認中…" : remoteText),
      ]
      if (record !== undefined) {
        nodes.push(
          line(doc, "share-remote-meta", `共有ID: ${record.shareId}`),
          line(doc, "share-remote-meta", `最終更新: ${record.updatedAt}`),
        )
      }
      if (resultText !== "") {
        nodes.push(line(doc, `share-result ${resultError ? "error" : "success"}`, resultText))
      }
      const row = doc.createElement("div")
      row.className = "share-actions"
      row.append(
        button("戻る", "btn-secondary share-back", () => {
          view = "main"
          render()
        }),
      )
      nodes.push(row)
      return nodes
    }

    function render(): void {
      container.replaceChildren()
      if (view === "danger") {
        container.append(...dangerView())
        return
      }
      if (view === "inspect") {
        container.append(...inspectView())
        return
      }
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
      // Provenance honesty line: an acknowledged snapshot that carries
      // derivedFrom shows its (public-or-redacted) source link; a first
      // publish shows the async preview text once it resolves.
      const acknowledged = record === undefined ? undefined : snapshotMetadata(record)
      if (acknowledged?.derivedFrom !== undefined) {
        container.appendChild(
          line(
            doc,
            "share-source-line",
            `Remix元: ${sharePageUrl(acknowledged.derivedFrom.shareId)}`,
          ),
        )
      } else if (record === undefined && sourceText !== "") {
        container.appendChild(line(doc, "share-source-line", sourceText))
      }
      if (consentRequired) {
        container.append(...consentPanel())
      } else if (record === undefined || record.state === "active") {
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
      if (!consentRequired) container.appendChild(actions())
      const result = line(doc, `share-result ${resultError ? "error" : "success"}`, resultText)
      result.dataset["testid"] = "share-result"
      container.appendChild(result)
      if (!consentRequired && record !== undefined) {
        container.appendChild(
          button("その他の操作", "btn-text share-danger-open", () => {
            view = "danger"
            render()
          }),
        )
      }
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
      buttons: [{ label: "閉じる", value: "close" }],
      onReady: (handle) => {
        closeModal = handle.close
      },
    })

    // Opening management reconciles remote state once (explicit action only)
    // — skipped entirely until consent is granted: the background would gate
    // the call anyway, and not issuing it keeps the zero-traffic guarantee
    // literal.
    if (!consentRequired) {
      if (record !== undefined && record.state === "active") void doInspect()
      // First publish: surface the private import-provenance preview (task 20).
      if (record === undefined) void doSource()
    }

    await modalPromise
    unsubscribe?.()
  }

  return { open }
}
