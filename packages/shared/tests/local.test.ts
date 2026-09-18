// Local v2 state, legacy import, and safe export contracts (task 3).
import {
  buildSafeExport,
  checkLocalImportBudget,
  FutureExportVersionError,
  LocalCommandSchema,
  LocalV2StateSchema,
  MalformedExportError,
  parseLegacyLibrary,
  repairMissingId,
} from "@d-op/shared"
import { describe, expect, it } from "vitest"
import {
  DUPLICATE_ID_PLAYLIST,
  FUTURE_ENVELOPE,
  HISTORICAL_ROOT_ARRAY,
  MODERN_PLAYLIST,
  MULTI_RANGE_LEGACY_ITEM,
  NULL_RANGE_PLAYLIST,
  TYPED_RANGE_CUSTOM_ITEM,
  TYPED_RANGE_ED_ITEM,
  TYPED_RANGE_ITEM,
} from "./fixtures"

function modernState(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    revision: 3,
    playlists: [MODERN_PLAYLIST],
    publications: [
      {
        shareId: "abcdefghijklmnopqrstuv",
        localPlaylistId: MODERN_PLAYLIST.id,
        manageSecret: "x".repeat(43),
        revision: 2,
        contentHash: "0".repeat(64),
        sentSnapshot: "sent-canonical",
        acknowledgedHash: "0".repeat(64),
        visibility: "public",
        createdAt: "2026-09-18T00:00:00Z",
        updatedAt: "2026-09-18T01:00:00Z",
        state: "active",
      },
    ],
    pendingCreates: [],
    preferences: { windowMode: "window", collapsedPlaylists: {} },
    appliedOperations: [],
    migrationRecovery: {
      quarantined: [],
      migratedAt: "2026-09-18T00:00:00Z",
      migrationVersion: 1,
      sourceKeys: ["dop_playlists"],
    },
  }
}

