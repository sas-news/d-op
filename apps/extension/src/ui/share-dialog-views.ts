// Pure view helpers for the share-management dialog (task 15): status/dirty
// text, reply description, publish-preview line and the metadata form fields.
// No state, no network — every function is a pure DOM/string builder so the
// dialog module keeps only orchestration.
import type { LocalPlaylist, PublicationRecord } from "../../../../packages/shared/src/local-model"
import type { UnpublishablePlaylistError } from "../../../../packages/shared/src/share-model"
import { toPublishProjection } from "../../../../packages/shared/src/share-projection"
import type { PublicationDirty } from "../share/dirty-state"
import type { ShareManageMetadata, ShareManageReply } from "../share/management-protocol"
import { sharePageUrl } from "../share/origins"
import { formatSec } from "./format"

export function line(doc: Document, className: string, text: string): HTMLElement {
  const el = doc.createElement("p")
  el.className = className
  el.textContent = text
  return el
}

export function actionButton(
  doc: Document,
  label: string,
  className: string,
  onClick: () => void,
  disabled = false,
): HTMLButtonElement {
  const el = doc.createElement("button")
  el.type = "button"
  el.className = className
  el.textContent = label
  el.disabled = disabled
  el.addEventListener("click", onClick)
  return el
}

export function shareStateText(record: PublicationRecord | undefined): string {
  if (record === undefined) return "状態: 未公開"
  if (record.state === "pending") {
    return "状態: 公開手続き中（サーバーに仮保存済み・有効化待ち）"
  }
  return `状態: 公開中（${record.visibility === "public" ? "公開" : "限定公開"}）`
}

export function shareDirtyText(dirty: PublicationDirty | undefined): string {
  if (dirty === undefined) return ""
  switch (dirty.kind) {
    case "clean":
      return "最新の内容が公開されています"
    case "dirty":
      return "未公開の変更があります"
    case "unpublishable":
      if (dirty.reasons.some((reason) => reason.code === "empty-playlist")) {
        return "公開できません: プレイリストが空です"
      }
      return "範囲未設定の項目があるため公開できません"
    case "snapshot-invalid":
      return "保存済みの公開情報を確認できません"
    case "detached":
      return ""
  }
}

/** Human-readable outcome of a management reply for the result line. */
export function describeShareReply(reply: ShareManageReply): string {
  switch (reply.status) {
    case "published":
      if (reply.sourceState === "linked") {
        return "公開しました。元の公開プレイリストへのリンクを記録しました。"
      }
      if (reply.sourceState === "withheld") {
        return "公開しました。元の公開プレイリストは現在公開されていないため、ソースリンクは記録されませんでした。"
      }
      return "公開しました。"
    case "activated":
      return "公開が有効化されました。"
    case "updated":
      return "公開版を更新しました。"
    case "unchanged":
      return "公開版は最新です。変更はありません。"
    case "activate-pending":
      return "公開版を作成しましたが有効化できていません。「公開を完了する」で再開できます。"
    case "receipt-unavailable":
      return "前回の公開応答を回復できませんでした。新しい公開操作としてもう一度実行してください。"
    case "persist-failed":
      return reply.message ?? "ローカルへの保存に失敗しました。"
    case "unpublishable": {
      const reasons = reply.reasons ?? []
      if (reasons.some((reason) => reason.path === "items")) {
        return "公開できません: プレイリストが空です。範囲が設定された項目を追加してください。"
      }
      return `公開できない項目があります（${reasons.length === 0 ? 1 : reasons.length}件）。範囲未設定（全話再生）の項目は公開できません。`
    }
    case "conflict":
      return `リモートの公開版が変更されています${
        reply.remoteRevision === undefined ? "" : `（revision ${reply.remoteRevision}）`
      }。「状態を確認」してから再試行すると上書きします。`
    case "not-found":
      return "リモートの公開版が見つかりません（削除済み・期限切れ・または未公開）。"
    case "offline":
      return "ネットワークエラーまたはタイムアウトです。同じ操作として再試行できます。"
    case "invalid-state":
      return reply.message ?? "その状態では実行できません。"
    case "consent-required":
      return "共有機能が無効です。有効にすると共有サーバーとの通信を許可します。"
    default:
      return reply.message ?? "失敗しました。"
  }
}

