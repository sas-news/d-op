// Fixed API v1 contract: envelopes, route payloads and errors (task 3).
// All routes are same-origin `/api/v1/playlists`. Success is `{data}`;
// failures are `{error:{code,message,requestId,details?}}` where details
// carries validated field paths or conflict revision — never raw bodies,
// secrets or SQL. No handlers, no SQL, no network behavior live here.
import { z } from "zod"
import {
  COLLECTION_LIMIT_DEFAULT,
  COLLECTION_LIMIT_MAX,
  COLLECTION_LIMIT_MIN,
  COLLECTION_QUERY_MAX,
  ContentHashSchema,
  IsoDateTimeSchema,
  ManageSecretSchema,
  SERVER_REVISION_START,
  SHARE_TAG_MAX,
  SHARE_TAG_MIN,
  ShareIdSchema,
} from "./limits"
import { DerivedFromSchema, SharedPlaylistSchema } from "./share"

export const API_BASE_PATH = "/api/v1/playlists" as const
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key" as const

export const API_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "SCHEMA_INVALID",
  "UNPUBLISHABLE",
  "REVISION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "CREATE_RECEIPT_UNAVAILABLE",
  "BODY_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "RATE_LIMITED",
  "TRANSIENT_FAILURE",
  "METHOD_NOT_ALLOWED",
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

export const RevisionSchema = z.number().int().min(SERVER_REVISION_START)
export type Revision = z.infer<typeof RevisionSchema>

/** Success envelope `{data}`; strict so unknown keys fail closed. */
export function apiSuccessSchema<T extends z.ZodType>(dataSchema: T) {
  return z.strictObject({ data: dataSchema })
}

const ApiErrorDetailsSchema = z.union([
  z.array(z.string().min(1)),
  z.strictObject({ revision: RevisionSchema }),
])
export type ApiErrorDetails = z.infer<typeof ApiErrorDetailsSchema>

export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(API_ERROR_CODES),
    message: z.string().min(1).max(500),
    requestId: z.string().min(1).max(128),
    details: ApiErrorDetailsSchema.optional(),
  }),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

// --- POST /api/v1/playlists -----------------------------------------------------

export const CreateAckSchema = z.strictObject({
  shareId: ShareIdSchema,
  manageSecret: ManageSecretSchema,
  revision: z.literal(SERVER_REVISION_START),
  contentHash: ContentHashSchema,
  createdAt: IsoDateTimeSchema,
  activationExpiresAt: IsoDateTimeSchema,
  state: z.literal("pending"),
})
export type CreateAck = z.infer<typeof CreateAckSchema>

export const IdempotencyKeySchema = z.uuid()
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>

// --- GET /:shareId ------------------------------------------------------------------

export const PublicSourceSchema = DerivedFromSchema.nullable()
export type PublicSource = z.infer<typeof PublicSourceSchema>

export const GetPlaylistResponseSchema = z.strictObject({
  shareId: ShareIdSchema,
  revision: RevisionSchema,
  publishedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  contentHash: ContentHashSchema,
  playlist: SharedPlaylistSchema,
  itemCount: z.number().int().min(1).max(200),
  totalDurationMs: z.number().int().min(1),
  importCount: z.number().int().min(0),
  source: PublicSourceSchema,
})
export type GetPlaylistResponse = z.infer<typeof GetPlaylistResponseSchema>

// --- PATCH /:shareId -------------------------------------------------------------------

export const ActivateOperationSchema = z.strictObject({
  operation: z.literal("activate"),
  expectedRevision: z.literal(1),
})
export type ActivateOperation = z.infer<typeof ActivateOperationSchema>

export const ReplaceOperationSchema = z.strictObject({
  operation: z.literal("replace"),
  expectedRevision: RevisionSchema,
  playlist: SharedPlaylistSchema,
})
export type ReplaceOperation = z.infer<typeof ReplaceOperationSchema>

export const PatchPlaylistBodySchema = z.discriminatedUnion("operation", [
  ActivateOperationSchema,
  ReplaceOperationSchema,
])
export type PatchPlaylistBody = z.infer<typeof PatchPlaylistBodySchema>

export const PatchAckSchema = z.strictObject({
  shareId: ShareIdSchema,
  revision: RevisionSchema,
  contentHash: ContentHashSchema,
  publishedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type PatchAck = z.infer<typeof PatchAckSchema>

// --- DELETE /:shareId --------------------------------------------------------------------

export const DeletePlaylistBodySchema = z.strictObject({
  expectedRevision: RevisionSchema,
})
export type DeletePlaylistBody = z.infer<typeof DeletePlaylistBodySchema>

// --- POST /:shareId/import -----------------------------------------------------------------

export const ImportNotifyBodySchema = z.strictObject({
  eventId: z.uuid(),
})
export type ImportNotifyBody = z.infer<typeof ImportNotifyBodySchema>

// --- GET collection ------------------------------------------------------------------------------

export const LIST_SORTS = ["new", "popular"] as const
export const RANK_MODES = ["popular", "new"] as const
export const RANK_WINDOWS = ["30d", "90d", "lifetime", "none"] as const

export const ListQuerySchema = z.strictObject({
  sort: z.enum(LIST_SORTS).default("new"),
  q: z.string().min(1).max(COLLECTION_QUERY_MAX).optional(),
  tag: z.string().min(SHARE_TAG_MIN).max(SHARE_TAG_MAX).optional(),
  limit: z.preprocess(
    (value) => (typeof value === "string" ? Number(value) : value),
    z
      .number()
      .int()
      .min(COLLECTION_LIMIT_MIN)
      .max(COLLECTION_LIMIT_MAX)
      .default(COLLECTION_LIMIT_DEFAULT),
  ),
  cursor: z.string().min(1).max(512).optional(),
})
export type ListQuery = z.infer<typeof ListQuerySchema>

export const RankingSchema = z.strictObject({
  mode: z.enum(RANK_MODES),
  effectiveWindow: z.enum(RANK_WINDOWS),
  asOf: IsoDateTimeSchema,
  fallbackReason: z.enum(["insufficient-recent-data", "no-imports"]).optional(),
})
export type Ranking = z.infer<typeof RankingSchema>

export const ListResponseSchema = z.strictObject({
  items: z.array(GetPlaylistResponseSchema),
  nextCursor: z.string().min(1).max(512).optional(),
  truncated: z.boolean().optional(),
  ranking: RankingSchema,
})
export type ListResponse = z.infer<typeof ListResponseSchema>