describe("local v2 envelope", () => {
  it("parses a complete modern state", () => {
    // Given: a full v2 state value.
    // When: parsed at the boundary.
    // Then: revision, playlists, publications, preferences survive intact.
    const parsed = LocalV2StateSchema.parse(modernState())
    expect(parsed.revision).toBe(3)
    expect(parsed.playlists).toHaveLength(1)
    expect(parsed.publications).toHaveLength(1)
    expect(parsed.preferences.windowMode).toBe("window")
  })

  it("rejects unknown future schema versions closed", () => {
    // Given: schemaVersion 3.
    // When: parsed.
    // Then: the literal check fails with a field path on schemaVersion.
    const result = LocalV2StateSchema.safeParse({ ...modernState(), schemaVersion: 3 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("schemaVersion")
    }
  })

  it("keeps null ranges and empty playlists valid locally", () => {
    // Given: a playlist with a null range plus an empty playlist.
    // When: parsed.
    // Then: both are valid local data (Share refuses them later).
    const parsed = LocalV2StateSchema.parse({
      ...modernState(),
      playlists: [NULL_RANGE_PLAYLIST, { id: "empty-pl", name: "空", items: [] }],
    })
    expect(parsed.playlists).toHaveLength(2)
    expect(parsed.playlists[0]?.items[0]?.range).toBeNull()
  })
})

describe("legacy import parsing", () => {
  it("accepts the historical root array and preserves order/ids/episodeNumber", () => {
    // Given: the historical root-array export shape.
    // When: imported.
    // Then: order, ids, episodeNumber, hosts and millisecond ranges survive.
    const result = parseLegacyLibrary(structuredClone(HISTORICAL_ROOT_ARRAY))
    expect(result.source).toBe("root-array")
    expect(result.quarantined).toHaveLength(0)
    const first = result.playlists[0]?.items[0]
    expect(first?.id).toBe("sample_item_001")
    expect(first?.episodeNumber).toBe("")
    expect(first?.range).toEqual({ start: 90000, end: 180000, name: "OP" })
  })

  it("maps old range.type values to names only while parsing", () => {
    // Given: typed-range items.
    // When: imported.
    // Then: op/ed/custom become OP/ED/CUSTOM names; canonical output is
    // name-only with no `type` key anywhere.
    const result = parseLegacyLibrary({
      schemaVersion: 2,
      playlists: [
        {
          id: "typed-pl",
          name: "旧",
          items: [TYPED_RANGE_ITEM, TYPED_RANGE_ED_ITEM, TYPED_RANGE_CUSTOM_ITEM],
        },
      ],
    })
    expect(result.playlists[0]?.items.map((item) => item.range?.name)).toEqual([
      "OP",
      "ED",
      "CUSTOM",
    ])
    expect(JSON.stringify(result.playlists)).not.toContain('"type"')
  })

  it("fans out multi-range items in op/ed/custom order without dedup", () => {
    // Given: one legacy item with op/ed/custom slots.
    // When: imported.
    // Then: three clips in order, no partId deduplication.
    const result = parseLegacyLibrary([
      { id: "fan-pl", name: "F", items: [MULTI_RANGE_LEGACY_ITEM] },
    ])
    const items = result.playlists[0]?.items ?? []
    expect(items).toHaveLength(3)
    expect(items.map((item) => item.range?.name)).toEqual(["OP", "ED", "CUSTOM"])
    expect(items.map((item) => item.partId)).toEqual(["pt_multi", "pt_multi", "pt_multi"])
  })

  it("repairs duplicate ids without deduplicating clips", () => {
    // Given: two clips sharing one id.
    // When: imported.
    // Then: both clips survive, with a deterministic repaired second id.
    const result = parseLegacyLibrary([DUPLICATE_ID_PLAYLIST])
    const ids = result.playlists[0]?.items.map((item) => item.id) ?? []
    expect(ids).toEqual(["dup-shared-id", "dup-shared-id-c1"])
  })

  it("repairs three duplicate item ids globally and deterministically", () => {
    const input = [
      {
        id: "p",
        name: "P",
        items: [
          { id: "same", partId: "a", title: "A", episodeTitle: "1", range: { start: 0, end: 1 } },
          { id: "same", partId: "b", title: "B", episodeTitle: "1", range: { start: 1, end: 2 } },
          { id: "same", partId: "c", title: "C", episodeTitle: "1", range: { start: 2, end: 3 } },
        ],
      },
    ]
    const first = parseLegacyLibrary(input).playlists[0]?.items.map((item) => item.id)
    const second = parseLegacyLibrary(input).playlists[0]?.items.map((item) => item.id)
    expect(first).toEqual(["same", "same-c1", "same-c2"])
    expect(new Set(first).size).toBe(3)
    expect(second).toEqual(first)
  })

  it("repairs item and playlist collisions across the whole library", () => {
    const input = [
      {
        id: "same-playlist",
        name: "A",
        items: [
          {
            id: "same-item",
            partId: "a",
            title: "A",
            episodeTitle: "1",
            range: { start: 0, end: 1 },
          },
        ],
      },
      {
        id: "same-playlist",
        name: "B",
        items: [
          {
            id: "same-item",
            partId: "b",
            title: "B",
            episodeTitle: "1",
            range: { start: 1, end: 2 },
          },
        ],
      },
      {
        name: "C",
        items: [{ partId: "c", title: "C", episodeTitle: "1", range: { start: 2, end: 3 } }],
      },
    ]
    const result = parseLegacyLibrary(input)
    expect(result.playlists.map((playlist) => playlist.id)).toEqual([
      "same-playlist",
      "same-playlist-c1",
      "dop-v1-playlist-2",
    ])
    expect(result.playlists.flatMap((playlist) => playlist.items.map((item) => item.id))).toEqual([
      "same-item",
      "same-item-c1",
      "dop-v1-p2-i0-r0",
    ])
  })

  it("bounds collisions for a 256-character valid id", () => {
    const id = "x".repeat(256)
    const input = [
      {
        id: "boundary",
        name: "Boundary",
        items: [
          { id, partId: "a", title: "A", episodeTitle: "1", range: { start: 0, end: 1 } },
          { id, partId: "b", title: "B", episodeTitle: "1", range: { start: 1, end: 2 } },
        ],
      },
    ]
    const first = parseLegacyLibrary(input).playlists[0]?.items.map((item) => item.id) ?? []
    const second = parseLegacyLibrary(input).playlists[0]?.items.map((item) => item.id) ?? []
    expect(first).toEqual(second)
    expect(new Set(first).size).toBe(2)
    expect(first.every((itemId) => itemId.length <= 256 && /^[A-Za-z0-9_-]+$/.test(itemId))).toBe(
      true,
    )
  }, 1000)

  it("quarantines invalid entries with original bytes and field paths", () => {
    // Given: one valid and one end-before-start item.
    // When: imported.
    // Then: the bad entry is quarantined (original JSON + issue paths),
    // the good entry imports, nothing is silently dropped.
    const bad = {
      id: "bad-1",
      partId: "pt_bad",
      title: "壊",
      episodeTitle: "第1話",
      range: { start: 5000, end: 5000 },
    }
    const result = parseLegacyLibrary([
      { id: "mix-pl", name: "M", items: [MODERN_PLAYLIST.items[0], bad] },
    ])
    expect(result.playlists[0]?.items).toHaveLength(1)
    expect(result.quarantined).toHaveLength(1)
    expect(result.quarantined[0]?.originalJson).toContain("bad-1")
    expect(result.quarantined[0]?.issues.length).toBeGreaterThan(0)
  })

  it("rejects unknown future export versions without downgrading", () => {
    // Given: schemaVersion 3 envelope.
    // When: imported.
    // Then: a typed future-version error carries the version, no state made.
    expect(() => parseLegacyLibrary(structuredClone(FUTURE_ENVELOPE))).toThrowError(
      FutureExportVersionError,
    )
    try {
      parseLegacyLibrary(structuredClone(FUTURE_ENVELOPE))
    } catch (error) {
      expect(error).toBeInstanceOf(FutureExportVersionError)
      if (error instanceof FutureExportVersionError) {
        expect(error.version).toBe(3)
      }
    }
  })

  it("rejects a v2 envelope whose playlists value is not an array", () => {
    expect(() => parseLegacyLibrary({ schemaVersion: 2, playlists: {} })).toThrowError(
      MalformedExportError,
    )
  })

  it("rejects oversize local libraries without partial import", () => {
    // Given: byte/item budgets.
    // When: checked.
    // Then: over-budget inputs raise before any parsing work.
    expect(() =>
      checkLocalImportBudget({ byteLength: 10 * 1024 * 1024 + 1, itemCount: 1 }),
    ).toThrowError(/byte/i)
    expect(() => checkLocalImportBudget({ byteLength: 10, itemCount: 10001 })).toThrowError(/item/i)
    expect(checkLocalImportBudget({ byteLength: 10, itemCount: 3 }).ok).toBe(true)
  })
})

describe("deterministic id repair", () => {
  it("derives stable ids from migration ordinals", () => {
    // Given: fixed migration ordinals.
    // When: repaired twice.
    // Then: identical opaque ids both times.
    const first = repairMissingId({
      migrationVersion: 1,
      playlistOrdinal: 0,
      itemOrdinal: 2,
      rangeOrdinal: 1,
    })
    const second = repairMissingId({
      migrationVersion: 1,
      playlistOrdinal: 0,
      itemOrdinal: 2,
      rangeOrdinal: 1,
    })
    expect(first).toBe(second)
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe("safe export whitelist", () => {
  it("excludes publications, secrets, playback and urls but keeps ids", () => {
    // Given: full v2 state with publication vault entries.
    // When: exported portably.
    // Then: only schemaVersion+playlists with local ids and episodeNumber;
    // no manageSecret, publications, urls, window or playback fields.
    const exported = buildSafeExport(LocalV2StateSchema.parse(modernState()))
    expect(exported.schemaVersion).toBe(2)
    const text = JSON.stringify(exported)
    expect(text).not.toContain("manageSecret")
    expect(text).not.toContain("publications")
    expect(text).not.toContain("pendingCreates")
    expect(text).not.toContain('"url"')
    expect(text).not.toContain("windowId")
    expect(text).toContain("123e4567-e89b-12d3-a456-426614174001")
  })
})

describe("local mutation commands", () => {
  it("requires operationId and expectedRevision on every command", () => {
    // Given: a rename command missing its correlation fields.
    // When: parsed.
    // Then: validation fails; a complete command parses with its kind.
    const bad = LocalCommandSchema.safeParse({
      kind: "rename-playlist",
      playlistId: "p",
      name: "n",
    })
    expect(bad.success).toBe(false)
    const good = LocalCommandSchema.parse({
      kind: "rename-playlist",
      operationId: "123e4567-e89b-12d3-a456-426614174000",
      expectedRevision: 3,
      playlistId: "p",
      name: "n",
    })
    expect(good.kind).toBe("rename-playlist")
  })
})
