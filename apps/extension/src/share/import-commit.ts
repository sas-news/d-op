// Commit a validated shared snapshot as a fresh INDEPENDENT local playlist
// (task 17). Conversion mints new local playlist/item ids — never reuses
// share-side ids — and deliberately drops everything not in the local model
// (no url on items; no manageSecret/publication record anywhere). The commit
// runs through the repository's single serialized `replace-library` command
// so the import is atomic: either the whole playlist lands or nothing does.
import type { GetPlaylistResponse } from "../../../../packages/shared/src/api"
import type { LocalItem, LocalPlaylist } from "../../../../packages/shared/src/local-model"
import type { StorageDriver } from "../storage/driver"
import type { LocalRepository } from "../storage/repository"
import { appendImportRecord, type ImportRecord } from "./provenance"

export type ImportCommitResult =
  | {
      readonly kind: "committed"
      readonly playlistId: string
      readonly revision: number
      readonly provenance: "written" | "failed"
    }
  | { readonly kind: "failed"; readonly reason: string }

function toLocalPlaylist(response: GetPlaylistResponse, newId: () => string): LocalPlaylist {
  const items: LocalItem[] = response.playlist.items.map((item) => ({
    id: newId(),
    partId: item.partId,
    ...(item.workId === undefined ? {} : { workId: item.workId }),
    title: item.title,
    episodeTitle: item.episodeTitle,
    ...(item.episodeNumber === undefined ? {} : { episodeNumber: item.episodeNumber }),
    range: {
      start: item.range.start,
      end: item.range.end,
      ...(item.range.name === undefined ? {} : { name: item.range.name }),
    },
  }))
  return { id: newId(), name: response.playlist.title, items }
}

export type CommitImportOptions = {
  readonly repository: LocalRepository
  readonly driver: StorageDriver
  readonly response: GetPlaylistResponse
  /** Idempotent operation id — reuse the page requestId so retries replay. */
  readonly operationId: string
  readonly newId: () => string
  readonly now: () => string
  readonly maxAttempts?: number
}

export async function commitImport(options: CommitImportOptions): Promise<ImportCommitResult> {
  // Generate the playlist ONCE: retrying with identical payload keeps the
  // operation hash stable, so a lost reply replays the original receipt
  // instead of colliding as an operation-conflict.
  const playlist = toLocalPlaylist(options.response, options.newId)
  const maxAttempts = options.maxAttempts ?? 3
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await options.repository.readPublic()
    const reply = await options.repository.dispatch({
      kind: "replace-library",
      operationId: options.operationId,
      expectedRevision: current.revision,
      playlists: [...current.playlists, playlist],
    })
    if (reply.kind === "revision-conflict") continue
    if (reply.kind !== "committed") {
      return { kind: "failed", reason: `commit-${reply.kind}` }
    }
    const record: ImportRecord = {
      playlistId: playlist.id,
      shareId: options.response.shareId,
      revision: options.response.revision,
      contentHash: options.response.contentHash,
      title: options.response.playlist.title,
      itemCount: playlist.items.length,
      importedAt: options.now(),
    }
    let provenance: "written" | "failed" = "written"
    try {
      const live = [...current.playlists.map((entry) => entry.id), playlist.id]
      await appendImportRecord(options.driver, record, live)
    } catch {
      provenance = "failed" // advisory only; the committed playlist stands
    }
    return { kind: "committed", playlistId: playlist.id, revision: reply.revision, provenance }
  }
  return { kind: "failed", reason: "commit-revision-conflict" }
}
