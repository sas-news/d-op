// Share schema, normalization, canonical hashing and projection (task 3).
import {
  buildPlaybackUrl,
  canonicalString,
  checkShareBodySize,
  contentHashOf,
  projectPublicPlaylist,
  SharedPlaylistSchema,
  sortCanonicalTags,
  toPublishProjection,
  UnpublishablePlaylistError,
} from "@d-op/shared"
import { describe, expect, it } from "vitest"
import {
  MALFORMED_RANGES,
  makeRangeItems,
  makeShareBase,
  NFD_TITLE,
  NULL_RANGE_PLAYLIST,
  UNKNOWN_KEY_SAMPLES,
} from "./fixtures"

describe("share normalization", () => {
  it("trims, NFC-normalizes and sorts/dedupes tags case-insensitively", () => {
    // Given: untrimmed NFD input with duplicated tags.
    // When: parsed at the boundary.
    // Then: canonical tags sorted, unique ignoring case, whitespace collapsed.
    const parsed = SharedPlaylistSchema.parse(
      makeShareBase({ title: NFD_TITLE, tags: ["  OP", "op", "ＥＤ", "ed  "] }),
    )
    expect(parsed.title).toBe("café")
    expect(parsed.tags).toEqual(["ed", "op", "ｅｄ"])
    expect(sortCanonicalTags(["b", "A", "a "])).toEqual(["a", "b"])
  })

  it("keeps description line breaks while treating scripts as inert text", () => {
    // Given: multiline description with script-like markup.
    // When: parsed and canonicalized.
    // Then: breaks survive, markup stays a plain string (never executed).
    const parsed = SharedPlaylistSchema.parse(
      makeShareBase({ description: "一行目\n\n<script>alert(1)</script>" }),
    )
    expect(parsed.description).toContain("\n\n")
    expect(canonicalString(parsed)).toContain("<script>alert(1)</script>")
    expect(typeof parsed.description).toBe("string")
  })

  it("rejects null ranges and empty playlists", () => {
    // Given: Share payloads with null range / zero items.
    // When: parsed.
    // Then: both fail (null ranges are local-only data).
    expect(
      SharedPlaylistSchema.safeParse(
        makeShareBase({
          items: [
            {
              partId: "p",
              title: "t",
              episodeTitle: "e",
              range: null,
            },
          ],
        }),
      ).success,
    ).toBe(false)
    expect(SharedPlaylistSchema.safeParse(makeShareBase({ items: [] })).success).toBe(false)
  })

  it("rejects malformed numeric ranges with field paths", () => {
    // Given: NaN/Infinity/negative/unsafe/end<=start ranges.
    // When: parsed.
    // Then: each fails with an issue path under items.0.range.
    for (const range of Object.values(MALFORMED_RANGES)) {
      const result = SharedPlaylistSchema.safeParse(
        makeShareBase({
          items: [{ partId: "p", title: "t", episodeTitle: "e", range }],
        }),
      )
      expect(result.success).toBe(false)
      if (!result.success) {
        const paths = result.error.issues.map((issue) => issue.path.join("."))
        expect(paths.some((p) => p.startsWith("items.0.range"))).toBe(true)
      }
    }
  })

  it("rejects unknown public mutation keys including credentials and urls", () => {
    // Given: playlist/item payloads carrying secrets, urls, capabilities.
    // When: parsed as public mutation input.
    // Then: unknown keys fail closed with unrecognized-key issues.
    const badTop = SharedPlaylistSchema.safeParse(
      makeShareBase({ ...UNKNOWN_KEY_SAMPLES.credentials }),
    )
    expect(badTop.success).toBe(false)
    const badItem = SharedPlaylistSchema.safeParse(
      makeShareBase({
        items: [
          {
            partId: "p",
            title: "t",
            episodeTitle: "e",
            range: { start: 0, end: 1 },
            ...UNKNOWN_KEY_SAMPLES.urlField,
            ...UNKNOWN_KEY_SAMPLES.capability,
          },
        ],
      }),
    )
    expect(badItem.success).toBe(false)
    if (!badItem.success) {
      expect(badItem.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true)
    }
  })

  it("rejects future share versions and oversize fields", () => {
    // Given: schemaVersion 2, 121-char title, 201 items, overlong end.
    // When: parsed.
    // Then: each fails with a field path.
    expect(SharedPlaylistSchema.safeParse(makeShareBase({ schemaVersion: 2 })).success).toBe(false)
    expect(SharedPlaylistSchema.safeParse(makeShareBase({ title: "x".repeat(121) })).success).toBe(
      false,
    )
    expect(
      SharedPlaylistSchema.safeParse(makeShareBase({ items: makeRangeItems(201) })).success,
    ).toBe(false)
    expect(
      SharedPlaylistSchema.safeParse(
        makeShareBase({
          items: [
            { partId: "p", title: "t", episodeTitle: "e", range: { start: 0, end: 86400001 } },
          ],
        }),
      ).success,
    ).toBe(false)
    // Boundary: exactly 86_400_000 ms and 200 items stay valid.
    expect(
      SharedPlaylistSchema.safeParse(
        makeShareBase({
          items: [
            { partId: "p", title: "t", episodeTitle: "e", range: { start: 0, end: 86400000 } },
          ],
        }),
      ).success,
    ).toBe(true)
  })

  it("rejects non-opaque part ids and bad visibility", () => {
    // Given: partId with URL characters and unknown visibility.
    // When: parsed.
    // Then: both fail.
    expect(
      SharedPlaylistSchema.safeParse(
        makeShareBase({
          items: [
            {
              partId: "https://x/y?z=1",
              title: "t",
              episodeTitle: "e",
              range: { start: 0, end: 1 },
            },
          ],
        }),
      ).success,
    ).toBe(false)
    expect(SharedPlaylistSchema.safeParse(makeShareBase({ visibility: "secret" })).success).toBe(
      false,
    )
  })
})

