import { beforeAll, describe, expect, it } from "vitest"
import { SharedPlaylistSchema } from "../../../../packages/shared/src/index"
import { DELETE as deleteRoute } from "../../src/pages/api/v1/playlists/[shareId].js"
import {
  formatClockMs,
  formatDateJa,
  formatDurationJa,
  loadSharePage,
  SHARE_SITE_ORIGIN,
} from "../../src/server/services/share-page.js"
import {
  call,
  db,
  deleteShare,
  makePlaylist,
  migratedDb,
  publishPlaylist,
  seedPendingRow,
} from "../publication-api/helpers.js"

// /p/:shareId page-data assembly (task 16): view-model shape, exact duration,
// the nonrevealing-notfound contract, public/unlisted semantics, derivedFrom
// redaction, and the pure duration/date formatters. Everything runs against
// the real per-file Miniflare D1 — same fixtures as the publication-api suite.

const pageRequest = (shareId: string) =>
  new Request(`https://d-op.sasnews.dev/p/${shareId}`, { method: "GET" })

async function load(shareId: string | undefined) {
  return loadSharePage(shareId, new Request("https://d-op.sasnews.dev/p/x"), crypto.randomUUID())
}

function eightClipPlaylist() {
  // Eight clips, irregular lengths including sub-second ends, so the exact
  // total (sum of end-start, no padding) is distinguishable from a rounded
  // or tail-tolerance figure.
  const ranges = [
    [0, 90_000],
    [10_000, 100_500],
    [0, 89_250],
    [5_000, 96_000],
    [0, 91_500],
    [12_000, 105_750],
    [0, 88_000],
    [7_500, 95_250],
  ] as const
  const items = ranges.map(([start, end], index) => ({
    partId: `part_${index}`,
    workId: `work_${index}`,
    title: `作品${index}`,
    episodeTitle: `第${index + 1}話`,
    episodeNumber: `${index + 1}`,
    range: { start, end, name: "OP" },
  }))
  return SharedPlaylistSchema.parse({
    schemaVersion: 1,
    title: "8クリップの共有リスト",
    description: "合計時間の正確な表示を検証するリスト",
    author: "検証者",
    tags: ["op", "検証"],
    visibility: "public",
    items,
  })
}

const EXPECTED_TOTAL_MS = 721_750 as const // sum of the eight ranges above

beforeAll(async () => {
  await migratedDb()
})

