// Transient playback reconciliation for library-scale mutations (Local data
// contract step 6-7): after a committed delete-playlist/replace-library the
// persisted dop_v2_transient.playback pointer may reference a playlist that
// vanished or an index that no longer resolves. The repository clears such a
// dangling pointer so stale playback stops cleanly instead of being resumed
// into a missing playlist; pointers that still resolve are kept untouched.
// Resolution reuses the canonical restore rule (fromTransientPlayback) rather
// than duplicating index/shuffle semantics.
import type { LocalPlaylist } from "../../../../packages/shared/src/local-model"
import { fromTransientPlayback, withPlayback } from "../player/transient-session"
import type { StorageDriver } from "./driver"
import { readTransientState, writeTransientState } from "./transient"

export type TransientReconcileOutcome = "cleared" | "kept" | "no-playback"

export async function reconcileTransientPlayback(
  driver: StorageDriver,
  playlists: readonly LocalPlaylist[],
): Promise<TransientReconcileOutcome> {
  const current = await readTransientState(driver)
  const playback = current.playback
  if (playback === undefined) return "no-playback"
  const playlist = playlists.find((candidate) => candidate.id === playback.playlistId)
  if (playlist !== undefined && fromTransientPlayback(playback, playlist) !== null) {
    return "kept"
  }
  await writeTransientState(driver, {
    ...withPlayback(current, undefined),
    schemaVersion: 1,
    generation: current.generation + 1,
  })
  return "cleared"
}
