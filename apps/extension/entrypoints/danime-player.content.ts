import { defineContentScript } from "wxt/utils/define-content-script"
import { injectScript } from "#imports"
import "../src/player/player.css"
import { type ChaptersFound, PlayerCommandSchema } from "../../../packages/shared/src/index"
import { sendPageCommand } from "../src/adapter/isolated-bridge"
import { installIsolatedBridge } from "../src/adapter/isolated-runtime"
import { OPED_SESSION_FLAG } from "../src/player/constants"
import { createModalHost } from "../src/player/modal"
import { createPlayerOrchestrator } from "../src/player/orchestrator"
import { createPlayerStorageClient } from "../src/player/storage-client"
import { createPlayerUi } from "../src/player/ui"

type BridgeEventDetail =
  | { readonly kind: "ready" }
  | { readonly kind: "chapters"; readonly payload: ChaptersFound }
  | { readonly kind: "command"; readonly payload: unknown }
  | { readonly kind: "rejected" }

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match?.[1] === undefined ? null : decodeURIComponent(match[1])
}

export default defineContentScript({
  matches: [
    "https://animestore.docomo.ne.jp/animestore/sc_d_pc*",
    "https://anime.dmkt-sp.jp/animestore/sc_d_pc*",
  ],
  runAt: "document_start",
  async main() {
    // Isolated world: never touches window.vc. Commands cross to the
    // main-world adapter through the validated postMessage bridge only.
    const disposeBridge = await installIsolatedBridge(window, async () => {
      await injectScript("/danime-main.js", { keepInDom: true })
    })
    const storage = createPlayerStorageClient((message) => browser.runtime.sendMessage(message))
    const modal = createModalHost(document)
    const getVideo = (): HTMLVideoElement | undefined => {
      const video = document.getElementById("video")
      return video instanceof HTMLVideoElement ? video : undefined
    }
    // ui callbacks reference the orchestrator and the orchestrator's render
    // dep references ui — resolved via this forward reference.
    let orchestrator: ReturnType<typeof createPlayerOrchestrator>
    const ui = createPlayerUi(document, {
      onPrev: () => void orchestrator.handleCommand({ type: "PLAYLIST_PREV" }),
      onNext: () => void orchestrator.handleCommand({ type: "PLAYLIST_NEXT" }),
      onStop: () => void orchestrator.handleCommand({ type: "PLAYLIST_STOP" }),
      onCustomDraft: (patch) => orchestrator.customPreview.updateDraft(patch),
      onCustomTest: () => void orchestrator.customPreview.test(),
      onCustomCancel: () => void orchestrator.customPreview.cancel(),
      getVideo,
      schedule: (callback, ms) => window.setTimeout(callback, ms),
      cancelTimer: (timer) => window.clearTimeout(timer as number),
    })
    orchestrator = createPlayerOrchestrator({
      now: () => Date.now(),
      newOwnerToken: () => crypto.randomUUID(),
      getVideo,
      sendPageCommand: (command) => sendPageCommand(command, window),
      storage,
      requestPlayer: (url) => browser.runtime.sendMessage({ kind: "REQUEST_PLAYER", url }),
      getCookie,
      setCookie: (name, value) => {
        // biome-ignore lint/suspicious/noDocumentCookie: the auto-advance pause flag is a real cookie contract inherited from legacy content.js
        document.cookie = `${name}=${encodeURIComponent(value)}; path=/; SameSite=Lax`
      },
      getOpEdSessionFlag: () => sessionStorage.getItem(OPED_SESSION_FLAG) === "1",
      setOpEdSessionFlag: (active) => {
        if (active) sessionStorage.setItem(OPED_SESSION_FLAG, "1")
        else sessionStorage.removeItem(OPED_SESSION_FLAG)
      },
      currentUrl: () => window.location.href,
      replaceUrl: (url) => window.history.replaceState(null, "", url),
      schedule: (callback, ms) => window.setTimeout(callback, ms),
      cancelTimer: (timer) => window.clearTimeout(timer as number),
      showModal: (request) => modal.show(request),
      render: (snapshot) => ui.render(snapshot),
    })

    const onBridgeEvent = (event: Event): void => {
      const detail = (event as CustomEvent<BridgeEventDetail>).detail
      if (detail?.kind === "chapters") void orchestrator.handleChapters(detail.payload)
    }
    window.addEventListener("d-op-player-bridge", onBridgeEvent)

    const onRuntimeMessage = (message: unknown): void => {
      const parsed = PlayerCommandSchema.safeParse(message)
      if (parsed.success) void orchestrator.handleCommand(parsed.data)
    }
    browser.runtime.onMessage.addListener(onRuntimeMessage)

    const observer = new MutationObserver(() => orchestrator.handleDomMutation())
    observer.observe(document.documentElement, { childList: true, subtree: true })

    const dispose = (): void => {
      observer.disconnect()
      window.removeEventListener("d-op-player-bridge", onBridgeEvent)
      browser.runtime.onMessage.removeListener(onRuntimeMessage)
      orchestrator.dispose()
      ui.dispose()
      modal.dispose()
      disposeBridge()
    }
    window.addEventListener("pagehide", dispose, { once: true })
  },
})
