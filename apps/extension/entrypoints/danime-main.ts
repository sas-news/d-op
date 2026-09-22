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
  const send = (message: unknown): void => window.postMessage(message, origin)

  // Episode-change redelivery (v1 injected.js poll/MutationObserver parity):
  // d-Anime advances episodes SPA-style — location.href changes and
  // ws010105Data is swapped in place without a page reload. Without the URL
  // watcher the next episode's chapters never reach the isolated world and
  // OP/ED markers stay stuck on the previous episode.
  const MAX_POLL_COUNT = 30 // 500 ms × 30 = 15 s per round (v1 parity)
  let pollCount = 0
  let polling = false
  let lastKey: string | null = null
  let lastUrl = window.location.href

  /** Identity for "is this a new episode's chapter set": ws010105Data.partId
   *  when present (v1's key), else a bounds fingerprint so an episode whose
   *  data lacks partId still re-sends when the chapters actually differ. */
  const identityOf = (
    result: Extract<ReturnType<typeof adapter.readChapters>, { kind: "ready" }>,
  ) => {
    if (result.partId !== undefined) return `p:${result.partId}`
    const first = result.chapters[0]
    const last = result.chapters[result.chapters.length - 1]
    return `c:${result.chapters.length}:${first?.startMs ?? ""}-${last?.endMs ?? ""}`
  }

  const pollChapters = (): void => {
    polling = false
    pollCount += 1
    const result = adapter.readChapters()
    if (result.kind === "ready") {
      const key = identityOf(result)
      if (key !== lastKey) {
        lastKey = key
        send(
          chaptersEnvelope({
            source: "d-op-injected",
            chapters: [...result.chapters],
            durationMs: result.durationMs,
          }),
        )
        return // round complete — the URL observer restarts on navigation
      }
    }
    if (pollCount < MAX_POLL_COUNT) {
      polling = true
      adapter.schedule(pollChapters, 500)
    }
  }

  // v1: on location.href change, reset lastPartId and start a fresh round —
  // if a round is already in flight it just keeps running and the reset key
  // makes the next tick send immediately.
  const urlObserver = new MutationObserver(() => {
    if (window.location.href === lastUrl) return
    lastUrl = window.location.href
    lastKey = null
    if (!polling) {
      pollCount = 0
      polling = true
      adapter.schedule(pollChapters, 500)
    }
  })
  urlObserver.observe(document, { subtree: true, childList: true })

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
    urlObserver.disconnect()
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
