import { describe, expect, it } from "vitest"
import { type FetchLike, fetchSharedPlaylist } from "../../src/share/api-client"
import { fetchJson, SHARE_ID, SHARE_ORIGIN, shareResponse } from "./fixtures"

const API = SHARE_ORIGIN

function okFetch(response = shareResponse()): FetchLike {
  return fetchJson({ data: response })
}

describe("fetchSharedPlaylist", () => {
  it("requests the fixed API path with credentials omitted and no redirects", async () => {
    let seenUrl = ""
    let seenInit: Parameters<FetchLike>[1] | undefined
    const fetchImpl: FetchLike = async (url, init) => {
      seenUrl = url
      seenInit = init
      return fetchJson({ data: shareResponse() })()
    }
    const result = await fetchSharedPlaylist({ apiOrigin: API, shareId: SHARE_ID, fetchImpl })
    expect(seenUrl).toBe(`${API}/api/v1/playlists/${SHARE_ID}`)
    expect(seenInit).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    })
    expect(result).toMatchObject({ kind: "ok", response: { shareId: SHARE_ID, revision: 2 } })
  })

  it("maps 404/429/500 to bounded reasons", async () => {
    for (const [status, reason] of [
      [404, "not-found"],
      [429, "rate-limited"],
      [500, "unavailable"],
      [400, "invalid-response"],
    ] as const) {
      const result = await fetchSharedPlaylist({
        apiOrigin: API,
        shareId: SHARE_ID,
        fetchImpl: fetchJson({ error: { code: "X", message: "m", requestId: "r" } }, status),
      })
      expect(result).toMatchObject({ kind: "error", reason, status })
    }
  })

  it("rejects non-JSON and schema-invalid bodies with field paths", async () => {
    const notJson = await fetchSharedPlaylist({
      apiOrigin: API,
      shareId: SHARE_ID,
      fetchImpl: fetchJson("<html>not json</html>"),
    })
    expect(notJson).toMatchObject({ kind: "error", reason: "invalid-response" })

    const wrongShape = await fetchSharedPlaylist({
      apiOrigin: API,
      shareId: SHARE_ID,
      fetchImpl: fetchJson({ data: { shareId: SHARE_ID, playlist: { bogus: true } } }),
    })
    expect(wrongShape).toMatchObject({ kind: "error", reason: "invalid-response" })
    if (wrongShape.kind === "error") expect(wrongShape.paths?.length).toBeGreaterThan(0)
  })

  it("rejects a response whose shareId does not match the request", async () => {
    const result = await fetchSharedPlaylist({
      apiOrigin: API,
      shareId: SHARE_ID,
      fetchImpl: okFetch(shareResponse({ shareId: "ABCDEFGHIJKLMNOPQRSTUV" })),
    })
    expect(result).toMatchObject({ kind: "error", reason: "share-mismatch" })
  })

  it("rejects oversized bodies — declared and streamed", async () => {
    const maxBytes = 1024
    const declared: FetchLike = async () =>
      new Response("x".repeat(4096), {
        status: 200,
        headers: { "content-length": "4096" },
      })
    expect(
      await fetchSharedPlaylist({
        apiOrigin: API,
        shareId: SHARE_ID,
        fetchImpl: declared,
        maxBytes,
      }),
    ).toMatchObject({ kind: "error", reason: "too-large" })

    // Content-Length lies: body is streamed past the cap and aborted early.
    const lying: FetchLike = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(600))
            controller.enqueue(new Uint8Array(600))
            controller.close()
          },
        }),
        { status: 200 },
      )
    expect(
      await fetchSharedPlaylist({ apiOrigin: API, shareId: SHARE_ID, fetchImpl: lying, maxBytes }),
    ).toMatchObject({ kind: "error", reason: "too-large" })
  })

  it("maps network failure and redirects to bounded reasons", async () => {
    const broken: FetchLike = async () => {
      throw new TypeError("fetch failed")
    }
    expect(
      await fetchSharedPlaylist({ apiOrigin: API, shareId: SHARE_ID, fetchImpl: broken }),
    ).toMatchObject({ kind: "error", reason: "network" })
  })

  it("rejects unknown keys (strict envelope) and hostile metadata stays inert", async () => {
    const hostile = shareResponse()
    const result = await fetchSharedPlaylist({
      apiOrigin: API,
      shareId: SHARE_ID,
      fetchImpl: fetchJson({
        data: { ...hostile, playlist: { ...hostile.playlist, title: "<script>x</script>" } },
        extra: "injected",
      }),
    })
    expect(result).toMatchObject({ kind: "error", reason: "invalid-response" })
  })
})
