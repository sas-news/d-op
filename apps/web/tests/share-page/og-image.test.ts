import { beforeAll, describe, expect, it } from "vitest"
import { SharedPlaylistSchema } from "../../../../packages/shared/src/index"
import { GET as ogRoute } from "../../src/pages/p/[shareId]/og.png"
import { call, migratedDb, publishPlaylist } from "../publication-api/helpers.js"

// /p/:shareId/og.png (task-OGP): crawler-facing card image. The suite proves
// the real renderer inside workerd (hand-laid-out SVG + resvg-wasm + ASSETS-served
// fonts/binary), the PNG contract, cache headers, and the same nonrevealing
// 404 the page itself returns. Rendering is exercised end-to-end — no fake
// asset fetcher.

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

const ogRequest = (shareId: string) =>
  new Request(`https://d-op.sasnews.dev/p/${shareId}/og.png`, { method: "GET" })

function samplePlaylist() {
  return SharedPlaylistSchema.parse({
    schemaVersion: 1,
    title: "OGP検証プレイリスト",
    description: "",
    author: "検証者",
    tags: [],
    visibility: "public",
    items: [
      {
        partId: "part_1",
        workId: "work_1",
        title: "検証作品",
        episodeTitle: "第1話",
        episodeNumber: "1",
        range: { start: 0, end: 90_000, name: "OP" },
      },
    ],
  })
}

beforeAll(async () => {
  await migratedDb()
})

describe("GET /p/:shareId/og.png", () => {
  it("renders a PNG card for a published playlist", async () => {
    const published = await publishPlaylist(samplePlaylist())
    const response = await call(ogRoute, ogRequest(published.shareId), {
      shareId: published.shareId,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(response.headers.get("cache-control")).toContain("public")
    const body = new Uint8Array(await response.arrayBuffer())
    expect(body.length).toBeGreaterThan(1000)
    expect([...body.slice(0, 4)]).toEqual([...PNG_MAGIC])
  })

  it("renders extreme-length content without breaking the card", async () => {
    const playlist = SharedPlaylistSchema.parse({
      schemaVersion: 1,
      title: "極限文字数テスト用プレイリスト".repeat(10).slice(0, 120),
      description: "",
      author: "超長い作者名テスト".repeat(10).slice(0, 80),
      tags: Array.from({ length: 10 }, (_, index) =>
        `長いタグ${index}${"ABC".repeat(7)}`.slice(0, 24),
      ),
      visibility: "public",
      items: Array.from({ length: 12 }, (_, index) => ({
        partId: `part_${index}`,
        workId: `work_${index}`,
        title: `作品${index} ${"長いタイトル".repeat(60)}`.slice(0, 300),
        episodeTitle: `第${index + 100}話 ${"長いエピソード名".repeat(60)}`.slice(0, 300),
        episodeNumber: `${index + 100}`,
        range: { start: 0, end: (index + 1) * 90_000, name: index % 2 ? "OP" : "ED" },
      })),
    })
    const published = await publishPlaylist(playlist)
    const response = await call(ogRoute, ogRequest(published.shareId), {
      shareId: published.shareId,
    })
    expect(response.status).toBe(200)
    const body = new Uint8Array(await response.arrayBuffer())
    expect([...body.slice(0, 4)]).toEqual([...PNG_MAGIC])
  })

  it("returns a bare 404 for unknown and malformed ids", async () => {
    for (const id of ["noplaylistneverexists0", "!!!bogus"]) {
      const response = await call(ogRoute, ogRequest(id), { shareId: id })
      expect(response.status).toBe(404)
      expect(await response.text()).toBe("")
    }
  })
})