/**
 * First-publish provenance preview line (task 20). The source title comes
 * from the LOCAL import record — private data, shown only to its owner.
 * "unknown" means the check could not complete; publish then aborts
 * retryably rather than dropping the link silently.
 */
export function describeSourceState(reply: ShareManageReply): string {
  const title = reply.sourceTitle
  const prefix = title === undefined || title === "" ? "インポート元" : `インポート元「${title}」`
  switch (reply.sourceState) {
    case "linked":
      return `${prefix}: 公開すると元の公開プレイリストへのリンクが記録されます。`
    case "withheld":
      return `${prefix}: 元の公開プレイリストは現在公開されていないため、リンクは記録されません。`
    case "unknown":
      return `${prefix}: 元の公開プレイリストの状態を確認できませんでした。`
    default:
      return ""
  }
}

/** Remote reconcile line after an inspect reply (dialog + detached rows). */
export function describeRemoteReply(reply: ShareManageReply): string {
  if (reply.status !== "inspect") return "確認できませんでした。"
  switch (reply.remote) {
    case "active":
      return `リモート: 公開中（revision ${reply.remoteRevision ?? "?"}）${
        reply.diverged === true ? " — ローカルの管理情報と異なります" : ""
      }`
    case "absent":
      return "リモートに公開版が見つかりません（削除済み・期限切れ・または未公開）。"
    default:
      return "リモートの状態を確認できませんでした（オフラインまたは一時的な障害）。"
  }
}

/** Preview of the projection that WOULD be sent — item count/total/title. */
export function publishPreviewText(
  playlist: LocalPlaylist | undefined,
  draft: ShareManageMetadata,
  fallbackVisibility: "public" | "unlisted" | undefined,
): string {
  if (playlist === undefined) return ""
  try {
    const projection = toPublishProjection(playlist, {
      visibility: draft.visibility ?? fallbackVisibility ?? "unlisted",
      ...(draft.description === undefined ? {} : { description: draft.description }),
      ...(draft.author === undefined ? {} : { author: draft.author }),
      tags: [...(draft.tags ?? [])],
    })
    const totalMs = projection.items.reduce(
      (sum, item) => sum + (item.range.end - item.range.start),
      0,
    )
    return `公開内容: ${projection.items.length}件 / 合計 ${formatSec(totalMs)} / タイトル「${projection.title}」`
  } catch (error) {
    const reasons = (error as UnpublishablePlaylistError).reasons
    if (Array.isArray(reasons) && reasons.some((reason) => reason.code === "empty-playlist")) {
      return "公開内容: プレイリストが空です"
    }
    return `公開できない項目があります（${Array.isArray(reasons) ? reasons.length : 1}件）。範囲未設定の項目は公開できません。`
  }
}

/** Visibility radios — explicit selection only; nothing is checked by default. */
export function visibilityFieldset(
  doc: Document,
  draft: ShareManageMetadata,
  onChange: (visibility: "public" | "unlisted") => void,
): HTMLElement {
  const fieldset = doc.createElement("fieldset")
  fieldset.className = "share-visibility"
  const legend = doc.createElement("legend")
  legend.textContent = "公開範囲（必須）"
  fieldset.appendChild(legend)
  for (const [value, label] of [
    ["public", "公開 — 検索・一覧に表示されます"],
    ["unlisted", "限定公開 — リンクを知っている人だけが開けます"],
  ] as const) {
    const labelEl = doc.createElement("label")
    const radio = doc.createElement("input")
    radio.type = "radio"
    radio.name = "dopShareVisibility"
    radio.value = value
    radio.checked = draft.visibility === value
    radio.addEventListener("change", () => onChange(value))
    labelEl.append(radio, doc.createTextNode(` ${label}`))
    fieldset.appendChild(labelEl)
  }
  return fieldset
}

