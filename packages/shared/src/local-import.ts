import { LEGACY_MIGRATION_VERSION, LOCAL_IMPORT_MAX_ITEMS, LOCAL_SCHEMA_VERSION } from "./limits"
import {
  allocateId,
  fanOutLegacyItem,
  ItemInputSchema,
  PlaylistInputSchema,
  repairMissingId,
} from "./local-legacy"
import type { LocalItem, LocalPlaylist, QuarantineEntry } from "./local-model"
import { LocalItemSchema, LocalPlaylistSchema } from "./local-model"
import { OversizePayloadError } from "./share-errors"

export { mapLegacyRangeTypeToName, repairMissingId } from "./local-legacy"

export class FutureExportVersionError extends Error {
  override readonly name = "FutureExportVersionError"
  constructor(readonly version: unknown) {
    super(`unsupported export version: ${JSON.stringify(version)}`)
  }
}
export class MalformedExportError extends Error {
  override readonly name = "MalformedExportError"
  constructor(readonly path: string) {
    super(`malformed export at ${path}`)
  }
}
export type LegacyImportResult = {
  readonly source: "envelope-v2" | "root-array"
  readonly playlists: readonly LocalPlaylist[]
  readonly quarantined: readonly QuarantineEntry[]
  readonly repairedIdCount: number
  /** Original array index of every migrated playlist (repair needs it to map
   *  recovered entries back onto the playlists the first migration created). */
  readonly playlistOrigins: readonly number[]
  /** Per migrated playlist, the source item index of every migrated item —
   *  parallel to `playlists[i].items`. Repair merges back only items whose
   *  source entry was actually quarantined, so user deletions stay deleted. */
  readonly itemOrigins: readonly (readonly number[])[]
}

/** Extracts the raw playlist array from a legacy payload. Accepts the plain
 *  root array, the v2 export envelope, and either form as a JSON string —
 *  devtools edits and some export channels have been observed to persist
 *  `dop_playlists` stringified, which previously made the whole migration
 *  fail closed with an unreadable library. */
export function legacyPlaylistArray(input: unknown): readonly unknown[] | undefined {
  let value = input
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (Array.isArray(value)) return value
  if (typeof value === "object" && value !== null) {
    const playlists = (value as { readonly playlists?: unknown }).playlists
    if (Array.isArray(playlists)) return playlists
  }
  return undefined
}

function safeOriginalJson(raw: unknown): string {
  const json = JSON.stringify(raw)
  const text = json === undefined || json.length === 0 ? "null" : json
  return text.slice(0, 65536) || "null"
}