describe("loadSharePage view model", () => {
  it("assembles the public page model with exact total duration", async () => {
    const published = await publishPlaylist(eightClipPlaylist())
    const result = await loadSharePage(
      published.shareId,
      pageRequest(published.shareId),
      crypto.randomUUID(),
    )
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") return
    const view = result.view
    expect(view.shareId).toBe(published.shareId)
    expect(view.canonicalUrl).toBe(`${SHARE_SITE_ORIGIN}/p/${published.shareId}`)
    expect(view.visibility).toBe("public")
    expect(view.title).toBe("8クリップの共有リスト")
    expect(view.author).toBe("検証者")
    expect(view.tags).toEqual(["op", "検証"])
    expect(view.clipCount).toBe(8)
    // Exact sum of end-start across items — no tolerance padding, no rounding.
    expect(view.totalDurationMs).toBe(EXPECTED_TOTAL_MS)
    expect(view.totalDurationLabel).toBe(formatDurationJa(EXPECTED_TOTAL_MS))
    expect(view.items).toHaveLength(8)
    // Popup-style priority: the episode line leads, the work title is the sub.
    expect(view.items[1]?.primaryLabel).toBe("2 第2話")
    expect(view.items[1]?.title).toBe("作品1")
    expect(view.items[1]?.durationLabel).toBe(formatDurationJa(90_500))
    expect(view.items[1]?.rangeLabel).toBe(`${formatClockMs(10_000)} – ${formatClockMs(100_500)}`)
    expect(view.ogTitle).toBe("8クリップの共有リスト")
    expect(view.ogDescription).toContain("8クリップ")
    expect(view.ogDescription).toContain(formatDurationJa(EXPECTED_TOTAL_MS))
    expect(view.xIntentUrl).toContain("https://x.com/intent/post")
    expect(view.xIntentUrl).toContain(encodeURIComponent(view.canonicalUrl))
    expect(view.publishedAtLabel).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日$/)
    expect(view.sourceUrl).toBeNull()
    // Crawler-facing card is the per-playlist PNG endpoint, not a shared SVG.
    // ?v=<content-hash prefix> busts caches when the playlist is republished.
    expect(view.ogImageUrl.startsWith(`${view.canonicalUrl}/og.png?v=`)).toBe(true)
    expect(new URL(view.ogImageUrl).searchParams.get("v")).toMatch(/^[0-9a-f]{12}$/)
  })

  it("carries unlisted visibility through to the view", async () => {
    const published = await publishPlaylist(makePlaylist({ visibility: "unlisted" }))
    const result = await loadSharePage(
      published.shareId,
      pageRequest(published.shareId),
      crypto.randomUUID(),
    )
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") return
    expect(result.view.visibility).toBe("unlisted")
  })

  it("keeps script-like metadata as inert escaped text in the view model", async () => {
    const playlist = SharedPlaylistSchema.parse({
      ...makePlaylist({}),
      title: '<script>alert("x")</script>',
      author: '<img src=x onerror="alert(1)">',
      description: '"><svg onload=alert(1)>',
    })
    const published = await publishPlaylist(playlist)
    const result = await loadSharePage(
      published.shareId,
      pageRequest(published.shareId),
      crypto.randomUUID(),
    )
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") return
    // The service returns the raw strings — rendering escapes them (Astro
    // text expressions, never set:html). Nothing here may pre-markup them.
    expect(result.view.title).toBe('<script>alert("x")</script>')
    expect(result.view.author).toBe('<img src=x onerror="alert(1)">')
  })

  it("never exposes secret material or management fields in the view", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const result = await loadSharePage(
      published.shareId,
      pageRequest(published.shareId),
      crypto.randomUUID(),
    )
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") return
    const serialized = JSON.stringify(result.view)
    expect(serialized).not.toContain(published.manageSecret)
    expect(serialized).not.toContain("secret")
    expect(serialized).not.toContain("hash")
    expect(serialized).not.toContain("manageSecret")
  })
})

describe("loadSharePage nonrevealing notfound", () => {
  const NOT_FOUND = { kind: "notfound" } as const

  it("collapses absent, malformed, pending, deleted and blocked ids to the same result", async () => {
    // absent: well-formed id that never existed
    const absent = await loadSharePage(
      "AAAAAAAAAAAAAAAAAAAAAA",
      pageRequest("AAAAAAAAAAAAAAAAAAAAAA"),
      crypto.randomUUID(),
    )
    // malformed: fails the 22-char base64url id schema
    const malformed = await load("not-a-share-id")
    const undefinedParam = await load(undefined)
    // pending: provisional row not yet activated (invisible to public reads)
    const pending = await seedPendingRow(new Date())
    const pendingResult = await loadSharePage(
      pending.shareId,
      pageRequest(pending.shareId),
      crypto.randomUUID(),
    )
    // deleted: published then owner-deleted via the real DELETE route
    const deleted = await publishPlaylist(makePlaylist({}))
    const deletedResponse = await call(
      deleteRoute,
      deleteShare(deleted.shareId, deleted.manageSecret, crypto.randomUUID(), 2),
      { shareId: deleted.shareId },
    )
    expect(deletedResponse.status).toBe(204)
    const deletedResult = await loadSharePage(
      deleted.shareId,
      pageRequest(deleted.shareId),
      crypto.randomUUID(),
    )
    // blocked: operator-hidden row that still exists in storage
    const blocked = await publishPlaylist(makePlaylist({}))
    await db()
      .prepare("UPDATE playlists SET blocked = 1 WHERE share_id = ?1")
      .bind(blocked.shareId)
      .run()
    const blockedResult = await loadSharePage(
      blocked.shareId,
      pageRequest(blocked.shareId),
      crypto.randomUUID(),
    )
    for (const result of [
      absent,
      malformed,
      undefinedParam,
      pendingResult,
      deletedResult,
      blockedResult,
    ]) {
      expect(result).toEqual(NOT_FOUND)
    }
  })
})