/** Read the metadata form inside `container` into a ShareManageMetadata. */
export function readShareForm(container: HTMLElement): ShareManageMetadata {
  const visibility = container.querySelector<HTMLInputElement>(
    "input[name='dopShareVisibility']:checked",
  )?.value
  const description = container.querySelector<HTMLTextAreaElement>(".share-description")?.value
  const author = container.querySelector<HTMLInputElement>(".share-author")?.value
  const tagsRaw = container.querySelector<HTMLInputElement>(".share-tags")?.value
  return {
    ...(visibility === "public" || visibility === "unlisted" ? { visibility } : {}),
    ...(description === undefined ? {} : { description }),
    ...(author === undefined ? {} : { author }),
    ...(tagsRaw === undefined
      ? {}
      : { tags: tagsRaw.split(/[、,\s]+/).filter((tag) => tag.length > 0) }),
  }
}

/** Inline confirmation sub-view: warning text + confirm/cancel buttons. */
export function confirmRow(
  doc: Document,
  warning: string,
  confirmLabel: string,
  confirmClass: string,
  busy: boolean,
  onConfirm: () => void,
  onCancel: () => void,
): HTMLElement {
  const row = doc.createElement("div")
  row.className = "share-actions"
  row.append(
    line(doc, "share-confirm-text", warning),
    actionButton(doc, confirmLabel, `btn-danger-text ${confirmClass}`, onConfirm, busy),
    actionButton(doc, "キャンセル", "btn-text", onCancel, busy),
  )
  return row
}

/** Status block: state line, dirty badge, URL+copy row, last-updated, remote. */
export function statusBlock(
  doc: Document,
  record: PublicationRecord | undefined,
  dirty: PublicationDirty | undefined,
  remoteText: string,
  busy: boolean,
  onCopy: (shareId: string) => void,
): HTMLElement[] {
  const nodes: HTMLElement[] = [line(doc, "share-state", shareStateText(record))]
  if (dirty !== undefined) {
    nodes.push(line(doc, `share-dirty share-dirty-${dirty.kind}`, shareDirtyText(dirty)))
  }
  if (record !== undefined) {
    const url = sharePageUrl(record.shareId)
    const urlRow = doc.createElement("div")
    urlRow.className = "share-url-row"
    const link = doc.createElement("a")
    link.className = "share-url"
    link.href = url
    link.target = "_blank"
    link.rel = "noopener"
    link.textContent = url
    urlRow.appendChild(link)
    urlRow.appendChild(
      actionButton(doc, "コピー", "btn-text share-copy", () => onCopy(record.shareId), busy),
    )
    nodes.push(urlRow)
    nodes.push(
      line(doc, "share-updated", `最終更新: ${record.updatedAt}（revision ${record.revision}）`),
    )
  }
  nodes.push(line(doc, "share-remote", remoteText))
  return nodes
}

/** Metadata form section: visibility radios + description/author/tags + preview. */
export function metadataSection(
  doc: Document,
  playlist: LocalPlaylist | undefined,
  draft: ShareManageMetadata,
  fallbackVisibility: "public" | "unlisted" | undefined,
  onVisibility: (visibility: "public" | "unlisted") => void,
  onInput: () => void,
): HTMLElement[] {
  return [
    visibilityFieldset(doc, draft, onVisibility),
    metaField(doc, "説明", "share-description", draft.description ?? "", true, onInput),
    metaField(doc, "作者", "share-author", draft.author ?? "", false, onInput),
    metaField(
      doc,
      "タグ（空白・カンマ区切り）",
      "share-tags",
      (draft.tags ?? []).join(" "),
      false,
      onInput,
    ),
    line(doc, "share-preview", publishPreviewText(playlist, draft, fallbackVisibility)),
  ]
}

export function metaField(
  doc: Document,
  label: string,
  className: string,
  value: string,
  multiline: boolean,
  onInput: () => void,
): HTMLElement {
  const wrap = doc.createElement("label")
  wrap.className = "share-field"
  const span = doc.createElement("span")
  span.textContent = label
  const input = multiline ? doc.createElement("textarea") : doc.createElement("input")
  input.className = className
  if (input instanceof HTMLInputElement) input.type = "text"
  input.value = value
  input.addEventListener("input", onInput)
  wrap.append(span, input)
  return wrap
}
