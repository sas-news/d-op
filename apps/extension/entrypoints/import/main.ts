import { browser } from "wxt/browser"
import { requestShareDataPermissions } from "../../src/share/consent"
import {
  type DetailsResult,
  formatTotalMs,
  readImportToken,
  requestImportCancel,
  requestImportConfirm,
  requestImportConsent,
  requestImportDetails,
} from "../../src/share/import-page"
import type { ShareImportPreview } from "../../src/share/protocol"

// Extension-owned import confirmation window (task 17). The ?t=<token> query
// parameter is the only input — the token is minted by the background and
// carries no data by itself. The page only ever renders the fetched preview
// (title/items/total) and explicit user confirm/cancel. No autoplay anywhere.
//
// Task 22: while Share consent is undecided the background answers the
// details request with "consent-required" instead of fetching — this page
// then renders the explicit consent block. The decision is reported back via
// the share-import-consent message; the background persists it through the
// repository (the page never writes storage) and either returns the preview
// or settles the request cancelled.

const ERROR_TEXT: Record<string, string> = {
  expired: "このリクエストは期限切れか、すでに処理済みです。共有ページからもう一度お試しください。",
  "not-found": "共有プレイリストが見つかりませんでした。削除された可能性があります。",
  "rate-limited": "リクエストが集中しています。しばらくしてからもう一度お試しください。",
  "invalid-response": "共有データを読み取れませんでした。",
  "too-large": "共有データが大きすぎるため保存できません。",
  network: "ネットワークに接続できませんでした。",
  forbidden: "このリクエストは許可されていません。",
  "consent-declined": "共有機能は無効です。ローカルの機能はそのまま利用できます。",
  "consent-required": "共有機能の同意が必要です。",
  unavailable: "拡張機能が応答しませんでした。",
}

const $ = (id: string): HTMLElement | null => document.getElementById(id)
const status = $("import-status")
const preview = $("import-preview")
const consentBox = $("import-consent")
const confirmButton = $("import-confirm")
const cancelButton = $("import-cancel")
const grantButton = $("import-consent-grant")
const declineButton = $("import-consent-decline")

const send = (message: unknown) => browser.runtime.sendMessage(message)
const errorText = (reason: string): string => ERROR_TEXT[reason] ?? "拡張機能が応答しませんでした。"

// Firefox ≥140 native data-consent surface; absent key → the in-extension
// decision alone gates (see src/share/consent.ts).
const dataPermissions = {
  getAll: () =>
    browser.permissions.getAll() as Promise<{
      data_collection?: readonly string[]
    }>,
  request: (permissions: { readonly data_collection: readonly string[] }) =>
    browser.permissions.request(permissions as Parameters<typeof browser.permissions.request>[0]),
}

function showError(reason: string): void {
  if (status) status.textContent = errorText(reason)
  if (confirmButton instanceof HTMLButtonElement) confirmButton.disabled = true
}

function showPreview(view: ShareImportPreview): void {
  const title = $("import-title")
  const count = $("import-count")
  const duration = $("import-duration")
  const author = $("import-author")
  if (title) title.textContent = view.title
  if (count) count.textContent = `${view.itemCount} 件`
  if (duration) duration.textContent = formatTotalMs(view.totalDurationMs)
  if (author) author.textContent = view.author === "" ? "（匿名）" : view.author
  if (consentBox) consentBox.hidden = true
  if (preview) preview.hidden = false
  if (status) status.textContent = "内容を確認して保存してください。"
  if (confirmButton instanceof HTMLButtonElement) confirmButton.disabled = false
}

async function start(): Promise<void> {
  const token = readImportToken(window.location.search)
  if (
    token === undefined ||
    !(confirmButton instanceof HTMLButtonElement) ||
    !(cancelButton instanceof HTMLButtonElement) ||
    status === null ||
    preview === null
  ) {
    if (status) status.textContent = "無効なリクエストです。"
    return
  }

  /** Consent prompt: details/confirm replies with "consent-required" land
   *  here — nothing has been (or will be) fetched before an explicit grant. */
  const showConsent = (): void => {
    preview.hidden = true
    if (consentBox) consentBox.hidden = false
    status.textContent = "共有機能を有効にするか選択してください。"
  }

  /** Shared handling for the initial details reply AND the post-consent
   *  reply (same preview/error union). */
  const applyDetails = (details: DetailsResult): void => {
    if (details.kind === "error") {
      if (details.reason === "consent-required") {
        showConsent()
        return
      }
      showError(details.reason)
      return
    }
    showPreview(details.preview)
  }

  if (grantButton instanceof HTMLButtonElement) {
    grantButton.addEventListener("click", () => {
      grantButton.disabled = true
      if (declineButton instanceof HTMLButtonElement) declineButton.disabled = true
      status.textContent = "確認しています…"
      void (async () => {
        // Firefox ≥140: the native data-consent prompt runs on this user
        // gesture; denial leaves the extension decision undecided.
        const nativeOk = await requestShareDataPermissions(dataPermissions)
        if (!nativeOk) {
          status.textContent =
            "ブラウザのデータ収集設定で許可されませんでした。共有機能は無効のままです。"
          grantButton.disabled = false
          if (declineButton instanceof HTMLButtonElement) declineButton.disabled = false
          return
        }
        applyDetails(await requestImportConsent(send, token, "granted"))
        grantButton.disabled = false
        if (declineButton instanceof HTMLButtonElement) declineButton.disabled = false
      })()
    })
  }
  if (declineButton instanceof HTMLButtonElement) {
    declineButton.addEventListener("click", () => {
      declineButton.disabled = true
      if (grantButton instanceof HTMLButtonElement) grantButton.disabled = true
      void requestImportConsent(send, token, "declined").then(() => {
        if (consentBox) consentBox.hidden = true
        status.textContent =
          "共有機能は無効です。ローカルの機能はそのまま利用できます。このウィンドウを閉じてください。"
        confirmButton.disabled = true
        cancelButton.textContent = "閉じる"
      })
    })
  }

  confirmButton.addEventListener("click", () => {
    confirmButton.disabled = true
    cancelButton.disabled = true
    status.textContent = "保存しています…"
    void requestImportConfirm(send, token).then((result) => {
      if (result.status === "committed") {
        status.textContent = `「${result.title}」を保存しました。`
        cancelButton.textContent = "閉じる"
        cancelButton.disabled = false
        return
      }
      const reason = result.status === "failed" ? result.reason : "unavailable"
      // A revocation between preview and confirm re-asks consent rather
      // than failing opaquely.
      if (reason === "consent-required") {
        showConsent()
        cancelButton.disabled = false
        return
      }
      showError(reason)
      cancelButton.disabled = false
    })
  })
  cancelButton.addEventListener("click", () => {
    cancelButton.disabled = true
    void requestImportCancel(send, token).finally(() => window.close())
  })

  applyDetails(await requestImportDetails(send, token))
}

void start()
