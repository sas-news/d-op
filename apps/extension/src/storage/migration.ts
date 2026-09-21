import {
  LEGACY_MIGRATION_VERSION,
  LEGACY_STORAGE_KEYS,
  LOCAL_SCHEMA_VERSION,
  LOCAL_STATE_KEY,
} from "../../../../packages/shared/src/limits"
import { parseLegacyLibrary } from "../../../../packages/shared/src/local-import"
import {
  type LocalPreferences,
  type LocalV2State,
  LocalV2StateSchema,
} from "../../../../packages/shared/src/local-model"
import type { StorageDriver } from "./driver"

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

export async function loadOrMigrateState(
  driver: StorageDriver,
  now: () => string,
): Promise<LocalV2State> {
  const existing = await driver.get([LOCAL_STATE_KEY])
  if (existing[LOCAL_STATE_KEY] !== undefined) {
    return parseCanonicalState(existing[LOCAL_STATE_KEY])
  }

  const legacy: LegacyValues = await driver.get(LEGACY_STORAGE_KEYS)
  const imported = parseLegacyLibrary(legacy.dop_playlists ?? [])
  const candidate = LocalV2StateSchema.parse({
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
    },
  })
  await driver.set({ [LOCAL_STATE_KEY]: candidate })
  return candidate
}
