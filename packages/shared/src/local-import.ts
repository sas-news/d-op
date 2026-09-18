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
  readonly name = "FutureExportVersionError"
  constructor(readonly version: unknown) {
    super(`unsupported export version: ${JSON.stringify(version)}`)
  }
}
export class MalformedExportError extends Error {
  readonly name = "MalformedExportError"
  constructor(readonly path: string) {
    super(`malformed export at ${path}`)
  }
}
export type LegacyImportResult = {
  readonly source: "envelope-v2" | "root-array"
  readonly playlists: readonly LocalPlaylist[]
  readonly quarantined: readonly QuarantineEntry[]
  readonly repairedIdCount: number
}

export function parseLegacyLibrary(input: unknown): LegacyImportResult {
  if (Array.isArray(input)) return importPlaylists(input, "root-array")
  if (typeof input !== "object" || input === null) throw new MalformedExportError("root")
  const envelope = input as { readonly schemaVersion?: unknown; readonly playlists?: unknown }
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
  let repairedIdCount = 0
  const usedPlaylistIds = new Set<string>()
  const usedItemIds = new Set<string>()
  rawPlaylists.forEach((raw, p) => {
    const candidate = PlaylistInputSchema.safeParse(raw)
    if (!candidate.success || !Array.isArray(candidate.data.items)) {
      quarantined.push({
        playlistIndex: p,
        originalJson: JSON.stringify(raw).slice(0, 65536),
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
    candidate.data.items.forEach((rawItem, i) => {
      const item = ItemInputSchema.safeParse(rawItem)
      if (!item.success) {
        quarantined.push({
          playlistIndex: p,
          itemIndex: i,
          originalJson: JSON.stringify(rawItem),
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
            originalJson: JSON.stringify(rawItem).slice(0, 65536),
            issues: parsed.error.issues.map(
              (issue) => `items.${i}.${issue.path.map(String).join(".")}`,
            ),
            reason: parsed.error.issues[0]?.message ?? "invalid item",
          })
          return
        }
        usedItemIds.add(parsed.data.id)
        items.push(parsed.data)
      })
    })
    const playlistId = allocateId(
      typeof candidate.data.id === "string" ? candidate.data.id : undefined,
      `dop-v${LEGACY_MIGRATION_VERSION}-playlist-${p}`,
      usedPlaylistIds,
    )
    const playlist = LocalPlaylistSchema.safeParse({
      id: playlistId.id,
      name: candidate.data.name,
      items,
    })
    if (!playlist.success) {
      quarantined.push({
        playlistIndex: p,
        originalJson: JSON.stringify(raw).slice(0, 65536),
        issues: playlist.error.issues.map((issue) => issue.path.map(String).join(".")),
        reason: playlist.error.issues[0]?.message ?? "invalid playlist",
      })
      return
    }
    usedPlaylistIds.add(playlist.data.id)
    if (playlistId.repaired) repairedIdCount += 1
    playlists.push(playlist.data)
  })
  return { source, playlists, quarantined, repairedIdCount }
}
