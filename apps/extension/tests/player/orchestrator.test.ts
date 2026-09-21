import { describe, expect, it } from "vitest"
import type { LocalPlaylist, TransientState } from "../../../../packages/shared/src/local-model"
import { createPlayerOrchestrator } from "../../src/player/orchestrator"
import { makeHarness, transientOf } from "./fakes"

const DANIME = "https://animestore.docomo.ne.jp/animestore/sc_d_pc"

const playlist: LocalPlaylist = {
  id: "pl-1",
  name: "MyList",
  items: [
    {
      id: "a",
      partId: "p1",
      title: "W",
      episodeTitle: "E1",
      url: `${DANIME}?partId=p1`,
      range: { start: 10_000, end: 90_000, name: "OP" },
    },
    {
      id: "b",
      partId: "p1",
      title: "W",
      episodeTitle: "E1",
      url: `${DANIME}?partId=p1`,
      range: { start: 100_000, end: 140_000, name: "ED" },
    },
    {
      id: "c",
      partId: "p2",
      title: "W",
      episodeTitle: "E2",
      url: `${DANIME}?partId=p2`,
      range: { start: 5_000, end: 80_000, name: "OP" },
    },
  ],
}

const CHAPTERS = {
  source: "d-op-injected" as const,
  chapters: [
    { startMs: 10_000, endMs: 90_000 },
    { startMs: 120_000, endMs: 140_000 },
  ],
  durationMs: 180_000,
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}

