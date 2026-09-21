// Progressive enhancement for /p/:shareId (task 16). Served same-origin under
// `script-src 'self'` — no inline handlers anywhere. Everything here is an
// enhancement only: the page renders and reads fully with JavaScript off.
//
//   1. URL copy button -> navigator.clipboard + a visible status line. On
//      denial the canonical URL is printed so the user can copy manually.
//   2. Save-panel guidance: when the d-OP extension advertises itself via the
//      data-dop-extension marker on <html>, the status copy updates. The
//      task-17 save handshake is NOT implemented — the button stays disabled.
;(() => {
  const copyButton = document.querySelector("[data-share-copy]")
  const copyStatus = document.querySelector("[data-share-copy-status]")
  if (copyButton instanceof HTMLButtonElement && copyStatus instanceof HTMLElement) {
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

  const saveStatus = document.querySelector("[data-share-save-status]")
  if (
    saveStatus instanceof HTMLElement &&
    document.documentElement.hasAttribute("data-dop-extension")
  ) {
    saveStatus.textContent =
      "d-OP 拡張機能を検出しました。共有プレイリストの保存は拡張機能の画面から行えます。"
  }
})()
