// Task-26 shared seed fixtures — the SINGLE source of truth for the legacy
// v1 storage payload exercised by:
//   * tests/browser/upgrade/{chromium,firefox}.mjs — real-browser installed-
//     profile upgrade/rollback rehearsal (`bun run verify:upgrade`);
//   * apps/extension/tests/storage/upgrade-rehearsal.test.ts — module-level
//     fault injection against the real migration code.
//
// Pure data + plain builders only (no node/browser/zod imports) so every
// consumer (Vitest TS, Bun .mjs) can load it. Historical shapes mirror the
// v1.0.0 writer (`git show v1.0.0:common.js`) and the task-3 characterization
// fixtures: modern named ranges, `range.type` predecessors, opRange/edRange/
// customRange fan-out, duplicate ids, missing ids, null ranges, empty
// playlists and intentionally corrupted entries for the quarantine path.

export const LEGACY_KEYS = [
  "dop_playlists",
  "dop_playback",
  "dop_pending",
  "dop_oped_mode",
  "dop_window_mode",
  "dop_collapsed_playlists",
  "dop_player_window",
] as const

export const SEEDED_PLAYLIST_IDS = [
  "pl-modern",
  "pl-typed",
  "pl-fanout",
  "pl-dup",
  "pl-null",
  "pl-baditem",
  "pl-empty",
  "pl-corrupt",
] as const

/** The eight seeded playlist entries — every historical fixture shape. The
 *  last two exercise the quarantine path (one corrupt item, one corrupt
 *  playlist). Order is significant: deterministic id repair depends on the
 *  playlist/item/range ordinals. */
export const LEGACY_PLAYLISTS: readonly Record<string, unknown>[] = [
  {
    id: "pl-modern",
    name: "お気に入りOP集",
    items: [
      {
        id: "m1",
        partId: "pt_aaa-111",
        workId: "wk_100",
        title: "作品A",
        episodeTitle: "第1話",
        episodeNumber: "1",
        url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=pt_aaa-111",
        range: { start: 90_000, end: 180_000, name: "OP" },
      },
      {
        id: "m2",
        partId: "pt_bbb-222",
        title: "作品B",
        episodeTitle: "第3話",
        episodeNumber: "3",
        url: "https://anime.dmkt-sp.jp/animestore/sc_d_pc?partId=pt_bbb-222",
        range: { start: 60_000, end: 150_000, name: "挿入歌" },
      },
    ],
  },
  {
    id: "pl-typed",
    name: "旧形式リスト",
    items: [
      {
        id: "t1",
        partId: "pt_typed",
        workId: "wk_typed",
        title: "旧作",
        episodeTitle: "第2話",
        episodeNumber: "2",
        url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=pt_typed",
        range: { start: 0, end: 90_000, type: "op" },
      },
      {
        id: "t2",
        partId: "pt_typed",
        title: "旧作",
        episodeTitle: "第2話",
        range: { start: 1_320_000, end: 1_410_000, type: "ed" },
      },
      {
        id: "t3",
        partId: "pt_typed",
        title: "旧作",
        episodeTitle: "第2話",
        range: { start: 600_000, end: 660_000, type: "custom" },
      },
    ],
  },
  {
    id: "pl-fanout",
    name: "三分割レガシー",
    items: [
      {
        id: "clip",
        partId: "pt_multi",
        workId: "wk_multi",
        title: "三区切り作品",
        episodeTitle: "第5話",
        episodeNumber: "5",
        url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=pt_multi",
        opRange: { start: 0, end: 90_000 },
        edRange: { start: 1_320_000, end: 1_410_000 },
        customRange: { start: 600_000, end: 660_000 },
      },
    ],
  },
  {
    id: "pl-dup",
    name: "重複IDリスト",
    items: [
      {
        id: "dup-shared-id",
        partId: "pt_a",
        title: "作品A",
        episodeTitle: "第1話",
        range: { start: 0, end: 90_000, name: "OP" },
      },
      {
        id: "dup-shared-id",
        partId: "pt_b",
        title: "作品B",
        episodeTitle: "第1話",
        range: { start: 0, end: 90_000, name: "OP" },
      },
    ],
  },
  {
    id: "pl-null",
    name: "未設定リスト",
    items: [
      {
        id: "n1",
        partId: "pt_null",
        workId: "wk_null",
        title: "範囲未設定作品",
        episodeTitle: "第1話",
        episodeNumber: "1",
        url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=pt_null",
        range: null,
      },
      {
        partId: "pt_noid",
        title: "IDなし作品",
        episodeTitle: "第9話",
        range: { start: 0, end: 30_000 },
      },
    ],
  },
  {
    id: "pl-baditem",
    name: "壊れた項目を含むリスト",
    items: [
      {
        id: "ok1",
        partId: "pt_ok",
        title: "正常項目",
        episodeTitle: "第1話",
        range: { start: 0, end: 90_000, name: "OP" },
      },
      {
        id: "bad1",
        partId: "pt_bad",
        title: "逆行区間",
        episodeTitle: "第2話",
        range: { start: 90_000, end: 1_000, name: "BAD" },
      },
    ],
  },
  { id: "pl-empty", name: "空のリスト", items: [] },
  { id: "pl-corrupt", name: "壊れたリスト", items: null },
]

