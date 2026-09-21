// Dirty-state computation for managed publications (task 15). The vault
// record keeps the IMMUTABLE canonical snapshot that was last sent
// (`sentSnapshot`) plus the hash the server last acknowledged
// (`acknowledgedHash`). Dirty = the CURRENT local publish projection hashed
// and compared to `acknowledgedHash` — never timestamps, never cached flags.
// A network wait writes only the sent snapshot into the record, so edits made
// while a request is in flight still compare dirty afterwards.
import type { PublicationRecord } from "../../../../packages/shared/src/local-model"
import { contentHashOf } from "../../../../packages/shared/src/share-canonical"
import type {
  PublishMetadata,
  SharedPlaylist,
  UnpublishableReason,
} from "../../../../packages/shared/src/share-model"
import {
  SharedPlaylistSchema,
  UnpublishablePlaylistError,
} from "../../../../packages/shared/src/share-model"
import {
  type PublishableLocalPlaylist,
  toPublishProjection,
} from "../../../../packages/shared/src/share-projection"

export type PublicationDirty =
  | { readonly kind: "clean" }
  | { readonly kind: "dirty" }
  /** Detached record (local playlist deleted) — nothing local to compare. */
  | { readonly kind: "detached" }
  | { readonly kind: "unpublishable"; readonly reasons: readonly UnpublishableReason[] }
  /** Stored sentSnapshot no longer parses — fail visibly, treat as dirty. */
  | { readonly kind: "snapshot-invalid" }

/**
 * Publish metadata captured inside the last acknowledged snapshot — the
 * dialog prefills from this and update preserves fields the caller leaves
 * unset (visibility/derivedFrom carry over unless explicitly changed).
 */
export function snapshotMetadata(record: PublicationRecord): PublishMetadata | undefined {
  let json: unknown
  try {
    json = JSON.parse(record.sentSnapshot)
  } catch {
    return undefined
  }
  const parsed = SharedPlaylistSchema.safeParse(json)
  if (!parsed.success) return undefined
  return metadataOf(parsed.data)
}

function metadataOf(snapshot: SharedPlaylist): PublishMetadata {
  return {
    description: snapshot.description,
    author: snapshot.author,
    tags: snapshot.tags,
    visibility: snapshot.visibility,
    ...(snapshot.derivedFrom === undefined ? {} : { derivedFrom: snapshot.derivedFrom }),
  }
}

/**
 * Recompute the current dirty status of `record` against the CURRENT local
 * playlist. The projection uses the publish metadata recorded in the sent
 * snapshot, so the comparison isolates local edits (title/items/ranges).
 */
export async function publicationDirty(
  record: PublicationRecord,
  playlist: PublishableLocalPlaylist | null | undefined,
): Promise<PublicationDirty> {
  if (record.localPlaylistId === null || playlist === null || playlist === undefined) {
    return { kind: "detached" }
  }
  const metadata = snapshotMetadata(record)
  if (metadata === undefined) return { kind: "snapshot-invalid" }
  let projection: SharedPlaylist
  try {
    projection = toPublishProjection(playlist, metadata)
  } catch (error) {
    if (error instanceof UnpublishablePlaylistError) {
      return { kind: "unpublishable", reasons: error.reasons }
    }
    throw error
  }
  const hash = await contentHashOf(projection)
  return hash === record.acknowledgedHash ? { kind: "clean" } : { kind: "dirty" }
}
