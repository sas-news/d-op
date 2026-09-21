import {
  opaqueIdSchema,
  SHARE_PART_ID_MAX,
  SHARE_REQUEST_BODY_MAX_BYTES,
  SHARE_SCHEMA_VERSION,
  SUPPORTED_ORIGINS,
} from "./limits"
import { InvalidPartIdError, OversizePayloadError } from "./share-errors"
import type {
  DerivedFrom,
  PublishMetadata,
  SharedPlaylist,
  ShareItem,
  UnpublishableReason,
} from "./share-model"
import { SharedPlaylistSchema, ShareItemSchema, UnpublishablePlaylistError } from "./share-model"
// `| undefined` on every optional field keeps LocalItem assignable under
// exactOptionalPropertyTypes — a local item with absent optional fields IS
// the publishable input; the projection drops undefineds itself.
export type PublishableLocalItem = {
  readonly id: string
  readonly partId: string
  readonly workId?: string | undefined
  readonly title: string
  readonly episodeTitle: string
  readonly episodeNumber?: string | undefined
  readonly url?: string | undefined
  readonly range: {
    readonly start: number
    readonly end: number
    readonly name?: string | undefined
  } | null
}
export type PublishableLocalPlaylist = {
  readonly id: string
  readonly name: string
  readonly items: readonly PublishableLocalItem[]
}
export type PublicProjection = {
  readonly playlist: SharedPlaylist
  readonly source: DerivedFrom | null
}
export function toPublishProjection(
  playlist: PublishableLocalPlaylist,
  meta: PublishMetadata,
): SharedPlaylist {
  const reasons: UnpublishableReason[] = playlist.items.flatMap((item, index) =>
    item.range === null
      ? [
          {
            itemIndex: index,
            itemId: item.id,
            path: `items.${index}.range`,
            code: "null-range" as const,
            message: `item ${index} plays the full episode locally; set an explicit range to publish it`,
          },
        ]
      : [],
  )
  if (playlist.items.length === 0)
    reasons.push({
      itemIndex: -1,
      itemId: "",
      path: "items",
      code: "empty-playlist",
      message: "empty playlists cannot be published; add at least one ranged item",
    })
  const items: ShareItem[] = []
  playlist.items.forEach((item, index) => {
    if (item.range === null) return
    const parsed = ShareItemSchema.safeParse({
      partId: item.partId,
      ...(item.workId === undefined ? {} : { workId: item.workId }),
      title: item.title,
      episodeTitle: item.episodeTitle,
      ...(item.episodeNumber === undefined ? {} : { episodeNumber: item.episodeNumber }),
      range: item.range,
    })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      reasons.push({
        itemIndex: index,
        itemId: item.id,
        path: `items.${index}.${issue?.path.map(String).join(".") ?? ""}`,
        code: "invalid-item",
        message: `item ${index} is not publishable: ${issue?.message ?? "invalid"}`,
      })
      return
    }
    items.push(parsed.data)
  })
  if (reasons.length > 0) throw new UnpublishablePlaylistError(reasons)
  return SharedPlaylistSchema.parse({
    schemaVersion: SHARE_SCHEMA_VERSION,
    title: meta.title ?? playlist.name,
    description: meta.description ?? "",
    author: meta.author ?? "",
    tags: meta.tags ?? [],
    visibility: meta.visibility,
    ...(meta.derivedFrom === undefined ? {} : { derivedFrom: meta.derivedFrom }),
    items,
  })
}
export function projectPublicPlaylist(input: {
  readonly playlist: SharedPlaylist
  readonly parentPublic: boolean
}): PublicProjection {
  if (input.parentPublic || input.playlist.derivedFrom === undefined)
    return { playlist: input.playlist, source: input.playlist.derivedFrom ?? null }
  const { derivedFrom: _hidden, ...redacted } = input.playlist
  return { playlist: SharedPlaylistSchema.parse(redacted), source: null }
}
export function buildPlaybackUrl(partId: string): string {
  if (!opaqueIdSchema(SHARE_PART_ID_MAX).safeParse(partId).success)
    throw new InvalidPartIdError(partId)
  return `${SUPPORTED_ORIGINS[0]}/animestore/sc_d_pc?partId=${encodeURIComponent(partId)}`
}
export function checkShareBodySize(byteLength: number): { readonly ok: true } {
  if (byteLength > SHARE_REQUEST_BODY_MAX_BYTES)
    throw new OversizePayloadError("share-body", byteLength, SHARE_REQUEST_BODY_MAX_BYTES, "bytes")
  return { ok: true }
}