describe("loadSharePage derivedFrom redaction", () => {
  it("links the source only while the parent stays public", async () => {
    const parent = await publishPlaylist(makePlaylist({ title: "親リスト" }))
    const derived = SharedPlaylistSchema.parse({
      ...makePlaylist({ title: "Remixリスト" }),
      derivedFrom: { shareId: parent.shareId, revision: 2 },
    })
    const child = await publishPlaylist(derived)
    const linked = await loadSharePage(
      child.shareId,
      pageRequest(child.shareId),
      crypto.randomUUID(),
    )
    expect(linked.kind).toBe("ready")
    if (linked.kind !== "ready") return
    expect(linked.view.sourceUrl).toBe(`/p/${parent.shareId}`)
    // Hide the parent -> the child's public view must redact the source.
    await db()
      .prepare("UPDATE playlists SET blocked = 1 WHERE share_id = ?1")
      .bind(parent.shareId)
      .run()
    const redacted = await loadSharePage(
      child.shareId,
      pageRequest(child.shareId),
      crypto.randomUUID(),
    )
    expect(redacted.kind).toBe("ready")
    if (redacted.kind !== "ready") return
    expect(redacted.view.sourceUrl).toBeNull()
    expect(JSON.stringify(redacted.view)).not.toContain(parent.shareId)
  })

  it("redacts a derivedFrom left dangling after the parent row is gone", async () => {
    // Create-time validation now refuses unknown parents, so the dangling
    // state only arises when a formerly valid parent row disappears — seed
    // that exact shape directly (the delete route hard-removes the row).
    const parent = await publishPlaylist(makePlaylist({}))
    const derived = SharedPlaylistSchema.parse({
      ...makePlaylist({}),
      derivedFrom: { shareId: parent.shareId, revision: 2 },
    })
    const child = await publishPlaylist(derived)
    await db().prepare("DELETE FROM playlists WHERE share_id = ?1").bind(parent.shareId).run()
    const result = await loadSharePage(
      child.shareId,
      pageRequest(child.shareId),
      crypto.randomUUID(),
    )
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") return
    expect(result.view.sourceUrl).toBeNull()
    expect(JSON.stringify(result.view)).not.toContain(parent.shareId)
  })
})

describe("exact duration and date formatters", () => {
  it("formats clock positions without rounding sub-second precision", () => {
    expect(formatClockMs(0)).toBe("0:00")
    expect(formatClockMs(90_000)).toBe("1:30")
    expect(formatClockMs(90_500)).toBe("1:30")
    expect(formatClockMs(3_661_000)).toBe("1:01:01")
    expect(formatClockMs(61_234)).toBe("1:01")
  })

  it("formats total durations in whole-second Japanese units", () => {
    expect(formatDurationJa(0)).toBe("0秒")
    expect(formatDurationJa(90_000)).toBe("1分30秒")
    expect(formatDurationJa(3_661_500)).toBe("1時間1分2秒")
    expect(formatDurationJa(EXPECTED_TOTAL_MS)).toBe("12分2秒")
    expect(formatDurationJa(3_600_000)).toBe("1時間")
  })

  it("formats publication dates deterministically (UTC, locale-free)", () => {
    expect(formatDateJa("2026-09-21T12:34:56.000Z")).toBe("2026年9月21日")
    expect(formatDateJa("2026-01-05T00:00:00.000Z")).toBe("2026年1月5日")
  })
})
