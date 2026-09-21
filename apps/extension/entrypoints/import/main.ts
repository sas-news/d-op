import { browser } from "wxt/browser"
import {
  formatTotalMs,
  readImportToken,
  requestImportCancel,
  requestImportConfirm,
  requestImportDetails,
} from "../../src/share/import-page"

// Extension-owned import confirmation window (task 17). The ?t=<token> query
// parameter is the only input — the token is minted by the background and
// carries no data by itself. The page only ever renders the fetched preview
// (title/items/total) and explicit user confirm/cancel. No autoplay anywhere.

const ERROR_TEXT: Record<string, string> = {
  expired: "このリクエストは期限切れか、すでに処理済みです。共有ページからもう一度お試しください。",
  "not-found": "共有プレイリストが見つかりませんでした。削除された可能性があります。",
  "rate-limited": "リクエストが集中しています。しばらくしてからもう一度お試しください。",
  "invalid-response": "共有データを読み取れませんでした。",
  "too-large": "共有データが大きすぎるため保存できません。",
  network: "ネットワークに接続できませんでした。",
  forbidden: "このリクエストは許可されていません。",
  unavailable: "拡張機能が応答しませんでした。",
}

const $ = (id: string): HTMLElement | null => document.getElementById(id)
const status = $("import-status")
const preview = $("import-preview")
const confirmButton = $("import-confirm")
const cancelButton = $("import-cancel")

const send = (message: unknown) => browser.runtime.sendMessage(message)
const errorText = (reason: string): string => ERROR_TEXT[reason] ?? "拡張機能が応答しませんでした。"

function showError(reason: string): void {
  if (status) status.textContent = errorText(reason)
  if (confirmButton instanceof HTMLButtonElement) confirmButton.disabled = true
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

  const details = await requestImportDetails(send, token)
  if (details.kind === "error") {
    showError(details.reason)
    return
  }
  const { preview: view } = details
  const title = $("import-title")
  const count = $("import-count")
  const duration = $("import-duration")
  const author = $("import-author")
  if (title) title.textContent = view.title
  if (count) count.textContent = `${view.itemCount} 件`
  if (duration) duration.textContent = formatTotalMs(view.totalDurationMs)
  if (author) author.textContent = view.author === "" ? "（匿名）" : view.author
  preview.hidden = false
  status.textContent = "内容を確認して保存してください。"
  confirmButton.disabled = false

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
      showError(result.status === "failed" ? result.reason : "unavailable")
      cancelButton.disabled = false
    })
  })
  cancelButton.addEventListener("click", () => {
    cancelButton.disabled = true
    void requestImportCancel(send, token).finally(() => window.close())
  })
}

void start()
