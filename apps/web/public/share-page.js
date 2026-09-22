// Progressive enhancement for /p/:shareId (tasks 16+17). Served same-origin
// under `script-src 'self'` — no inline handlers anywhere. Everything here is
// an enhancement only: the page renders and reads fully with JavaScript off.
//
//   1. URL copy button -> navigator.clipboard + a visible status line. On
//      denial the canonical URL is printed so the user can copy manually.
//   2. Save handshake: the open button is enabled for EVERYONE (it is the
//      single entry point). A click with the extension marker present posts a
//      typed relay request to the extension content script; a click without
//      it reveals install guidance + store links. The message carries ONLY
//      shareId + requestId + protocol fields — never playlist JSON (the
//      extension fetches the snapshot itself). Replies are status-only acks
//      bound to requestId; the page never receives local library or
//      publication state. Keep these literals in sync with
//      apps/extension/src/share/protocol.ts.
;(() => {
  const copyButton = document.querySelector("[data-share-copy]")
  const copyStatus = document.querySelector("[data-share-copy-status]")
  if (copyButton instanceof HTMLButtonElement && copyStatus instanceof HTMLElement) {
    copyButton.disabled = false
    copyButton.removeAttribute("aria-disabled")
    copyButton.addEventListener("click", () => {
      const url = copyButton.getAttribute("data-copy-url") || location.href
      const clipboard = navigator.clipboard
      if (clipboard === undefined || typeof clipboard.writeText !== "function") {
        copyStatus.textContent = `コピーできません。URL: ${url}`
        return
      }
      clipboard.writeText(url).then(
        () => {
          copyStatus.textContent = "URLをコピーしました。"
        },
        () => {
          copyStatus.textContent = `コピーできませんでした。URL: ${url}`
        },
      )
    })
  }

  const saveButton = document.querySelector("[data-share-save]")
  const saveStatus = document.querySelector("[data-share-save-status]")
  if (!(saveButton instanceof HTMLButtonElement) || !(saveStatus instanceof HTMLElement)) {
    return
  }

  const PAGE_SOURCE = "d-op-share-page"
  const EXTENSION_SOURCE = "d-op-extension"
  const REQUEST_TYPE = "DOP_SHARE_IMPORT_REQUEST"
  const ACK_TYPE = "DOP_SHARE_IMPORT_ACK"
  const PROTOCOL_VERSION = 1
  const ACK_TIMEOUT_MS = 10_000
  const MARKER_GRACE_MS = 5_000

  const extensionPresent = () => document.documentElement.hasAttribute("data-dop-extension")

  const STATUS_READY = "d-OP 拡張機能を検出しました。共有ページから確認画面を開いて保存できます。"
  const STATUS_NEUTRAL = "d-OP 拡張機能で開いて保存します。"
  const STATUS_NEEDS_EXTENSION =
    "d-OP 拡張機能が見つかりません。インストール後、このページを再読み込みしてください。"
  const STATUS_ACK = {
    opened: "拡張機能の確認画面を開きました。内容を確認して保存してください。",
    duplicate: "このリクエストは受け付け済みです。拡張機能の画面を確認してください。",
    rejected: "保存リクエストを受け付けられませんでした。もう一度お試しください。",
    unavailable: "拡張機能と通信できませんでした。拡張機能の状態を確認してください。",
  }

  const storeLinks = document.querySelector("[data-share-stores]")
  const showStores = (visible) => {
    if (storeLinks instanceof HTMLElement) {
      storeLinks.hidden = !visible
    }
  }

  const markReady = () => {
    saveStatus.textContent = STATUS_READY
    showStores(false)
  }

  // Enable unconditionally: the button is the single entry point. Without the
  // extension marker a click reveals install guidance instead of dead-ending.
  saveButton.disabled = false
  saveButton.removeAttribute("aria-disabled")
  if (extensionPresent()) {
    markReady()
  } else {
    saveStatus.textContent = STATUS_NEUTRAL
    showStores(false)
    // The content script sets the marker at document_start, before deferred
    // scripts run — but observe briefly anyway so a late injection still works.
    const observer = new MutationObserver(() => {
      if (extensionPresent()) {
        markReady()
        observer.disconnect()
      }
    })
    observer.observe(document.documentElement, { attributes: true })
    setTimeout(() => observer.disconnect(), MARKER_GRACE_MS)
  }

  saveButton.addEventListener("click", () => {
    if (!extensionPresent()) {
      saveStatus.textContent = STATUS_NEEDS_EXTENSION
      showStores(true)
      return
    }
    const shareId = saveButton.getAttribute("data-share-id")
    if (!shareId) return
    const requestId = crypto.randomUUID()
    saveButton.disabled = true

    const finish = (text) => {
      window.removeEventListener("message", onMessage)
      clearTimeout(timer)
      saveButton.disabled = false
      saveStatus.textContent = text
    }
    const onMessage = (event) => {
      // Same-window + same-origin only; correlate strictly by requestId and
      // read nothing but the ack status.
      if (event.source !== window || event.origin !== location.origin) return
      const data = event.data
      if (
        !data ||
        data.source !== EXTENSION_SOURCE ||
        data.type !== ACK_TYPE ||
        data.version !== PROTOCOL_VERSION ||
        data.requestId !== requestId
      ) {
        return
      }
      finish(STATUS_ACK[data.status] || STATUS_ACK.rejected)
    }
    const timer = setTimeout(() => {
      finish(STATUS_ACK.unavailable)
    }, ACK_TIMEOUT_MS)
    window.addEventListener("message", onMessage)
    window.postMessage(
      {
        source: PAGE_SOURCE,
        type: REQUEST_TYPE,
        version: PROTOCOL_VERSION,
        shareId,
        requestId,
      },
      location.origin,
    )
  })
})()
