import { describe, expect, it } from "vitest"
import { createDAnimeAdapter } from "../../src/adapter/danime-adapter"

type FakeVideo = {
  currentTime: number
  paused: boolean
  duration?: number
  play: () => Promise<void>
  pause: () => void
}

function videoFixture(): FakeVideo {
  return {
    currentTime: 0,
    paused: true,
    play: async () => undefined,
    pause: () => undefined,
  }
}

describe("d-Anime adapter", () => {
  it("seeks through vc.jump and reports chapters", () => {
    const video = { ...videoFixture(), duration: 120 }
    const jumps: number[] = []
    const vc = {
      jump: (seconds: number) => jumps.push(seconds),
      // Real site shape: ws010105Data has NO duration — it is derived from
      // the video element instead.
      ws010105Data: { chapters: [{ start: 0, end: 90000, type: "none" }] },
    }
    const adapter = createDAnimeAdapter({ getVc: () => vc, getVideo: () => video })

    expect(adapter.readChapters()).toEqual({
      kind: "ready",
      chapters: [{ startMs: 0, endMs: 90000, type: "none" }],
      durationMs: 120000,
    })
    expect(adapter.seek(12_000)).toEqual({ kind: "ok" })
    expect(jumps).toEqual([12])
  })

  it("reports chapters without ws duration or video metadata", () => {
    const vc = {
      ws010105Data: {
        partId: "12345",
        chapters: [
          { start: 0, end: 10_000, type: "none", showInterface: true },
          { start: 10_000, end: 1_390_000, type: "mainStory" },
        ],
      },
    }
    const adapter = createDAnimeAdapter({ getVc: () => vc, getVideo: () => undefined })

    expect(adapter.readChapters()).toEqual({
      kind: "ready",
      chapters: [
        { startMs: 0, endMs: 10_000, type: "none" },
        { startMs: 10_000, endMs: 1_390_000, type: "mainStory" },
      ],
      durationMs: undefined,
      partId: "12345",
    })
  })

  it("falls back to video controls and models rejected play", async () => {
    const video = videoFixture()
    video.play = async () => {
      throw new Error("blocked")
    }
    const adapter = createDAnimeAdapter({ getVc: () => undefined, getVideo: () => video })

    expect(adapter.seek(5000)).toEqual({ kind: "ok" })
    expect(video.currentTime).toBe(5)
    expect(await adapter.play()).toEqual({ kind: "command-failed", command: "PLAY" })
    expect(adapter.pause()).toEqual({ kind: "ok" })
  })

  it("rejects invalid seek and chapter bounds without touching the player", () => {
    const video = videoFixture()
    const jumps: number[] = []
    const vc = {
      jump: (seconds: number) => jumps.push(seconds),
      ws010105Data: { chapters: [{ start: 5_000, end: 5_000, type: "none" }] },
    }
    const adapter = createDAnimeAdapter({ getVc: () => vc, getVideo: () => video })

    expect(adapter.seek(Number.NaN)).toEqual({ kind: "command-failed", command: "SEEK" })
    expect(adapter.seek(86_400_001)).toEqual({ kind: "command-failed", command: "SEEK" })
    expect(adapter.readChapters()).toEqual({ kind: "unavailable" })
    expect(jumps).toEqual([])
  })

  it("turns throwing pause, next, and button operations into failures", () => {
    const video = videoFixture()
    video.pause = () => {
      throw new Error("pause")
    }
    const vc = {
      goNext: () => {
        throw new Error("next")
      },
    }
    const adapter = createDAnimeAdapter({
      getVc: () => vc,
      getVideo: () => video,
      getNextButton: () => ({
        disabled: false,
        click: () => {
          throw new Error("button")
        },
      }),
    })

    expect(adapter.pause()).toEqual({ kind: "command-failed", command: "PAUSE" })
    expect(adapter.goNext()).toEqual({ kind: "command-failed", command: "GO_NEXT" })
    const fallback = createDAnimeAdapter({
      getVc: () => undefined,
      getVideo: () => video,
      getNextButton: () => ({
        disabled: false,
        click: () => {
          throw new Error("button")
        },
      }),
    })
    expect(fallback.goNext()).toEqual({ kind: "command-failed", command: "GO_NEXT" })
  })

  it("restores hooks exactly once and disposes polling", () => {
    const originalGoNext = () => undefined
    const originalProcEnded = () => undefined
    const vc = { goNext: originalGoNext, procEndedEvent: originalProcEnded }
    const adapter = createDAnimeAdapter({ getVc: () => vc, getVideo: () => undefined })

    expect(adapter.setAutoAdvanceBlocked(true)).toEqual({ kind: "ok" })
    expect(vc.goNext).not.toBe(originalGoNext)
    expect(adapter.setAutoAdvanceBlocked(true)).toEqual({ kind: "ok" })
    adapter.dispose()
    expect(vc.goNext).toBe(originalGoNext)
    expect(vc.procEndedEvent).toBe(originalProcEnded)
    expect(adapter.dispose()).toEqual({ kind: "disposed" })
  })

  it("makes every command a no-op after disposal", async () => {
    const video = videoFixture()
    const vc = {
      jump: () => {
        throw new Error("must not call")
      },
      goNext: () => {
        throw new Error("must not call")
      },
    }
    const adapter = createDAnimeAdapter({ getVc: () => vc, getVideo: () => video })
    adapter.dispose()

    expect(adapter.readChapters()).toEqual({ kind: "disposed" })
    expect(adapter.seek(1)).toEqual({ kind: "disposed" })
    expect(await adapter.play()).toEqual({ kind: "disposed" })
    expect(adapter.pause()).toEqual({ kind: "disposed" })
    expect(adapter.goNext()).toEqual({ kind: "disposed" })
    expect(adapter.setAutoAdvanceBlocked(true)).toEqual({ kind: "disposed" })
  })
})
