// Task 22: the Share consent section on the privileged options page. Renders
// the persisted decision (vault read) with the explicit choice buttons —
// 有効にする / 利用しない / 無効にする — and a link to the privacy page.
// Ordinary local use never needs this; undecided and declined both emit zero
// Share traffic. Writes go through writeShareConsent (repository single
// writer + the Firefox ≥140 native prompt on grant).
import type { ShareConsent } from "../../../../packages/shared/src/local-model"
import { type DataPermissions, writeShareConsent } from "../share/consent"
import { shareSiteUrl } from "../share/origins"
import type { UiStorageClient } from "./storage-client"

export type ShareConsentSectionDeps = {
  readonly doc: Document
  readonly storage: Pick<UiStorageClient, "readPublic" | "readVault" | "dispatch">
  readonly dataPermissions?: DataPermissions | undefined
  readonly newId: () => string
  readonly now?: (() => string) | undefined
  readonly showStatus: (text: string, type?: "success" | "error") => void
  readonly log?: ((label: string, data?: unknown) => void) | undefined
  /** Re-render the options page after a committed decision. */
  readonly onChanged?: (() => void) | undefined
}

export type ShareConsentSection = {
  readonly render: (container: HTMLElement | null) => Promise<void>
}

const DESCRIPTION =
  "共有機能を有効にすると、明示的な操作（公開・更新・削除・取り込み）のときだけ " +
  "d-op.sasnews.dev と通信します。送信されるのは公開用スナップショット（タイトル・" +
  "説明・作者名・タグ・各クリップの情報）と匿名の取り込み通知のみです。" +
  "自動同期は行いません。プレイリストの通常利用は完全にローカルで完結します。"

function consentText(consent: ShareConsent | undefined): string {
  if (consent === undefined) return "未設定"
  if (consent.choice === "granted") return "有効"
  return "無効"
}

export function createShareConsentSection(deps: ShareConsentSectionDeps): ShareConsentSection {
  const { doc } = deps
  let busy = false

  const decide = async (choice: "granted" | "declined"): Promise<void> => {
    busy = true
    try {
      const result = await writeShareConsent(
        deps.storage,
        deps.dataPermissions,
        choice,
        deps.newId,
        deps.now ?? (() => new Date().toISOString()),
      )
      if (result === "written") {
        deps.showStatus(
          choice === "granted" ? "共有機能を有効にしました。" : "共有機能を無効にしました。",
        )
      } else if (result === "native-denied") {
        deps.showStatus(
          "ブラウザのデータ収集設定で許可されませんでした。共有機能は無効のままです。",
          "error",
        )
      } else {
        deps.showStatus("設定の保存に失敗しました。", "error")
      }
    } catch (error) {
      deps.log?.("share-consent-write-failed", error)
      deps.showStatus("設定の保存に失敗しました。", "error")
    } finally {
      busy = false
      deps.onChanged?.()
    }
  }

  const button = (
    label: string,
    testid: string,
    className: string,
    onClick: () => void,
  ): HTMLButtonElement => {
    const element = doc.createElement("button")
    element.type = "button"
    element.className = className
    element.dataset["testid"] = testid
    element.textContent = label
    element.disabled = busy
    element.addEventListener("click", onClick)
    return element
  }

  async function render(container: HTMLElement | null): Promise<void> {
    if (container === null) return
    let consent: ShareConsent | undefined
    try {
      consent = (await deps.storage.readVault()).shareConsent
    } catch (error) {
      deps.log?.("consent-vault-read-failed", error)
      consent = undefined
    }
    container.replaceChildren()

    // Compact settings row — the standalone 共有機能 section was folded into
    // 設定 so the page stays scannable; testids and decision keywords stay.
    const row = doc.createElement("div")
    row.className = "setting-row consent-row"
    const label = doc.createElement("span")
    label.className = "setting-label"
    label.textContent = "共有機能"
    const status = doc.createElement("span")
    status.className = `consent-status consent-status-${consent?.choice ?? "unset"}`
    status.dataset["testid"] = "share-consent-status"
    status.textContent = consentText(consent)

    const actions = doc.createElement("div")
    actions.className = "consent-actions"
    if (consent === undefined) {
      actions.append(
        button("有効にする", "share-consent-grant", "btn-secondary", () => void decide("granted")),
        button("利用しない", "share-consent-decline", "btn-text", () => void decide("declined")),
      )
    } else if (consent.choice === "granted") {
      actions.append(
        button(
          "無効にする",
          "share-consent-revoke",
          "btn-secondary",
          () => void decide("declined"),
        ),
      )
    } else {
      actions.append(
        button("有効にする", "share-consent-grant", "btn-secondary", () => void decide("granted")),
      )
    }
    row.append(label, status, actions)

    const desc = doc.createElement("p")
    desc.className = "setting-desc consent-desc"
    const link = doc.createElement("a")
    link.href = shareSiteUrl("/privacy")
    link.target = "_blank"
    link.rel = "noopener"
    link.dataset["testid"] = "share-consent-privacy"
    link.textContent = "プライバシーポリシー"
    desc.append(
      DESCRIPTION +
        (consent?.choice === "granted" ? "無効にしても公開済みの共有は削除されません。" : ""),
      "送信内容の詳細は ",
      link,
      " を参照してください。",
    )

    container.append(row, desc)
  }

  return { render }
}
