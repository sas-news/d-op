// Import merge helpers — ports findNameConflicts / mergePlaylists /
// dedupeNames (options.js:596-650) onto the shared LocalPlaylist contract.
// Pure functions over playlist arrays; the caller composes the final library
// (system playlists preserved) and dispatches it via `replace-library`.
//
// Task-11 hardening: imported ids can collide with the LIVE library (e.g.
// re-importing a file that was already merged, or importing this browser's
// own export under 別名で追加). Live mutations reject duplicate ids outright
// (duplicate-playlist-id / duplicate-item-id), so the import boundary repairs
// colliding imported ids deterministically via allocateId's -cN suffixes —
// existing library ids are never rewritten.
import { allocateId } from "../../../../packages/shared/src/local-legacy"
import type { LocalItem, LocalPlaylist } from "../../../../packages/shared/src/local-model"

/** Imported playlists whose names collide with existing ones. */
export function findNameConflicts(
  existing: readonly LocalPlaylist[],
  imported: readonly LocalPlaylist[],
): readonly LocalPlaylist[] {
  const existingNames = new Set(existing.map((playlist) => playlist.name))
  return imported.filter((playlist) => existingNames.has(playlist.name))
}

type IdUsage = {
  readonly playlistIds: Set<string>
  readonly itemIds: Set<string>
}

function existingIdUsage(existing: readonly LocalPlaylist[]): IdUsage {
  return {
    playlistIds: new Set(existing.map((playlist) => playlist.id)),
    itemIds: new Set(existing.flatMap((playlist) => playlist.items.map((item) => item.id))),
  }
}

/** Deterministic -cN repair for an imported item id that already exists in
 *  the live library (or earlier in this import). */
function repairItemId(item: LocalItem, usage: IdUsage, ordinal: number): LocalItem {
  const allocated = allocateId(item.id, `dop-import-item-${ordinal}`, usage.itemIds)
  usage.itemIds.add(allocated.id)
  return allocated.repaired ? { ...item, id: allocated.id } : item
}

function repairPlaylistId(playlist: LocalPlaylist, usage: IdUsage, ordinal: number): string {
  const allocated = allocateId(playlist.id, `dop-import-playlist-${ordinal}`, usage.playlistIds)
  usage.playlistIds.add(allocated.id)
  return allocated.id
}

/**
 * Merge `imported` into `existing`. Playlists whose name is in `mergeNames`
 * fold their items into the same-named existing playlist, skipping items whose
 * id or `partId|start|end` content key already exists. All other imported
 * playlists append as new entries. Imported playlist/item ids that collide
 * with the live library receive deterministic -cN repairs so the composed
 * library always satisfies the global-id invariant replace-library enforces.
 */
export function mergePlaylists(
  existing: readonly LocalPlaylist[],
  imported: readonly LocalPlaylist[],
  mergeNames: readonly string[],
): { readonly playlists: readonly LocalPlaylist[]; readonly skipped: number } {
  const mergeNameSet = new Set(mergeNames)
  const usage = existingIdUsage(existing)
  const result = [...existing]
  let skipped = 0
  let importedOrdinal = 0

  for (const importedPlaylist of imported) {
    importedOrdinal += 1
    const sameName = result.find((playlist) => playlist.name === importedPlaylist.name)
    if (sameName !== undefined && mergeNameSet.has(importedPlaylist.name)) {
      const existingKeys = new Set<string>()
      for (const item of sameName.items) {
        existingKeys.add(item.id)
        if (item.range !== null) {
          existingKeys.add(`${item.partId}|${item.range.start}|${item.range.end}`)
        }
      }
      const merged = [...sameName.items]
      for (const item of importedPlaylist.items) {
        if (existingKeys.has(item.id)) {
          skipped += 1
          continue
        }
        const contentKey =
          item.range !== null ? `${item.partId}|${item.range.start}|${item.range.end}` : null
        if (contentKey !== null && existingKeys.has(contentKey)) {
          skipped += 1
          continue
        }
        // The id survives the same-name dedupe but may still collide with a
        // DIFFERENT playlist (e.g. this file already imported separately).
        const repaired = repairItemId(item, usage, importedOrdinal)
        merged.push(repaired)
        existingKeys.add(repaired.id)
        if (contentKey !== null) existingKeys.add(contentKey)
      }
      const index = result.indexOf(sameName)
      result[index] = { ...sameName, items: merged }
      continue
    }
    // Appended imported playlist: repair playlist id + item ids against the
    // live library so importing the same file twice cannot produce
    // duplicate-*-id rejections.
    const items = importedPlaylist.items.map((item, index) =>
      repairItemId(item, usage, importedOrdinal * 1000 + index),
    )
    const id = repairPlaylistId(importedPlaylist, usage, importedOrdinal)
    result.push({ ...importedPlaylist, id, items })
  }

  return { playlists: result, skipped }
}

/** Rename imported playlists that collide with existing names (`name (n)`),
 *  mint fresh playlist ids for them, and repair any imported ids that collide
 *  with the live library (importing your own export as separate copies is the
 *  common case). */
export function dedupeNames(
  imported: readonly LocalPlaylist[],
  existing: readonly LocalPlaylist[],
  newId: () => string,
): LocalPlaylist[] {
  const existingNames = new Set(existing.map((playlist) => playlist.name))
  const usage = existingIdUsage(existing)
  let importedOrdinal = 0
  return imported.map((playlist) => {
    importedOrdinal += 1
    const items = playlist.items.map((item, index) =>
      repairItemId(item, usage, importedOrdinal * 1000 + index),
    )
    if (!existingNames.has(playlist.name)) {
      // Even a fresh NAME cannot reuse an existing playlist id.
      const id = usage.playlistIds.has(playlist.id) ? newId() : playlist.id
      usage.playlistIds.add(id)
      return { ...playlist, id, items }
    }
    let counter = 2
    let candidate = `${playlist.name} (${counter})`
    while (existingNames.has(candidate)) {
      counter += 1
      candidate = `${playlist.name} (${counter})`
    }
    existingNames.add(candidate)
    const id = newId()
    usage.playlistIds.add(id)
    return { ...playlist, name: candidate, id, items }
  })
}
