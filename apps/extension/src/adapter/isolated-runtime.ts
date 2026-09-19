import { parsePageEnvelope } from "./bridge"

type InjectMain = () => Promise<void>

export async function installIsolatedBridge(
  pageWindow: Window,
  injectMain: InjectMain,
): Promise<() => void> {
  let disposed = false
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (disposed || event.origin !== pageWindow.location.origin || event.source !== pageWindow)
      return
    const parsed = parsePageEnvelope(event.data, event, pageWindow.location.origin, pageWindow)
    if (parsed.kind !== "ready" && parsed.kind !== "chapters") return
    pageWindow.dispatchEvent(new CustomEvent("d-op-player-bridge", { detail: parsed }))
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    pageWindow.removeEventListener("message", onMessage)
    pageWindow.removeEventListener("pagehide", dispose)
  }
  pageWindow.addEventListener("message", onMessage)
  pageWindow.addEventListener("pagehide", dispose)
  try {
    await injectMain()
  } catch (error) {
    dispose()
    throw error
  }
  return dispose
}
