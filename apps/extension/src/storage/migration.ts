import {
  LEGACY_MIGRATION_VERSION,
  LEGACY_STORAGE_KEYS,
  LOCAL_SCHEMA_VERSION,
  LOCAL_STATE_KEY,
  MIGRATION_PARSER_VERSION,
} from "../../../../packages/shared/src/limits"
import {
  legacyPlaylistArray,
  parseLegacyLibrary,
} from "../../../../packages/shared/src/local-import"
import { allocateId, PlaylistInputSchema } from "../../../../packages/shared/src/local-legacy"
import {
  type LocalItem,
  type LocalPlaylist,
  type LocalPreferences,
  type LocalV2State,
  LocalV2StateSchema,
} from "../../../../packages/shared/src/local-model"
import type { StorageDriver } from "./driver"

const LEGACY_PLAYLISTS_KEY = "dop_playlists"

type LegacyValues = Readonly<Record<string, unknown>> & {
  readonly dop_collapsed_playlists?: unknown
  readonly dop_playlists?: unknown
  readonly dop_window_mode?: unknown
}

export class FutureLocalSchemaError extends Error {
  override readonly name = "FutureLocalSchemaError"

  constructor(readonly version: unknown) {
    super("stored local state uses an unsupported future schema")
  }
}

export class MalformedLocalStateError extends Error {
  override readonly name = "MalformedLocalStateError"

  constructor(readonly paths: readonly string[]) {
    super("stored local state is malformed")
  }
}

function parsePreferences(legacy: LegacyValues): LocalPreferences {
  const rawCollapsed = legacy.dop_collapsed_playlists
  const collapsedPlaylists: Record<string, boolean> = {}
  if (typeof rawCollapsed === "object" && rawCollapsed !== null && !Array.isArray(rawCollapsed)) {
    for (const [playlistId, collapsed] of Object.entries(rawCollapsed)) {
      if (typeof collapsed === "boolean") collapsedPlaylists[playlistId] = collapsed
    }
  }
  return {
    windowMode: legacy.dop_window_mode === "tab" ? "tab" : "window",
    collapsedPlaylists,
  }
}

function parseCanonicalState(raw: unknown): LocalV2State {
  if (typeof raw === "object" && raw !== null && "schemaVersion" in raw) {
    const version = raw.schemaVersion
    if (typeof version === "number" && version > LOCAL_SCHEMA_VERSION) {
      throw new FutureLocalSchemaError(version)
    }
  }
  const parsed = LocalV2StateSchema.safeParse(raw)
  if (!parsed.success) {
    throw new MalformedLocalStateError(
      parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
    )
  }
  return parsed.data
}

function safeOriginalJson(raw: unknown): string {
  const json = JSON.stringify(raw)
  const text = json === undefined || json.length === 0 ? "null" : json
  return text.slice(0, 65536) || "null"
}

/** Builds the initial v2 state from whatever the legacy keys hold. An
 *  unreadable dop_playlists payload (non-JSON string, corrupt envelope,
 *  oversize) used to reject initialize() forever — the legacy snapshot was
 *  intact yet every surface rendered empty. The payload is now parked in
 *  quarantine so the extension still comes up, and the legacy keys stay
 *  untouched for a later repair. */
function buildMigratedState(legacy: LegacyValues, now: () => string): LocalV2State {
  let imported: ReturnType<typeof parseLegacyLibrary>
  try {
    imported = parseLegacyLibrary(legacy.dop_playlists ?? [])
  } catch (error) {
    const reason =
      error instanceof Error && error.message.length > 0
        ? error.message.slice(0, 500)
        : "legacy payload unreadable"
    imported = {
      source: "root-array",
      playlists: [],
      quarantined: [
        {
          playlistIndex: 0,
          originalJson: safeOriginalJson(legacy.dop_playlists),
          issues: ["dop_playlists"],
          reason,
        },
      ],
      repairedIdCount: 0,
      playlistOrigins: [],
      itemOrigins: [],
    }
  }
  return LocalV2StateSchema.parse({
    schemaVersion: LOCAL_SCHEMA_VERSION,
    revision: 0,
    playlists: imported.playlists,
    publications: [],
    pendingCreates: [],
    preferences: parsePreferences(legacy),
    appliedOperations: [],
    migrationRecovery: {
      quarantined: imported.quarantined,
      migratedAt: now(),
      migrationVersion: LEGACY_MIGRATION_VERSION,
      sourceKeys: [...LEGACY_STORAGE_KEYS],
      parserVersion: MIGRATION_PARSER_VERSION,
    },
  })
}

/** Whether the legacy playlist at index p survived the v2.0.0 importer and
 *  therefore consumed a playlist id. Replicates the old importer's gate:
 *  PlaylistInputSchema + array items + a name satisfying min(1)/max(200).
 *  Item validity did NOT gate playlist id allocation. */
function strictPlaylistSurvived(candidate: { readonly name?: unknown }): boolean {
  const name = candidate.name
  return typeof name === "string" && name.length >= 1 && name.length <= 200
}

/** v2.0.0-era states hold quarantined entries the old importer dropped — most
 *  visibly clips with empty workId/partId fields that v1 wrote routinely.
 *  Since the canonical envelope already exists, the legacy keys are replayed
 *  through the current (lenient) importer and merged in: surviving playlists
 *  gain any items that were quarantined, playlists the old importer rejected
 *  whole are appended, and entries the new importer still cannot parse stay
 *  quarantined. Existing items win on id collision — user edits made after
 *  the first migration are never overwritten. */
