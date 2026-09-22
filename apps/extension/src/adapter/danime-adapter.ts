import type { Chapter } from "./chapter-parser"

// ws010105Data.duration is ABSENT on the live site (verified 2026-09-22) —
// v1 tolerated it (`data.duration || null`) and used video.duration for the
// naming heuristic, so the contract is: chapters array required, duration
// derived from the <video> element when ready.
type PlayerData = { readonly chapters?: readonly unknown[]; readonly partId?: unknown }
type Player = {
  readonly jump?: unknown
  goNext?: unknown
  procEndedEvent?: unknown
  readonly ws010105Data?: unknown
  sentPauseResumeTimerId?: unknown
}
type Video = {
  currentTime: number
  paused: boolean
  /** HTMLVideoElement.duration — NaN until metadata is ready. */
  readonly duration?: number
  play: () => Promise<void>
  pause: () => void
}
type Timer = number
type NativeMethod = (...args: readonly unknown[]) => unknown
const MAX_TIME_MS = 86_400_000
type AdapterOptions = {
  readonly getVc: () => unknown
  readonly getVideo: () => Video | undefined
  readonly getNextButton?: () =>
    | { readonly disabled: boolean; readonly click: () => void }
    | undefined
  readonly setTimer?: (callback: () => void, ms: number) => Timer
  readonly clearTimer?: (timer: Timer) => void
}
export type AdapterResult =
  | { readonly kind: "ok" }
  | { readonly kind: "missing-player" }
  | { readonly kind: "command-failed"; readonly command: "PLAY" | "PAUSE" | "SEEK" | "GO_NEXT" }
  | { readonly kind: "disposed" }
export type ChapterResult =
  | {
      readonly kind: "ready"
      readonly chapters: readonly Chapter[]
      readonly durationMs: number | undefined
      /** ws010105Data.partId — episode identity for change detection. */
      readonly partId: string | undefined
    }
  | { readonly kind: "unavailable" }
  | { readonly kind: "disposed" }

