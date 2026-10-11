// Tag-suggestion unit tests: the local heuristics (kind inference, artist
// extraction, canonical merge), the hand-validated protocol kind, and the
// background flow's works projection (whitelist payload + consent re-check
// immediately before the fetch). No network — the fetch layer is stubbed.
import { describe, expect, it } from "vitest"
import type { LocalV2State } from "../../../../packages/shared/src/local-model"
import type { FetchLike } from "../../src/share/api-client"
import { createShareManagementFlow } from "../../src/share/management-flow"
import {
  createShareManageClient,
  isShareManageReply,
  parseShareManageMessage,
} from "../../src/share/management-protocol"
import { mergeTagSuggestions, suggestLocalTags } from "../../src/share/tag-suggest"
import { InMemoryStorageDriver } from "../../src/storage/driver"
import { createLocalRepository } from "../../src/storage/repository"
import { item, playlist } from "../domain/fixtures"
import { v2State } from "../portable/fixtures"
import { NOW } from "./fixtures"

const STATE_KEY = "dop_v2_state"

function playlistWith(
  name: string,
  items: readonly { title: string; workId?: string; rangeName?: string }[],
): ReturnType<typeof playlist> {
  return {
    id: "p1",
    name,
    items: items.map((entry, index) => {
      const base = item(`i${index}`)
      const { workId: _baseWorkId, ...rest } = base
      return {
        ...rest,
        title: entry.title,
        ...(entry.workId === undefined ? {} : { workId: entry.workId }),
        range: {
          start: 0,
          end: 90_000,
          ...(entry.rangeName === undefined ? {} : { name: entry.rangeName }),
        },
      }
    }),
  }
}

describe("tag-suggest/suggestLocalTags", () => {
  it("infers the kind tag from the playlist title", () => {
    expect(suggestLocalTags(playlistWith("アニメOP集", []))).toEqual(["op"])
    expect(suggestLocalTags(playlistWith("好きなエンディング", []))).toEqual(["ed"])
    expect(suggestLocalTags(playlistWith("OP・EDまとめ", []))).toEqual(["oped"])
    expect(suggestLocalTags(playlistWith("OPED集", []))).toEqual(["oped"])
    expect(suggestLocalTags(playlistWith("オープニングとエンディング", []))).toEqual(["oped"])
    expect(suggestLocalTags(playlistWith("プリキュア3DCGエンディング", []))).toEqual(["ed"])
    // No marker → no kind tag; word-boundary markers avoid FRIENDS/Co-Op traps.
    expect(suggestLocalTags(playlistWith("FRIENDS", []))).toEqual([])
    expect(suggestLocalTags(playlistWith("普通のリスト", []))).toEqual([])
  })

  it("extracts artist tags from trailing range.name parens (half/full width)", () => {
    const tags = suggestLocalTags(
      playlistWith("リスト", [
        { title: "A", rangeName: "My OP (YOASOBI)" },
        { title: "B", rangeName: "ED（Official髭男dism）" },
        { title: "C", rangeName: " parens mid (not trailing) tail" },
        { title: "D", rangeName: "no parens" },
        { title: "E", rangeName: "empty ()" },
      ]),
    )
    expect(tags).toEqual(["YOASOBI", "Official髭男dism"])
  })

  it("dedups artists case-insensitively and keeps playlist order", () => {
    const tags = suggestLocalTags(
      playlistWith("OP集", [
        { title: "A", rangeName: "OP (LiSA)" },
        { title: "B", rangeName: "OP (lisa)" },
        { title: "C", rangeName: "ED (Aimer)" },
      ]),
    )
    expect(tags).toEqual(["op", "LiSA", "Aimer"])
  })

  it("drops artist candidates longer than SHARE_TAG_MAX", () => {
    const tags = suggestLocalTags(
      playlistWith("リスト", [{ title: "A", rangeName: `OP (${"x".repeat(25)})` }]),
    )
    expect(tags).toEqual([])
  })
})

describe("tag-suggest/mergeTagSuggestions", () => {
  it("canonical-merges typed, api and local tags — dedup folded, sorted", () => {
    expect(mergeTagSuggestions(["マイタグ", "  op  "], ["2006年", "OP"], ["op", "LiSA"])).toEqual([
      "2006年",
      "lisa",
      "op",
      "マイタグ",
    ])
  })

  it("caps the union at SHARE_TAGS_MAX", () => {
    const merged = mergeTagSuggestions(
      ["t0"],
      Array.from({ length: 10 }, (_, index) => `api-${index}`),
      ["local-1"],
    )
    expect(merged).toHaveLength(10)
  })
})