async function repairQuarantined(
  state: LocalV2State,
  driver: StorageDriver,
): Promise<LocalV2State> {
  const recovery = state.migrationRecovery
  if (recovery === undefined) return state
  if ((recovery.parserVersion ?? 1) >= MIGRATION_PARSER_VERSION) return state

  const stamp = { ...recovery, parserVersion: MIGRATION_PARSER_VERSION }
  const rawArray = legacyPlaylistArray(
    (await driver.get([LEGACY_PLAYLISTS_KEY]))[LEGACY_PLAYLISTS_KEY],
  )
  if (rawArray === undefined) {
    // The legacy snapshot is gone (or unreadable even leniently) — record the
    // attempt so the check does not rerun forever, keep the old quarantine.
    const upgraded = {
      ...state,
      revision: state.revision + 1,
      migrationRecovery: { ...stamp, quarantined: recovery.quarantined },
    }
    await driver.set({ [LOCAL_STATE_KEY]: upgraded })
    return upgraded
  }

  // Map surviving legacy playlists to the ids the v2.0.0 importer assigned.
  let relaxed: ReturnType<typeof parseLegacyLibrary>
  try {
    relaxed = parseLegacyLibrary(rawArray)
  } catch {
    const upgraded = {
      ...state,
      revision: state.revision + 1,
      migrationRecovery: { ...stamp, quarantined: recovery.quarantined },
    }
    await driver.set({ [LOCAL_STATE_KEY]: upgraded })
    return upgraded
  }

  const strictIdByIndex = new Map<number, string>()
  const strictUsedIds = new Set<string>()
  rawArray.forEach((raw, p) => {
    const candidate = PlaylistInputSchema.safeParse(raw)
    if (!candidate.success || !Array.isArray(candidate.data.items)) return
    if (!strictPlaylistSurvived(candidate.data)) return
    const allocated = allocateId(
      typeof candidate.data.id === "string" ? candidate.data.id : undefined,
      `dop-v${LEGACY_MIGRATION_VERSION}-playlist-${p}`,
      strictUsedIds,
    )
    strictUsedIds.add(allocated.id)
    strictIdByIndex.set(p, allocated.id)
  })

  const playlists: LocalPlaylist[] = [...state.playlists]
  const playlistById = new Map(playlists.map((playlist) => [playlist.id, playlist]))
  const usedPlaylistIds = new Set(playlists.map((playlist) => playlist.id))
  const usedItemIds = new Set(
    playlists.flatMap((playlist) => playlist.items.map((item) => item.id)),
  )
  // Only items whose source entry was quarantined are candidates — anything
  // else missing from the stored playlist was deleted by the user since the
  // first migration and must stay deleted.
  const quarantinedItemSources = new Set(
    recovery.quarantined
      .filter((entry) => entry.itemIndex !== undefined)
      .map((entry) => `${entry.playlistIndex}:${entry.itemIndex}`),
  )

  relaxed.playlists.forEach((repaired, index) => {
    const sourceIndex = relaxed.playlistOrigins[index]
    if (sourceIndex === undefined) return
    const legacyId = strictIdByIndex.get(sourceIndex)
    const existing = legacyId === undefined ? undefined : playlistById.get(legacyId)
    if (legacyId !== undefined && existing === undefined) {
      // The playlist migrated under v2.0.0 but is gone now: the user deleted
      // it after upgrading. Never resurrect deleted playlists.
      return
    }
    if (existing !== undefined) {
      const missing = repaired.items.filter((item, i) => {
        const source = relaxed.itemOrigins[index]?.[i]
        return (
          source !== undefined &&
          quarantinedItemSources.has(`${sourceIndex}:${source}`) &&
          !usedItemIds.has(item.id)
        )
      })
      if (missing.length === 0) return
      for (const item of missing) usedItemIds.add(item.id)
      const position = playlists.indexOf(existing)
      playlists[position] = { ...existing, items: [...existing.items, ...missing] }
      return
    }
    // Quarantined by the old importer, recoverable now — append as a new
    // playlist (fresh id if its deterministic one was consumed by a survivor).
    const items: LocalItem[] = repaired.items.map((item) => {
      if (!usedItemIds.has(item.id)) {
        usedItemIds.add(item.id)
        return item
      }
      const allocated = allocateId(
        undefined,
        `dop-v${LEGACY_MIGRATION_VERSION}-restored-${item.id.slice(0, 200)}`,
        usedItemIds,
      )
      usedItemIds.add(allocated.id)
      return { ...item, id: allocated.id }
    })
    const playlistId = allocateId(repaired.id, repaired.id, usedPlaylistIds)
    usedPlaylistIds.add(playlistId.id)
    playlists.push({ id: playlistId.id, name: repaired.name, items })
  })

  const upgraded = {
    ...state,
    playlists,
    revision: state.revision + 1,
    migrationRecovery: { ...stamp, quarantined: [...relaxed.quarantined] },
  }
  await driver.set({ [LOCAL_STATE_KEY]: upgraded })
  return upgraded
}

export async function loadOrMigrateState(
  driver: StorageDriver,
  now: () => string,
): Promise<LocalV2State> {
  const existing = await driver.get([LOCAL_STATE_KEY])
  if (existing[LOCAL_STATE_KEY] !== undefined) {
    const state = parseCanonicalState(existing[LOCAL_STATE_KEY])
    try {
      return await repairQuarantined(state, driver)
    } catch {
      // Repair is best-effort: a failed write must not wedge initialize().
      return state
    }
  }

  const legacy: LegacyValues = await driver.get(LEGACY_STORAGE_KEYS)
  const candidate = buildMigratedState(legacy, now)
  await driver.set({ [LOCAL_STATE_KEY]: candidate })
  return candidate
}