describe("canonical serialization and hashing", () => {
  it("fixes key order, omits absent optionals and keeps item order", () => {
    // Given: a playlist with optional fields absent on some items.
    // When: canonicalized.
    // Then: fixed alphabetical key order, no undefined keys, original item
    // order kept, tags sorted.
    const parsed = SharedPlaylistSchema.parse(
      makeShareBase({
        author: "a",
        tags: ["b", "a"],
        derivedFrom: { shareId: "abcdefghijklmnopqrstuv", revision: 1 },
        items: [
          { partId: "p2", title: "t2", episodeTitle: "e2", range: { start: 1, end: 2 } },
          {
            partId: "p1",
            workId: "w",
            title: "t1",
            episodeTitle: "e1",
            episodeNumber: "3",
            range: { start: 0, end: 1, name: "OP" },
          },
        ],
      }),
    )
    const text = canonicalString(parsed)
    const topKeys = Object.keys(JSON.parse(text) as Record<string, unknown>)
    expect(topKeys).toEqual([
      "author",
      "derivedFrom",
      "description",
      "items",
      "schemaVersion",
      "tags",
      "title",
      "visibility",
    ])
    expect(text).not.toContain("undefined")
    expect(text.indexOf('"p2"')).toBeLessThan(text.indexOf('"p1"'))
    expect(text).toContain('"tags":["a","b"]')
  })

  it("produces deterministic 64-hex hashes", async () => {
    // Given: the same playlist parsed twice.
    // When: hashed.
    // Then: identical digests, 64 lowercase hex chars.
    const first = SharedPlaylistSchema.parse(makeShareBase())
    const second = SharedPlaylistSchema.parse(makeShareBase())
    const [h1, h2] = await Promise.all([contentHashOf(first), contentHashOf(second)])
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it("ignores local-id-only changes in the public hash", async () => {
    // Given: two local playlists differing only in local ids/urls.
    // When: projected and hashed.
    // Then: identical public hashes.
    const meta = {
      description: "",
      author: "",
      tags: [],
      visibility: "public" as const,
    }
    const left = toPublishProjection(
      {
        id: "local-a",
        name: "共有",
        items: [
          {
            id: "item-a",
            partId: "pt_x",
            title: "T",
            episodeTitle: "E",
            url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=pt_x",
            range: { start: 0, end: 1000, name: "OP" },
          },
        ],
      },
      meta,
    )
    const right = toPublishProjection(
      {
        id: "local-b",
        name: "共有",
        items: [
          {
            id: "item-b",
            partId: "pt_x",
            title: "T",
            episodeTitle: "E",
            url: "https://anime.dmkt-sp.jp/animestore/sc_d_pc?partId=pt_x",
            range: { start: 0, end: 1000, name: "OP" },
          },
        ],
      },
      meta,
    )
    expect(canonicalString(left)).toBe(canonicalString(right))
    expect(await contentHashOf(left)).toBe(await contentHashOf(right))
  })

  it("reports item-specific guidance for unpublishable local playlists", () => {
    // Given: a local playlist holding a null range.
    // When: projected for publish.
    // Then: a typed error names the item index without mutating input.
    const meta = { description: "", author: "", tags: [], visibility: "public" as const }
    const input = {
      id: "pl",
      name: "未設定",
      items: [
        {
          id: "i0",
          partId: "pt_null",
          title: "T",
          episodeTitle: "E",
          range: null,
        },
      ],
    }
    expect(() => toPublishProjection(input, meta)).toThrowError(UnpublishablePlaylistError)
    expect(NULL_RANGE_PLAYLIST.items).toHaveLength(1)
  })
})

describe("public redaction and playback urls", () => {
  it("omits derivedFrom when the parent is not public", () => {
    // Given: a stored snapshot linking to a now-hidden parent.
    // When: projected for public GET.
    // Then: derivedFrom omitted, source null; visible parents keep linkage.
    const playlist = SharedPlaylistSchema.parse(
      makeShareBase({ derivedFrom: { shareId: "abcdefghijklmnopqrstuv", revision: 1 } }),
    )
    const hidden = projectPublicPlaylist({ playlist, parentPublic: false })
    expect(hidden.playlist.derivedFrom).toBeUndefined()
    expect(hidden.source).toBeNull()
    const shown = projectPublicPlaylist({ playlist, parentPublic: true })
    expect(shown.playlist.derivedFrom).toEqual({
      shareId: "abcdefghijklmnopqrstuv",
      revision: 1,
    })
  })

  it("reconstructs playback urls from validated part ids only", () => {
    // Given: a valid opaque part id.
    // When: a playback url is built.
    // Then: fixed supported origin; arbitrary urls never accepted as input.
    expect(buildPlaybackUrl("pt_abc-123")).toBe(
      "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=pt_abc-123",
    )
    expect(() => buildPlaybackUrl("https://evil.example/p")).toThrowError()
  })

  it("enforces the 256 KiB share body cap before parsing", () => {
    // Given: byte counts around the cap.
    // When: checked.
    // Then: over-cap raises, at-cap passes.
    expect(() => checkShareBodySize(262145)).toThrowError(/bytes/)
    expect(checkShareBodySize(262144).ok).toBe(true)
  })
})