describe("tag-suggest/protocol", () => {
  it("parses the suggest-tags request like sibling playlistId requests", () => {
    expect(
      parseShareManageMessage({ kind: "share-manage-suggest-tags", playlistId: "p1" }),
    ).toEqual({ kind: "share-manage-suggest-tags", playlistId: "p1" })
    for (const bad of [
      { kind: "share-manage-suggest-tags" },
      { kind: "share-manage-suggest-tags", playlistId: "" },
      { kind: "share-manage-suggest-tags", playlistId: "x".repeat(257) },
      { kind: "share-manage-suggest-tags", playlistId: 42 },
      "share-manage-suggest-tags",
    ]) {
      expect(parseShareManageMessage(bad)).toBeUndefined()
    }
  })

  it("validates the tags reply kind and sends the typed message", async () => {
    expect(
      isShareManageReply({
        kind: "share-manage-result",
        status: "tags",
        tags: ["op"],
        unmatched: [],
      }),
    ).toBe(true)
    let sent: unknown
    const client = createShareManageClient(async (message) => {
      sent = message
      return { kind: "share-manage-result", status: "tags", tags: [], unmatched: [] }
    })
    await client.suggestTags({ playlistId: "p1" })
    expect(sent).toEqual({ kind: "share-manage-suggest-tags", playlistId: "p1" })
  })
})

describe("tag-suggest/flow", () => {
  function rig(state: LocalV2State, fetchImpl: FetchLike) {
    const driver = new InMemoryStorageDriver({ [STATE_KEY]: state })
    const repository = createLocalRepository({
      driver,
      now: () => NOW,
      newId: () => crypto.randomUUID(),
    })
    return createShareManagementFlow({ repository, fetchImpl })
  }

  function suggestApi(body?: { tags?: string[]; unmatched?: string[]; perWork?: unknown[] }): {
    fetchImpl: FetchLike
    calls: { url: string; body: unknown; headers: HeadersInit | undefined }[]
  } {
    const calls: { url: string; body: unknown; headers: HeadersInit | undefined }[] = []
    return {
      calls,
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          headers: init.headers,
          body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        })
        return new Response(
          JSON.stringify({
            data: body ?? {
              tags: ["2006年", "少年"],
              unmatched: ["Missing Work"],
              perWork: [{ title: "Work a", matched: true, tags: ["2006年"] }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      },
    }
  }

  function stateWithConsent(
    local: ReturnType<typeof playlist>,
    choice: "granted" | "declined" = "granted",
  ): LocalV2State {
    return v2State({
      playlists: [local],
      shareConsent: { choice, decidedAt: NOW },
    })
  }

  it("replies tags + unmatched with a {works}-only deduped projection body", async () => {
    const local = playlistWith("OP集", [
      { title: "Work A", workId: "work-a" },
      { title: "Work A", workId: "work-a" }, // same work → dedup
      { title: "Work B" }, // no workId → dedup key is the title
      { title: "Work B" },
    ])
    const api = suggestApi()
    const flow = rig(stateWithConsent(local), api.fetchImpl)
    const reply = await flow.suggestTags({ kind: "share-manage-suggest-tags", playlistId: "p1" })
    expect(reply).toMatchObject({
      kind: "share-manage-result",
      status: "tags",
      tags: ["2006年", "少年"],
      unmatched: ["Missing Work"],
    })
    expect(api.calls).toHaveLength(1)
    const call = api.calls[0]
    expect(call?.url).toBe("https://d-op.sasnews.dev/api/v1/tag-suggestions")
    // Whitelisted payload: exactly {works:[{title, workId?}]}, deduped.
    expect(call?.body).toEqual({
      works: [{ title: "Work A", workId: "work-a" }, { title: "Work B" }],
    })
    // Read-only lookup: no secret, no Idempotency-Key.
    const headers = call?.headers as Record<string, string>
    expect(Object.keys(headers ?? {})).not.toContain("authorization")
    expect(Object.keys(headers ?? {})).not.toContain("Idempotency-Key")
  })

  it("answers consent-required without fetching when consent is not granted", async () => {
    const api = suggestApi()
    const flow = rig(stateWithConsent(playlist("p1", ["a"]), "declined"), api.fetchImpl)
    const reply = await flow.suggestTags({ kind: "share-manage-suggest-tags", playlistId: "p1" })
    expect(reply.status).toBe("consent-required")
    expect(api.calls).toHaveLength(0)
  })

  it("maps upstream failures to bounded replies and keeps the reply secret-free", async () => {
    const offline: FetchLike = async () => {
      throw new TypeError("down")
    }
    const flow = rig(stateWithConsent(playlist("p1", ["a"])), offline)
    expect(
      (await flow.suggestTags({ kind: "share-manage-suggest-tags", playlistId: "p1" })).status,
    ).toBe("offline")

    const malformed = suggestApi()
    malformed.fetchImpl = async () =>
      new Response(JSON.stringify({ data: { tags: "nope" } }), { status: 200 })
    const flow2 = rig(stateWithConsent(playlist("p1", ["a"])), malformed.fetchImpl)
    expect(
      (await flow2.suggestTags({ kind: "share-manage-suggest-tags", playlistId: "p1" })).status,
    ).toBe("failed")
  })

  it("unpublishable playlists get the same bounded reply publish would", async () => {
    const local = playlistWith("OP集", [])
    const flow = rig(stateWithConsent(local), suggestApi().fetchImpl)
    const reply = await flow.suggestTags({ kind: "share-manage-suggest-tags", playlistId: "p1" })
    expect(reply.status).toBe("unpublishable")
  })
})