/** Remaining legacy keys (transient/preferences/private) — preserved verbatim
 *  by the migration, never folded into v2 state. */
export function legacySidecarValues(): Record<string, unknown> {
  return {
    dop_playback: {
      playlistId: "pl-modern",
      index: 1,
      updatedAt: 1_700_000_000_000,
      // Negative windowId — what v1's dopGetWindowId() writes when the windows
      // API is unavailable (service-worker context). A stale POSITIVE id would
      // be deleted by v1's own recoverPlayerState on every SW restart, which
      // would legitimately mutate the snapshot between sessions.
      windowId: -4_242,
    },
    dop_pending: { action: "add", partId: "pt_pending", updatedAt: 1_700_000_000_001 },
    dop_oped_mode: { active: true, updatedAt: 1_700_000_000_002 },
    dop_window_mode: "tab",
    dop_collapsed_playlists: { "pl-modern": true, "pl-typed": false },
    dop_player_window: { id: 4_242, left: 10, top: 20, width: 800, height: 600 },
  }
}

export function legacyStorage(): Record<string, unknown> {
  return { dop_playlists: LEGACY_PLAYLISTS, ...legacySidecarValues() }
}

// --- Hand-computed migration expectations ----------------------------------
// Independent of the parser: these constants are the rehearsal's hand checks;
// the shared-parser oracle is compared on top of them.

export const EXPECTED = {
  migratedPlaylistCount: 7,
  migratedPlaylistIds: [
    "pl-modern",
    "pl-typed",
    "pl-fanout",
    "pl-dup",
    "pl-null",
    "pl-baditem",
    "pl-empty",
  ] as const,
  migratedItemCount: 13,
  quarantinedCount: 2,
  repairedIdCount: 4,
  fanoutIds: ["clip", "clip-c1", "clip-c2"] as const,
  fanoutNames: ["OP", "ED", "CUSTOM"] as const,
  duplicateIds: ["dup-shared-id", "dup-shared-id-c1"] as const,
  repairedMissingItemId: "dop-v1-p4-i1-r0",
  typedRangeNames: ["OP", "ED", "CUSTOM"] as const,
  preferences: {
    windowMode: "tab",
    collapsedPlaylists: { "pl-modern": true, "pl-typed": false },
  },
} as const

// --- Publication record seeds (task-11/15 detach semantics) -----------------
// Schema-valid synthetic PublicationRecords; seeded through the real
// `put-publication` vault command (the same command publish-flow dispatches).

export const SHARE_ID_A = "upgShareA0000000000001" // ShareIdSchema: 22 opaque chars
export const SHARE_ID_B = "upgShareB0000000000002"
export const MANAGE_SECRET_A = `upgManageSecretA${"0".repeat(27)}` // 43 opaque chars
export const MANAGE_SECRET_B = `upgManageSecretB${"0".repeat(27)}`

export function publicationRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    shareId: SHARE_ID_A,
    localPlaylistId: "pl-modern",
    manageSecret: MANAGE_SECRET_A,
    revision: 2,
    contentHash: "a".repeat(64),
    sentSnapshot: JSON.stringify({
      schemaVersion: 1,
      title: "seed snapshot",
      visibility: "public",
      items: [],
    }),
    acknowledgedHash: "b".repeat(64),
    visibility: "public",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    state: "active",
    ...overrides,
  }
}

/** The "newer replace snapshot" imported after the detach: keeps `pl-typed`
 *  (so its linked record stays attached), drops everything else, adds one
 *  fresh playlist. */
export function replacementSnapshot(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    playlists: [
      {
        id: "pl-typed",
        name: "旧形式リスト(改)",
        items: [
          {
            id: "t1",
            partId: "pt_typed",
            title: "旧作",
            episodeTitle: "第2話",
            range: { start: 0, end: 90_000, name: "OP" },
          },
          {
            id: "t-new",
            partId: "pt_newpart",
            title: "新作",
            episodeTitle: "第1話",
            range: { start: 10_000, end: 100_000, name: "ED" },
          },
        ],
      },
      {
        id: "pl-reimport",
        name: "再インポート",
        items: [
          {
            id: "r1",
            partId: "pt_reimport",
            title: "再取得作品",
            episodeTitle: "第4話",
            range: { start: 0, end: 45_000, name: "OP" },
          },
        ],
      },
    ],
  }
}

/** Post-v2 rename applied before export/rollback — proves the v1 snapshot
 *  cannot carry post-v2 edits. */
export const POST_V2_RENAME = "v2編集済みリスト"

/** Playlist id inside the export used for the wipe→re-import equivalence
 *  round trip (the whole exported array is compared, id retained). */
export const FUTURE_STATE = {
  schemaVersion: 3,
  note: "written by a hypothetical newer d-OP",
} as const
