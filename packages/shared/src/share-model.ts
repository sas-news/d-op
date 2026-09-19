import { z } from "zod"
import {
  collapseWhitespace,
  MsIntSchema,
  normalizedStringSchema,
  opaqueIdSchema,
  SHARE_AUTHOR_MAX,
  SHARE_DESCRIPTION_MAX,
  SHARE_EPISODE_NUMBER_MAX,
  SHARE_ITEM_TITLE_MAX,
  SHARE_ITEMS_MAX,
  SHARE_ITEMS_MIN,
  SHARE_PART_ID_MAX,
  SHARE_RANGE_MAX_END_MS,
  SHARE_RANGE_NAME_MAX,
  SHARE_SCHEMA_VERSION,
  SHARE_TAG_MAX,
  SHARE_TAG_MIN,
  SHARE_TAGS_MAX,
  SHARE_TITLE_MAX,
  SHARE_TITLE_MIN,
  sortCanonicalTags,
} from "./limits"
import { DerivedFromSchema as _DerivedFromSchema } from "./share-model-internal"

export type { DerivedFrom } from "./share-model-internal"
export const DerivedFromSchema = _DerivedFromSchema
declare const contentHashBrand: unique symbol
export type ContentHash = string & { readonly [contentHashBrand]: "ContentHash" }
const ShareRangeNameSchema = normalizedStringSchema({ min: 1, max: SHARE_RANGE_NAME_MAX })
export const ShareRangeSchema = z
  .strictObject({ start: MsIntSchema, end: MsIntSchema, name: ShareRangeNameSchema.optional() })
  .refine((range) => range.start < range.end, {
    message: "range start must be before range end",
    path: ["start"],
  })
  .refine((range) => range.end <= SHARE_RANGE_MAX_END_MS, {
    message: "range end exceeds the 24-hour share cap",
    path: ["end"],
  })
export type ShareRange = z.infer<typeof ShareRangeSchema>
const ShareTagSchema = z
  .string()
  .transform((value) => collapseWhitespace(value.normalize("NFC").trim()))
  .pipe(z.string().min(SHARE_TAG_MIN).max(SHARE_TAG_MAX))
const ShareDescriptionSchema = z
  .string()
  .max(SHARE_DESCRIPTION_MAX)
  .transform((value) => value.normalize("NFC"))
  .pipe(z.string().max(SHARE_DESCRIPTION_MAX))
const ShareItemTitleSchema = normalizedStringSchema({ min: 1, max: SHARE_ITEM_TITLE_MAX })
export const ShareItemSchema = z.strictObject({
  partId: opaqueIdSchema(SHARE_PART_ID_MAX),
  workId: opaqueIdSchema(SHARE_PART_ID_MAX).optional(),
  title: ShareItemTitleSchema,
  episodeTitle: ShareItemTitleSchema,
  episodeNumber: normalizedStringSchema({ min: 1, max: SHARE_EPISODE_NUMBER_MAX }).optional(),
  range: ShareRangeSchema,
})
export type ShareItem = z.infer<typeof ShareItemSchema>
export const SharedPlaylistSchema = z.strictObject({
  schemaVersion: z.literal(SHARE_SCHEMA_VERSION),
  title: normalizedStringSchema({ min: SHARE_TITLE_MIN, max: SHARE_TITLE_MAX }),
  description: ShareDescriptionSchema,
  author: normalizedStringSchema({ min: 0, max: SHARE_AUTHOR_MAX }),
  tags: z
    .array(ShareTagSchema)
    .transform(sortCanonicalTags)
    .pipe(z.array(z.string().min(SHARE_TAG_MIN).max(SHARE_TAG_MAX)).max(SHARE_TAGS_MAX)),
  visibility: z.enum(["public", "unlisted"]),
  derivedFrom: DerivedFromSchema.optional(),
  items: z.array(ShareItemSchema).min(SHARE_ITEMS_MIN).max(SHARE_ITEMS_MAX),
})
export type SharedPlaylist = z.infer<typeof SharedPlaylistSchema>
export const PublishMetadataSchema = z.strictObject({
  title: normalizedStringSchema({ min: SHARE_TITLE_MIN, max: SHARE_TITLE_MAX }).optional(),
  description: ShareDescriptionSchema.optional(),
  author: normalizedStringSchema({ min: 0, max: SHARE_AUTHOR_MAX }).optional(),
  tags: z
    .array(ShareTagSchema)
    .transform(sortCanonicalTags)
    .pipe(z.array(z.string().min(SHARE_TAG_MIN).max(SHARE_TAG_MAX)))
    .optional(),
  visibility: z.enum(["public", "unlisted"]),
  derivedFrom: DerivedFromSchema.optional(),
})
export type PublishMetadata = z.infer<typeof PublishMetadataSchema>
export type UnpublishableReasonCode = "null-range" | "empty-playlist" | "invalid-item"
export type UnpublishableReason = {
  readonly itemIndex: number
  readonly itemId: string
  readonly path: string
  readonly code: UnpublishableReasonCode
  readonly message: string
}
export class UnpublishablePlaylistError extends Error {
  override readonly name = "UnpublishablePlaylistError"
  constructor(readonly reasons: readonly UnpublishableReason[]) {
    super(`playlist cannot be published: ${reasons.map((reason) => reason.message).join("; ")}`)
  }
}
