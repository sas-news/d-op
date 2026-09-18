import { z } from "zod"
import {
  ContentHashSchema,
  IsoDateTimeSchema,
  LOCAL_SCHEMA_VERSION,
  ManageSecretSchema,
  MsIntSchema,
  opaqueIdSchema,
  ShareIdSchema,
} from "./limits"

const LocalIdSchema = opaqueIdSchema(256)
const LocalRangeNameSchema = z.string().min(1).max(80)

export const LocalRangeSchema = z
  .strictObject({ start: MsIntSchema, end: MsIntSchema, name: LocalRangeNameSchema.optional() })
  .refine((range) => range.start < range.end, {
    message: "range start must be before range end",
    path: ["start"],
  })
export type LocalRange = z.infer<typeof LocalRangeSchema>

export const LocalItemSchema = z.strictObject({
  id: LocalIdSchema,
  partId: z.string().min(1).max(512),
  workId: z.string().min(1).max(512).optional(),
  title: z.string().max(1000),
  episodeTitle: z.string().max(1000),
  episodeNumber: z.string().max(128).optional(),
  url: z.string().max(2048).optional(),
  range: LocalRangeSchema.nullable(),
})
export type LocalItem = z.infer<typeof LocalItemSchema>

export const LocalPlaylistSchema = z.strictObject({
  id: LocalIdSchema,
  name: z.string().min(1).max(200),
  items: z.array(LocalItemSchema),
})
export type LocalPlaylist = z.infer<typeof LocalPlaylistSchema>

export const PublicationStateSchema = z.enum(["pending", "active", "local-deleted"])
export type PublicationState = z.infer<typeof PublicationStateSchema>
export const PublicationRecordSchema = z.strictObject({
  shareId: ShareIdSchema,
  localPlaylistId: LocalIdSchema.nullable(),
  manageSecret: ManageSecretSchema,
  revision: z.number().int().min(1),
  contentHash: ContentHashSchema,
  sentSnapshot: z.string().min(1),
  acknowledgedHash: ContentHashSchema,
  visibility: z.enum(["public", "unlisted"]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  state: PublicationStateSchema,
})
export type PublicationRecord = z.infer<typeof PublicationRecordSchema>
export const PendingCreateSchema = z.strictObject({
  operationId: z.uuid(),
  idempotencyKey: z.uuid(),
  payloadHash: ContentHashSchema,
  createdAt: IsoDateTimeSchema,
})
export type PendingCreate = z.infer<typeof PendingCreateSchema>
export const LocalPreferencesSchema = z.strictObject({
  windowMode: z.enum(["window", "tab"]),
  collapsedPlaylists: z.record(z.string(), z.boolean()),
})
export type LocalPreferences = z.infer<typeof LocalPreferencesSchema>
export const OperationReceiptSchema = z.strictObject({
  operationId: z.uuid(),
  expectedRevision: z.number().int().min(0),
  resultingRevision: z.number().int().min(0),
  kind: z.string().min(1).max(64),
  createdAt: IsoDateTimeSchema,
})
export type OperationReceipt = z.infer<typeof OperationReceiptSchema>
export const QuarantineEntrySchema = z.strictObject({
  playlistIndex: z.number().int().min(0),
  itemIndex: z.number().int().min(0).optional(),
  originalJson: z.string().min(1).max(65536),
  issues: z.array(z.string().min(1)),
  reason: z.string().min(1).max(500),
})
export type QuarantineEntry = z.infer<typeof QuarantineEntrySchema>
export const MigrationRecoverySchema = z.strictObject({
  quarantined: z.array(QuarantineEntrySchema),
  migratedAt: IsoDateTimeSchema,
  migrationVersion: z.number().int().min(1),
  sourceKeys: z.array(z.string().min(1)),
})
export type MigrationRecovery = z.infer<typeof MigrationRecoverySchema>
export const LocalV2StateSchema = z.strictObject({
  schemaVersion: z.literal(LOCAL_SCHEMA_VERSION),
  revision: z.number().int().min(0),
  playlists: z.array(LocalPlaylistSchema),
  publications: z.array(PublicationRecordSchema),
  pendingCreates: z.array(PendingCreateSchema),
  preferences: LocalPreferencesSchema,
  appliedOperations: z.array(OperationReceiptSchema).max(256),
  migrationRecovery: MigrationRecoverySchema.optional(),
})
export type LocalV2State = z.infer<typeof LocalV2StateSchema>

export const TransientPlaybackSchema = z.strictObject({
  playlistId: LocalIdSchema,
  index: z.number().int().min(0),
  shuffledIndices: z.array(z.number().int().min(0)).optional(),
  updatedAt: z.number().int().min(0),
  windowId: z.number().int().optional(),
})
export type TransientPlayback = z.infer<typeof TransientPlaybackSchema>
export const TransientOpEdModeSchema = z.strictObject({
  active: z.literal(true),
  updatedAt: z.number().int().min(0),
})
export type TransientOpEdMode = z.infer<typeof TransientOpEdModeSchema>
export const TransientPlayerWindowSchema = z.strictObject({
  windowId: z.number().int(),
  left: z.number().int().optional(),
  top: z.number().int().optional(),
  width: z.number().int().min(1).optional(),
  height: z.number().int().min(1).optional(),
})
export type TransientPlayerWindow = z.infer<typeof TransientPlayerWindowSchema>
export const TransientStateSchema = z.strictObject({
  playback: TransientPlaybackSchema.optional(),
  opedMode: TransientOpEdModeSchema.optional(),
  playerWindow: TransientPlayerWindowSchema.optional(),
})
export type TransientState = z.infer<typeof TransientStateSchema>

const LocalCommandBase = {
  operationId: z.uuid(),
  expectedRevision: z.number().int().min(0),
} as const
export const LocalCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...LocalCommandBase,
    kind: z.literal("create-playlist"),
    name: z.string().min(1).max(200),
  }),
  z.strictObject({
    ...LocalCommandBase,
    kind: z.literal("rename-playlist"),
    playlistId: LocalIdSchema,
    name: z.string().min(1).max(200),
  }),
  z.strictObject({
    ...LocalCommandBase,
    kind: z.literal("delete-playlist"),
    playlistId: LocalIdSchema,
  }),
  z.strictObject({
    ...LocalCommandBase,
    kind: z.literal("add-item"),
    playlistId: LocalIdSchema,
    item: LocalItemSchema,
  }),
  z.strictObject({
    ...LocalCommandBase,
    kind: z.literal("remove-item"),
    playlistId: LocalIdSchema,
    itemId: LocalIdSchema,
  }),
  z.strictObject({
    ...LocalCommandBase,
    kind: z.literal("replace-library"),
    playlists: z.array(LocalPlaylistSchema),
  }),
])
export type LocalCommand = z.infer<typeof LocalCommandSchema>

export const SafeExportEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(LOCAL_SCHEMA_VERSION),
  playlists: z.array(LocalPlaylistSchema),
})
export type SafeExportEnvelope = z.infer<typeof SafeExportEnvelopeSchema>