function isNativeMethod(value: unknown): value is NativeMethod {
  return typeof value === "function"
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function createDAnimeAdapter(options: AdapterOptions) {
  const timers = new Set<Timer>()
  const setTimer = options.setTimer ?? ((callback, ms) => window.setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? ((timer) => window.clearTimeout(timer))
  let disposed = false
  let originalGoNext: ((...args: readonly unknown[]) => unknown) | undefined
  let originalProcEnded: ((...args: readonly unknown[]) => unknown) | undefined
  let hookedPlayer: Player | undefined

  function readChapters(): ChapterResult {
    if (disposed) return { kind: "disposed" }
    const player = options.getVc()
    if (!record(player) || !record(player["ws010105Data"])) return { kind: "unavailable" }
    const data = player["ws010105Data"] as PlayerData
    if (!Array.isArray(data["chapters"])) return { kind: "unavailable" }
    const chapters: Chapter[] = []
    for (const item of data["chapters"]) {
      if (!record(item)) return { kind: "unavailable" }
      const start = item["start"]
      const end = item["end"]
      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start
      )
        return { kind: "unavailable" }
      const type = item["type"]
      chapters.push({
        startMs: start,
        endMs: end,
        type: typeof type === "string" ? type : undefined,
      })
    }
    // Naming heuristic duration comes from the video element, exactly like
    // v1 (video.duration seconds -> ms). Not ready yet -> absent; consumers
    // re-read live video.duration anyway.
    const video = options.getVideo()
    const videoDuration = video?.duration
    const durationMs =
      typeof videoDuration === "number" && Number.isFinite(videoDuration) && videoDuration > 0
        ? Math.round(videoDuration * 1000)
        : undefined
    const rawPartId = data["partId"]
    const partId =
      typeof rawPartId === "string"
        ? rawPartId
        : typeof rawPartId === "number" && Number.isFinite(rawPartId)
          ? String(rawPartId)
          : undefined
    return { kind: "ready", chapters, durationMs, partId }
  }

  function seek(timeMs: number): AdapterResult {
    if (disposed) return { kind: "disposed" }
    if (!Number.isSafeInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME_MS)
      return { kind: "command-failed", command: "SEEK" }
    const seconds = timeMs / 1000
    const player = options.getVc()
    if (record(player) && typeof player["jump"] === "function") {
      try {
        player["jump"](seconds)
        return { kind: "ok" }
      } catch {
        return { kind: "command-failed", command: "SEEK" }
      }
    }
    const video = options.getVideo()
    if (!video) return { kind: "missing-player" }
    try {
      video.currentTime = seconds
      return { kind: "ok" }
    } catch {
      return { kind: "command-failed", command: "SEEK" }
    }
  }

  async function play(): Promise<AdapterResult> {
    if (disposed) return { kind: "disposed" }
    const video = options.getVideo()
    if (!video) return { kind: "missing-player" }
    if (!video.paused) return { kind: "ok" }
    try {
      await video.play()
      return { kind: "ok" }
    } catch {
      return { kind: "command-failed", command: "PLAY" }
    }
  }

  function pause(): AdapterResult {
    if (disposed) return { kind: "disposed" }
    const video = options.getVideo()
    if (!video) return { kind: "missing-player" }
    try {
      video.pause()
      return { kind: "ok" }
    } catch {
      return { kind: "command-failed", command: "PAUSE" }
    }
  }

  function setAutoAdvanceBlocked(blocked: boolean): AdapterResult {
    if (disposed) return { kind: "disposed" }
    const player = options.getVc()
    if (!record(player)) return { kind: "missing-player" }
    const candidateGoNext = player["goNext"]
    const candidateProcEnded = player["procEndedEvent"]
    if (hookedPlayer && hookedPlayer !== player) {
      if (originalGoNext) hookedPlayer["goNext"] = originalGoNext
      if (originalProcEnded) hookedPlayer["procEndedEvent"] = originalProcEnded
      hookedPlayer = undefined
      originalGoNext = undefined
      originalProcEnded = undefined
    }
    if (!hookedPlayer) {
      hookedPlayer = player
      if (isNativeMethod(candidateGoNext)) originalGoNext = candidateGoNext
      if (isNativeMethod(candidateProcEnded)) originalProcEnded = candidateProcEnded
    }
    if (blocked) {
      if (originalGoNext) player["goNext"] = () => undefined
      if (originalProcEnded) player["procEndedEvent"] = () => undefined
    } else {
      if (originalGoNext) player["goNext"] = originalGoNext
      if (originalProcEnded) player["procEndedEvent"] = originalProcEnded
    }
    return { kind: "ok" }
  }

  function goNext(): AdapterResult {
    if (disposed) return { kind: "disposed" }
    const player = options.getVc()
    if (record(player) && typeof player["goNext"] === "function") {
      try {
        player["goNext"]()
        return { kind: "ok" }
      } catch {
        return { kind: "command-failed", command: "GO_NEXT" }
      }
    }
    const button = options.getNextButton?.()
    if (!button || button.disabled) return { kind: "missing-player" }
    try {
      button.click()
      return { kind: "ok" }
    } catch {
      return { kind: "command-failed", command: "GO_NEXT" }
    }
  }

  function dispose(): AdapterResult {
    if (disposed) return { kind: "disposed" }
    disposed = true
    for (const timer of timers) clearTimer(timer)
    timers.clear()
    if (hookedPlayer) {
      if (originalGoNext) hookedPlayer["goNext"] = originalGoNext
      if (originalProcEnded) hookedPlayer["procEndedEvent"] = originalProcEnded
    }
    return { kind: "disposed" }
  }

  return {
    readChapters,
    seek,
    play,
    pause,
    setAutoAdvanceBlocked,
    goNext,
    dispose,
    schedule: (callback: () => void, ms: number) => {
      if (!disposed) {
        const timer = setTimer(() => {
          timers.delete(timer)
          if (!disposed) callback()
        }, ms)
        timers.add(timer)
      }
    },
  }
}
