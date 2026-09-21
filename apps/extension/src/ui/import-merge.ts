// Import merge helpers — ports findNameConflicts / mergePlaylists /
// dedupeNames (options.js:596-650) onto the shared LocalPlaylist contract.
// Pure functions over playlist arrays; the caller composes the final library
// (system playlists preserved) and dispatches it via `replace-library`.
import type { LocalPlaylist } from "../../../../packages/shared/src/local-model"

/** Imported playlists whose names collide with existing ones. */
export function findNameConflicts(
  existing: readonly LocalPlaylist[],
  imported: readonly LocalPlaylist[],
): readonly LocalPlaylist[] {
  const existingNames = new Set(existing.map((playlist) => playlist.name))
  return imported.filter((playlist) => existingNames.has(playlist.name))
}

/**
 * Merge `imported` into `existing`. Playlists whose name is in `mergeNames`
 * fold their items into the same-named existing playlist, skipping items whose
 * id or `partId|start|end` content key already exists. All other imported
 * playlists append as new entries.
 */
export function mergePlaylists(
  existing: readonly LocalPlaylist[],
  imported: readonly LocalPlaylist[],
  mergeNames: readonly string[],
): { readonly playlists: readonly LocalPlaylist[]; readonly skipped: number } {
  const mergeNameSet = new Set(mergeNames)
  const result = [...existing]
  let skipped = 0

  for (const importedPlaylist of imported) {
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
        merged.push(item)
        existingKeys.add(item.id)
        if (contentKey !== null) existingKeys.add(contentKey)
      }
      const index = result.indexOf(sameName)
      result[index] = { ...sameName, items: merged }
      continue
    }
    result.push({ ...importedPlaylist })
  }

  return { playlists: result, skipped }
}

/** Rename imported playlists that collide with existing names (`name (n)`)
 *  and mint fresh playlist ids for them. */
export function dedupeNames(
  imported: readonly LocalPlaylist[],
  existing: readonly LocalPlaylist[],
  newId: () => string,
): readonly LocalPlaylist[] {
  const existingNames = new Set(existing.map((playlist) => playlist.name))
  return imported.map((playlist) => {
    if (!existingNames.has(playlist.name)) return playlist
    let counter = 2
    let candidate = `${playlist.name} (${counter})`
    while (existingNames.has(candidate)) {
      counter += 1
      candidate = `${playlist.name} (${counter})`
    }
    existingNames.add(candidate)
    return { ...playlist, name: candidate, id: newId() }
  })
}
