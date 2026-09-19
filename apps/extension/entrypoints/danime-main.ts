import { defineUnlistedScript } from "wxt/utils/define-unlisted-script"
import { chaptersEnvelope, parsePageEnvelope, readyEnvelope } from "../src/adapter/bridge"
import { createDAnimeAdapter } from "../src/adapter/danime-adapter"

type PageWindow = Window & { readonly vc?: unknown }
type LifecycleWindow = PageWindow & { __dOpDAnimeMainDispose?: () => void }

export default defineUnlistedScript(() => {
  const pageWindow = window as LifecycleWindow
  pageWindow.__dOpDAnimeMainDispose?.()
  const origin = window.location.origin
  const adapter = createDAnimeAdapter({
    getVc: () => pageWindow.vc,
    getVideo: () => document.querySelector("video") ?? undefined,
    getNextButton: () =>
      document.querySelector<HTMLButtonElement>(".buttonArea .next") ?? undefined,
  })
  const deadline = Date.now() + 15_000

  const send = (message: unknown): void => window.postMessage(message, origin)

  const pollChapters = (): void => {
    const result = adapter.readChapters()
    if (result.kind === "ready") {
      send(
        chaptersEnvelope({
          source: "d-op-injected",
          chapters: [...result.chapters],
          durationMs: result.durationMs,
        }),
      )
      return
    }
    if (Date.now() < deadline) adapter.schedule(pollChapters, 500)
  }

  const onMessage = (event: MessageEvent<unknown>): void => {
    const parsed = parsePageEnvelope(event.data, event, origin, window)
    if (parsed.kind !== "command") return
    switch (parsed.payload.type) {
      case "SEEK":
        adapter.seek(parsed.payload.timeMs)
        break
      case "PLAY":
        void adapter.play()
        break
      case "PAUSE":
        adapter.pause()
        break
      case "BLOCK_AUTO_ADVANCE":
        adapter.setAutoAdvanceBlocked(true)
        break
      case "UNBLOCK_AUTO_ADVANCE":
        adapter.setAutoAdvanceBlocked(false)
        break
      case "GO_NEXT":
        adapter.goNext()
        break
      default: {
        const exhaustive: never = parsed.payload
        void exhaustive
        return
      }
    }
  }
  const dispose = (): void => {
    window.removeEventListener("message", onMessage)
    window.removeEventListener("pagehide", dispose)
    adapter.dispose()
    if (pageWindow.__dOpDAnimeMainDispose === dispose) delete pageWindow.__dOpDAnimeMainDispose
  }
  pageWindow.__dOpDAnimeMainDispose = dispose
  window.addEventListener("message", onMessage)
  window.addEventListener("pagehide", dispose)
  send(readyEnvelope())
  pollChapters()
})