export function parseLegacyLibrary(input: unknown): LegacyImportResult {
  let value = input
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      throw new MalformedExportError("root")
    }
  }
  if (Array.isArray(value)) return importPlaylists(value, "root-array")
  if (typeof value !== "object" || value === null) throw new MalformedExportError("root")
  const envelope = value as { readonly schemaVersion?: unknown; readonly playlists?: unknown }
  if (envelope.schemaVersion !== LOCAL_SCHEMA_VERSION)
    throw new FutureExportVersionError(envelope.schemaVersion)
  if (!Array.isArray(envelope.playlists)) throw new MalformedExportError("playlists")
  return importPlaylists(envelope.playlists, "envelope-v2")
}
function importPlaylists(
  rawPlaylists: readonly unknown[],
  source: LegacyImportResult["source"],
): LegacyImportResult {
  const totalItems = rawPlaylists.reduce<number>(
    (count, raw) =>
      typeof raw === "object" && raw !== null && "items" in raw && Array.isArray(raw.items)
        ? count + raw.items.length
        : count,
    0,
  )
  if (totalItems > LOCAL_IMPORT_MAX_ITEMS)
    throw new OversizePayloadError("local-import", totalItems, LOCAL_IMPORT_MAX_ITEMS, "items")
  const playlists: LocalPlaylist[] = []
  const quarantined: QuarantineEntry[] = []
  const playlistOrigins: number[] = []
  const itemOrigins: number[][] = []
  let repairedIdCount = 0
  const usedPlaylistIds = new Set<string>()
  const usedItemIds = new Set<string>()
  rawPlaylists.forEach((raw, p) => {
    const candidate = PlaylistInputSchema.safeParse(raw)
    if (!candidate.success || !Array.isArray(candidate.data.items)) {
      quarantined.push({
        playlistIndex: p,
        originalJson: safeOriginalJson(raw),
        issues: [`playlists.${p}.items`],
        reason: "playlist entry or items is invalid",
      })
      return
    }
    if (candidate.data.items.length > LOCAL_IMPORT_MAX_ITEMS)
      throw new OversizePayloadError(
        "local-import",
        candidate.data.items.length,
        LOCAL_IMPORT_MAX_ITEMS,
        "items",
      )
    const items: LocalItem[] = []
    const origins: number[] = []
    candidate.data.items.forEach((rawItem, i) => {
      const item = ItemInputSchema.safeParse(rawItem)
      if (!item.success) {
        quarantined.push({
          playlistIndex: p,
          itemIndex: i,
          originalJson: safeOriginalJson(rawItem),
          issues: [`items.${i}`],
          reason: "item entry is invalid",
        })
        return
      }
      fanOutLegacyItem(item.data, p, i).forEach((entry, r) => {
        let parsed = LocalItemSchema.safeParse(entry.raw)
        if (parsed.success) {
          const allocated = allocateId(
            parsed.data.id,
            repairMissingId({
              migrationVersion: LEGACY_MIGRATION_VERSION,
              playlistOrdinal: p,
              itemOrdinal: i,
              rangeOrdinal: r,
            }),
            usedItemIds,
          )
          parsed = LocalItemSchema.safeParse({ ...parsed.data, id: allocated.id })
          if (allocated.repaired || entry.repaired) repairedIdCount += 1
        }
        if (!parsed.success) {
          quarantined.push({
            playlistIndex: p,
            itemIndex: i,
            originalJson: safeOriginalJson(rawItem),
            issues: parsed.error.issues.map(
              (issue) => `items.${i}.${issue.path.map(String).join(".")}`,
            ),
            reason: parsed.error.issues[0]?.message ?? "invalid item",
          })
          return
        }
        usedItemIds.add(parsed.data.id)
        items.push(parsed.data)
        origins.push(i)
      })
    })
    const playlistId = allocateId(
      typeof candidate.data.id === "string" ? candidate.data.id : undefined,
      `dop-v${LEGACY_MIGRATION_VERSION}-playlist-${p}`,
      usedPlaylistIds,
    )
    // v1 allowed empty/blank playlist names; the strict schema does not, so
    // recover with a deterministic fallback rather than losing the playlist.
    const coercedName =
      typeof candidate.data.name === "number" && Number.isFinite(candidate.data.name)
        ? String(candidate.data.name)
        : typeof candidate.data.name === "string"
          ? candidate.data.name
          : ""
    const trimmedName = coercedName.trim().slice(0, 200)
    const playlist = LocalPlaylistSchema.safeParse({
      id: playlistId.id,
      name: trimmedName.length > 0 ? trimmedName : `プレイリスト ${p + 1}`,
      items,
    })
    if (!playlist.success) {
      quarantined.push({
        playlistIndex: p,
        originalJson: safeOriginalJson(raw),
        issues: playlist.error.issues.map((issue) => issue.path.map(String).join(".")),
        reason: playlist.error.issues[0]?.message ?? "invalid playlist",
      })
      return
    }
    usedPlaylistIds.add(playlist.data.id)
    if (playlistId.repaired) repairedIdCount += 1
    playlists.push(playlist.data)
    playlistOrigins.push(p)
    itemOrigins.push(origins)
  })
  return { source, playlists, quarantined, repairedIdCount, playlistOrigins, itemOrigins }
}