describe("player orchestrator", () => {
  it("stays idle when chapters arrive without params or fresh state", async () => {
    const h = makeHarness({ playlists: [playlist], videoFollowsCommands: true })
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    expect(orchestrator.mode()).toBe("idle")
    expect(h.renders.at(-1)?.playlistActive).toBe(false)
    // partId change on an idle context restores the native auto-advance
    // hook (content.js:1477 → resetNativeSkip).
    expect(h.commands).toEqual([{ source: "d-op-injected", type: "UNBLOCK_AUTO_ADVANCE" }])
    // Stale op-ed intent is cleared even on first paint.
    const transient = await transientOf(h.driver)
    expect(transient.opedMode).toBeUndefined()
  })

  it("starts playlist playback from dopPlaylistId/dopIndex and strips params", async () => {
    const h = makeHarness({
      url: `${DANIME}?partId=p1&dopPlaylistId=pl-1&dopIndex=0`,
      playlists: [playlist],
      videoFollowsCommands: true,
    })
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    expect(orchestrator.mode()).toBe("playlist")
    // Params stripped before acting (content.js:393).
    expect(h.replacedUrls).toEqual([`${DANIME}?partId=p1`])
    // UNBLOCK (idle reset) → BLOCK_AUTO_ADVANCE (playlist) → PAUSE → SEEK → PLAY.
    expect(h.commands.map((c) => c.type)).toEqual([
      "UNBLOCK_AUTO_ADVANCE",
      "BLOCK_AUTO_ADVANCE",
      "PAUSE",
      "SEEK",
      "PLAY",
    ])
    expect(h.commands[3]).toMatchObject({ type: "SEEK", timeMs: 10_000 })
    // Playlist mode hides native prev/next and skipUi.
    const snap = h.renders.at(-1)
    expect(snap).toMatchObject({
      mode: "playlist",
      playlistActive: true,
      skipUiHidden: true,
      controlsVisible: true,
      prevDisabled: true,
      nextDisabled: false,
      panelLabel: "OP",
      panelMeta: "1 / 3",
    })
    // Transient playback carries this tab's owner token.
    const transient = await transientOf(h.driver)
    expect(transient.playback).toMatchObject({ playlistId: "pl-1", index: 0 })
    expect(transient.playback?.ownerToken).toBeTruthy()
    // Native skip cookie forced off + auto-advance blocked.
    expect(h.cookies.get("op_skip")).toBe("0")
    expect(h.commands.some((c) => c.type === "BLOCK_AUTO_ADVANCE")).toBe(true)
  })

  it("advances within the same episode in place", async () => {
    const h = makeHarness({
      url: `${DANIME}?partId=p1&dopPlaylistId=pl-1&dopIndex=0`,
      playlists: [playlist],
      videoFollowsCommands: true,
    })
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    h.commands.length = 0
    await orchestrator.handleCommand({ type: "PLAYLIST_NEXT" })
    await settle()
    // Same partId → in-place seek, no REQUEST_PLAYER.
    expect(h.requestedPlayers).toEqual([])
    expect(h.commands.map((c) => c.type)).toEqual(["BLOCK_AUTO_ADVANCE", "SEEK", "PLAY"])
    expect(h.commands[1]).toMatchObject({ type: "SEEK", timeMs: 100_000 })
    expect(h.renders.at(-1)?.panelMeta).toBe("2 / 3")
  })

  it("advances across episodes through REQUEST_PLAYER with dop params", async () => {
    const h = makeHarness({
      url: `${DANIME}?partId=p1&dopPlaylistId=pl-1&dopIndex=1`,
      playlists: [playlist],
      videoFollowsCommands: true,
    })
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    await orchestrator.handleCommand({ type: "PLAYLIST_NEXT" })
    await settle()
    // item c is partId p2 → cross-episode navigation keeps the item url and
    // adds dopPlaylistId + real index (content.js:317-328).
    expect(h.requestedPlayers).toEqual([`${DANIME}?partId=p2&dopPlaylistId=pl-1&dopIndex=2`])
  })

  it("shows the end menu at the end boundary; restart replays real index 0", async () => {
    const h = makeHarness({
      url: `${DANIME}?partId=p2&dopPlaylistId=pl-1&dopIndex=2`,
      playlists: [playlist],
      videoFollowsCommands: true,
    })
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    h.commands.length = 0
    await orchestrator.handleCommand({ type: "PLAYLIST_NEXT" })
    await settle()
    // End boundary: PAUSE + the end-of-playlist modal (content.js:330-350).
    expect(h.commands.map((c) => c.type)).toContain("PAUSE")
    expect(h.modalRequests).toHaveLength(1)
    expect(h.modalRequests[0]?.title).toBe("再生終了")
    h.answerModal("restart")
    await settle()
    // Restart = explicit action to real index 0 (never a wrap-around).
    expect(h.requestedPlayers).toEqual([`${DANIME}?partId=p1&dopPlaylistId=pl-1&dopIndex=0`])
  })

  it("boundary start pauses without wrapping", async () => {
    const h = makeHarness({
      url: `${DANIME}?partId=p1&dopPlaylistId=pl-1&dopIndex=0`,
      playlists: [playlist],
      videoFollowsCommands: true,
    })
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    h.commands.length = 0
    // First item, near start, double-click window → step back hits boundary.
    h.video.currentTime = 10.2
    await orchestrator.handleCommand({ type: "PLAYLIST_PREV" })
    await orchestrator.handleCommand({ type: "PLAYLIST_PREV" })
    await settle()
    expect(h.commands.map((c) => c.type)).toContain("PAUSE")
    expect(h.requestedPlayers).toEqual([])
    expect(h.modalRequests).toHaveLength(0)
  })

  it("prev click restarts the range; double-click near start steps back", async () => {
    const h = makeHarness({
      url: `${DANIME}?partId=p1&dopPlaylistId=pl-1&dopIndex=1`,
      playlists: [playlist],
      videoFollowsCommands: true,
    })
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    h.commands.length = 0
    h.video.currentTime = 130 // inside item b's 100-140 s range
    await orchestrator.handleCommand({ type: "PLAYLIST_PREV" })
    await settle()
    expect(h.commands.at(-1)).toMatchObject({ type: "SEEK", timeMs: 100_000 })
    // Park at range start, then two quick clicks: the second lands inside
    // the 1500 ms double-click window and steps back to item a in place.
    h.commands.length = 0
    h.video.currentTime = 100.2
    await orchestrator.handleCommand({ type: "PLAYLIST_PREV" })
    await orchestrator.handleCommand({ type: "PLAYLIST_PREV" })
    await settle()
    expect(h.commands).toContainEqual(expect.objectContaining({ type: "SEEK", timeMs: 10_000 }))
    // A further double-click at the first item pauses at the boundary
    // without wrapping (content.js:295-308).
    h.commands.length = 0
    h.video.currentTime = 10
    await orchestrator.handleCommand({ type: "PLAYLIST_PREV" })
    await orchestrator.handleCommand({ type: "PLAYLIST_PREV" })
    await settle()
    expect(h.commands.map((c) => c.type)).toContain("PAUSE")
    expect(h.requestedPlayers).toEqual([])
  })

  it("enters op-ed mode from dopRangeIndex without hiding native controls", async () => {
    const h = makeHarness({
      url: `${DANIME}?partId=p1&dopRangeIndex=0`,
      playlists: [playlist],
      videoFollowsCommands: true,
    })
    h.cookies.set("op_skip", "1")
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    expect(orchestrator.mode()).toBe("op-ed")
    const snap = h.renders.at(-1)
    expect(snap).toMatchObject({
      mode: "op-ed",
      playlistActive: false, // native prev/next stay visible
      skipUiHidden: true,
      controlsVisible: false,
      panelLabel: "OP/ED",
    })
    // Cookie restored to the original value, auto-advance NOT blocked.
    expect(h.cookies.get("op_skip")).toBe("1")
    expect(h.commands.some((c) => c.type === "BLOCK_AUTO_ADVANCE")).toBe(false)
    expect(h.getOpEdFlag()).toBe(true)
    // Transient opedMode intent recorded.
    expect((await transientOf(h.driver)).opedMode?.active).toBe(true)
    // Double UNBLOCK mirrors legacy: idle reset + startWorkPageRange's
    // clearPlaylistState both restore the hook before op-ed pauses.
    expect(h.commands.map((c) => c.type)).toEqual([
      "UNBLOCK_AUTO_ADVANCE",
      "UNBLOCK_AUTO_ADVANCE",
      "PAUSE",
      "SEEK",
      "PLAY",
    ])
    expect(h.commands[3]).toMatchObject({ type: "SEEK", timeMs: 10_000 })
  })

  it("resumes a fresh stored playback on the same episode", async () => {
    const transient: TransientState = {
      schemaVersion: 1,
      generation: 0,
      playback: {
        playlistId: "pl-1",
        index: 1,
        updatedAt: 1_000_000, // harness clock
        ownerToken: crypto.randomUUID(),
        ownerGeneration: 1,
      },
    }
    const h = makeHarness({
      url: `${DANIME}?partId=p1`,
      playlists: [playlist],
      transient,
      videoFollowsCommands: true,
    })
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    expect(orchestrator.mode()).toBe("playlist")
    expect(h.commands.some((c) => c.type === "SEEK")).toBe(true)
  })

  it("clears expired stored playback instead of resuming it", async () => {
    const transient: TransientState = {
      schemaVersion: 1,
      generation: 0,
      playback: {
        playlistId: "pl-1",
        index: 1,
        updatedAt: 1_000_000 - 300_001, // older than 5 min
        ownerToken: crypto.randomUUID(),
        ownerGeneration: 1,
      },
    }
    const h = makeHarness({
      url: `${DANIME}?partId=p1`,
      playlists: [playlist],
      transient,
      videoFollowsCommands: true,
    })
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    expect(orchestrator.mode()).toBe("idle")
    expect((await transientOf(h.driver)).playback).toBeUndefined()
  })

  it("enforces ranges on timeupdate: out-of-range seeks, in-range clears latch", async () => {
    const h = makeHarness({
      url: `${DANIME}?partId=p1&dopPlaylistId=pl-1&dopIndex=0`,
      playlists: [playlist],
      videoFollowsCommands: true,
    })
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    h.commands.length = 0
    // Past the 5 s playback-start cooldown: land in-range so the
    // startup-seek latch clears, then jump past range end + tail.
    h.setNow(1_010_000)
    h.video.currentTime = 30
    h.video.fire("timeupdate")
    h.video.currentTime = 95
    h.video.fire("timeupdate")
    await settle()
    // past end → pause + advance (in-place to item b)
    expect(h.commands.map((c) => c.type)).toEqual(["PAUSE", "BLOCK_AUTO_ADVANCE", "SEEK", "PLAY"])
  })

  it("retargets the current item when the user seeks into another same-video range", async () => {
    const h = makeHarness({
      url: `${DANIME}?partId=p1&dopPlaylistId=pl-1&dopIndex=0`,
      playlists: [playlist],
      videoFollowsCommands: true,
    })
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    h.commands.length = 0
    h.setNow(1_010_000)
    h.video.currentTime = 130 // inside item b's range
    h.video.fire("timeupdate")
    await settle()
    // switch-item: no SEEK, current item became b, panel shows 2 / 3.
    expect(h.commands).toEqual([])
    expect(h.renders.at(-1)?.panelMeta).toBe("2 / 3")
    expect(h.renders.at(-1)?.panelLabel).toBe("ED")
    const transient = await transientOf(h.driver)
    expect(transient.playback?.index).toBe(1)
  })

  it("stop restores the cookie, unblocks auto-advance and clears owned playback", async () => {
    const h = makeHarness({
      url: `${DANIME}?partId=p1&dopPlaylistId=pl-1&dopIndex=0`,
      playlists: [playlist],
      videoFollowsCommands: true,
    })
    h.cookies.set("op_skip", "1")
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    await orchestrator.handleCommand({ type: "PLAYLIST_STOP" })
    await settle()
    expect(orchestrator.mode()).toBe("idle")
    expect(h.cookies.get("op_skip")).toBe("1")
    expect(h.commands.some((c) => c.type === "UNBLOCK_AUTO_ADVANCE")).toBe(true)
    const transient = await transientOf(h.driver)
    expect(transient.playback).toBeUndefined()
    expect(h.renders.at(-1)?.mode).toBe("idle")
  })

  it("never clears another owner's playback on stop", async () => {
    const foreignToken = crypto.randomUUID()
    const transient: TransientState = {
      schemaVersion: 1,
      generation: 0,
      playback: {
        playlistId: "pl-1",
        index: 0,
        updatedAt: 1_000_000,
        ownerToken: foreignToken,
        ownerGeneration: 1,
      },
    }
    const h = makeHarness({
      url: `${DANIME}?partId=p1`,
      playlists: [playlist],
      transient,
      videoFollowsCommands: true,
    })
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    // The foreign-owned playback resumed → now owned by this tab (persisted
    // with the new token). Force a stop that must only clear owned state:
    await orchestrator.handleCommand({ type: "PLAYLIST_STOP" })
    const stored = await transientOf(h.driver)
    // Resume re-persisted with this tab's token, so the record is cleared.
    expect(stored.playback).toBeUndefined()
    // Re-seed a foreign-owned record and stop from idle: it must survive.
    const foreign: TransientState = {
      schemaVersion: 1,
      generation: 9,
      playback: {
        playlistId: "pl-1",
        index: 0,
        updatedAt: 1_000_000,
        ownerToken: foreignToken,
        ownerGeneration: 2,
      },
    }
    await h.deps.storage.writeTransient(foreign)
    await orchestrator.handleCommand({ type: "PLAYLIST_STOP" })
    expect((await transientOf(h.driver)).playback?.ownerToken).toBe(foreignToken)
  })

  it("enforces custom-preview test playback and cancels cleanly", async () => {
    const h = makeHarness({ videoFollowsCommands: true })
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    expect(await orchestrator.customPreview.begin()).toBe(true)
    expect(orchestrator.mode()).toBe("custom-preview")
    orchestrator.customPreview.updateDraft({ startMs: 5_000, endMs: 20_000, name: "X" })
    h.commands.length = 0
    expect(await orchestrator.customPreview.test()).toBe(true)
    expect(h.commands.map((c) => c.type)).toEqual(["SEEK", "PLAY"])
    await orchestrator.customPreview.cancel()
    expect(orchestrator.mode()).toBe("idle")
  })

  it("custom-preview begin on an active mode asks via modal first", async () => {
    const h = makeHarness({
      url: `${DANIME}?partId=p1&dopPlaylistId=pl-1&dopIndex=0`,
      playlists: [playlist],
      videoFollowsCommands: true,
    })
    const orchestrator = createPlayerOrchestrator(h.deps)
    await orchestrator.handleChapters(CHAPTERS)
    await settle()
    const begun = orchestrator.customPreview.begin()
    await settle()
    expect(h.modalRequests.at(-1)?.title).toBe("再生モードを解除")
    h.answerModal("cancel")
    expect(await begun).toBe(false)
    expect(orchestrator.mode()).toBe("playlist")
  })
})
