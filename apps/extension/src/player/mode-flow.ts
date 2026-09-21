// Op-ed and custom-preview mode flows — ports enterOpEdMode (content.js:
// 408-427), startWorkPageRange (430-446), the custom-test branch of
// showCustomRangeBar (1233-1370) and the native-skip cookie contract
// (122-138). Chapter naming stays heuristic (guessRangeName): d-Anime only
// marks chapters type==='none', never OP/ED (docs/danime-player-contract.md §2).
import { PAGE_MESSAGE_SOURCE } from "../../../../packages/shared/src/bridge"
import { guessRangeName } from "../domain/range"
import { STARTUP_LOCK_PLAYBACK_MS } from "./constants"
import {
  type NamedRange,
  type PlayerContext,
  renderPlayerUi,
  resetNativeSkip,
  seekToStartWhenReady,
  sendCommand,
  setNativeSkip,
  setOpEdTransient,
  stopPlayback,
} from "./runtime"

function namedSkipRanges(ctx: PlayerContext): NamedRange[] {
  const video = ctx.deps.getVideo()
  const durationMs =
    video !== undefined && Number.isFinite(video.duration) && video.duration > 0
      ? video.duration * 1000
      : Number.POSITIVE_INFINITY
  const chapters = ctx.chapters ?? []
  return chapters.map((chapter, index) => ({
    startMs: chapter.startMs,
    endMs: chapter.endMs,
    name: guessRangeName({
      range: { start: chapter.startMs, end: chapter.endMs },
      index,
      total: chapters.length,
      durationMs,
    }),
  }))
}

/**
 * Port of enterOpEdMode (content.js:408-427). Plays the Nth skip chapter,
 * restores the native skip cookie WITHOUT blocking auto-advance (op-ed chains
 * through the native player), sets the sessionStorage flag, leaves native
 * prev/next visible.
 */
export async function enterOpEdMode(ctx: PlayerContext, startIndex = 0): Promise<boolean> {
  const ranges = namedSkipRanges(ctx)
  if (ranges.length === 0) return false
  const index = Math.max(0, Math.min(startIndex, ranges.length - 1))
  const range = ranges[index]
  if (range === undefined) return false
  ctx.generation += 1
  ctx.sameVideoItems = []
  ctx.playlistName = ""
  ctx.state = { mode: "op-ed", ranges, rangeIndex: index }
  setNativeSkip(ctx, true, false)
  ctx.deps.setOpEdSessionFlag(true)
  renderPlayerUi(ctx)
  sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "PAUSE" })
  ctx.startupLockUntil = ctx.deps.now() + STARTUP_LOCK_PLAYBACK_MS
  seekToStartWhenReady(ctx, range.startMs, () =>
    sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "PLAY" }),
  )
  return true
}

/**
 * Port of startWorkPageRange (content.js:430-446) — the dopRangeIndex scheme:
 * validates against current chapters, clears playlist state, persists the
 * op-ed intent (legacy dop_oped_mode → transient.opedMode), enters op-ed.
 */
export async function startWorkPageRange(ctx: PlayerContext, rangeIndex: number): Promise<void> {
  const ranges = namedSkipRanges(ctx)
  if (ranges.length === 0) {
    await ctx.deps.showModal({
      title: "エラー",
      body: "この話にはOP/ED情報が見つかりませんでした。",
      buttons: [{ label: "OK", value: "ok", primary: true }],
    })
    return
  }
  if (rangeIndex < 0 || rangeIndex >= ranges.length) {
    await ctx.deps.showModal({
      title: "エラー",
      body: "指定した区間が見つかりませんでした。",
      buttons: [{ label: "OK", value: "ok", primary: true }],
    })
    return
  }
  await stopPlayback(ctx)
  await setOpEdTransient(ctx, true)
  await enterOpEdMode(ctx, rangeIndex)
}

/**
 * Begin custom-preview selection (content.js:1233-1245). An active mode must
 * be confirmed away first via a custom modal — never window.confirm.
 */
export async function beginCustomPreview(ctx: PlayerContext): Promise<boolean> {
  if (ctx.state.mode !== "idle") {
    const value = await ctx.deps.showModal({
      title: "再生モードを解除",
      body: "カスタム範囲を選択するには、現在の再生モードを解除してください。",
      buttons: [
        { label: "キャンセル", value: "cancel" },
        { label: "解除して続行", value: "ok", primary: true },
      ],
    })
    if (value !== "ok") return false
    await stopPlayback(ctx)
  }
  ctx.generation += 1
  ctx.state = {
    mode: "custom-preview",
    draft: { startMs: null, endMs: null, name: "" },
    testing: false,
  }
  renderPlayerUi(ctx)
  return true
}

/** Update the draft while selecting (bar inputs / get-from-video buttons). */
export function updateCustomDraft(
  ctx: PlayerContext,
  patch: {
    readonly startMs?: number | null
    readonly endMs?: number | null
    readonly name?: string
  },
): void {
  if (ctx.state.mode !== "custom-preview") return
  ctx.state = {
    ...ctx.state,
    draft: {
      startMs: patch.startMs === undefined ? ctx.state.draft.startMs : patch.startMs,
      endMs: patch.endMs === undefined ? ctx.state.draft.endMs : patch.endMs,
      name: patch.name === undefined ? ctx.state.draft.name : patch.name,
    },
  }
  renderPlayerUi(ctx)
}

/**
 * Test-play the draft range (content.js:1307-1321): validates start<end,
 * restores the native skip cookie without blocking auto-advance, seeks, plays.
 */
export async function testCustomPreview(ctx: PlayerContext): Promise<boolean> {
  if (ctx.state.mode !== "custom-preview") return false
  const draft = ctx.state.draft
  if (draft.startMs === null || draft.endMs === null) return false
  if (draft.startMs >= draft.endMs) {
    await ctx.deps.showModal({
      title: "エラー",
      body: "開始地点は終了地点より前に設定してください。",
      buttons: [{ label: "OK", value: "ok", primary: true }],
    })
    return false
  }
  ctx.state = { ...ctx.state, testing: true }
  setNativeSkip(ctx, true, false)
  renderPlayerUi(ctx)
  sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "SEEK", timeMs: draft.startMs })
  sendCommand(ctx, { source: PAGE_MESSAGE_SOURCE, type: "PLAY" })
  return true
}

/** Cancel the bar (content.js:1340-1352): cookie restore + back to idle. */
export async function cancelCustomPreview(ctx: PlayerContext): Promise<void> {
  if (ctx.state.mode !== "custom-preview") return
  ctx.generation += 1
  resetNativeSkip(ctx)
  ctx.state = { mode: "idle" }
  renderPlayerUi(ctx)
}
