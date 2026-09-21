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

// Task 22: explicit, persisted Share consent. `shareConsent` is ABSENT until
// the user makes a choice on a privileged extension surface — undecided is
// not a grant. "declined" is equally persistent and equally revocable; it
// only gates Share network traffic, never local playlists or playback.
export const ShareConsentChoiceSchema = z.enum(["granted", "declined"])
export type ShareConsentChoice = z.infer<typeof ShareConsentChoiceSchema>
export const ShareConsentSchema = z.strictObject({
  choice: ShareConsentChoiceSchema,
  decidedAt: IsoDateTimeSchema,
})
export type ShareConsent = z.infer<typeof ShareConsentSchema>
export const OperationReceiptSchema = z.strictObject({
  operationId: z.uuid(),
  expectedRevision: z.number().int().min(0),
  resultingRevision: z.number().int().min(0),
  kind: z.string().min(1).max(64),
  requestHash: ContentHashSchema,
  result: z.strictObject({
    kind: z.literal("committed"),
    operationId: z.uuid(),
    revision: z.number().int().min(1),
  }),
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
  shareConsent: ShareConsentSchema.optional(),
})
export type LocalV2State = z.infer<typeof LocalV2StateSchema>

export const TransientPlaybackSchema = z.strictObject({
  playlistId: LocalIdSchema,
  index: z.number().int().min(0),
  shuffledIndices: z.array(z.number().int().min(0)).optional(),
  updatedAt: z.number().int().min(0),
  ownerToken: z.uuid(),
  ownerGeneration: z.number().int().min(1),
})
export type TransientPlayback = z.infer<typeof TransientPlaybackSchema>
export const TransientOpEdModeSchema = z.strictObject({
  active: z.literal(true),
  updatedAt: z.number().int().min(0),
})
export type TransientOpEdMode = z.infer<typeof TransientOpEdModeSchema>
export const TransientPlayerWindowSchema = z.strictObject({
  windowId: z.number().int(),
  ownerToken: z.uuid(),
  ownerGeneration: z.number().int().min(1),
  left: z.number().int().optional(),
  top: z.number().int().optional(),
  width: z.number().int().min(1).optional(),
  height: z.number().int().min(1).optional(),
})
export type TransientPlayerWindow = z.infer<typeof TransientPlayerWindowSchema>
export const TransientStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generation: z.number().int().min(0),
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
  z.strictObject({
    ...LocalCommandBase,
    kind: z.literal("set-preferences"),
    preferences: LocalPreferencesSchema,
  }),
  z.strictObject({
    ...LocalCommandBase,
    kind: z.literal("put-publication"),
    publication: PublicationRecordSchema,
  }),
  z.strictObject({
    ...LocalCommandBase,
    kind: z.literal("discard-publication-management"),
    shareId: ShareIdSchema,
  }),
  z.strictObject({
    ...LocalCommandBase,
    kind: z.literal("put-pending-create"),
    pendingCreate: PendingCreateSchema,
  }),
  z.strictObject({
    ...LocalCommandBase,
    kind: z.literal("remove-pending-create"),
    pendingOperationId: z.uuid(),
  }),
  // Task 22: records the user's explicit Share consent decision. Vault-level
  // access — only extension pages may write it (see requiredAccess).
  z.strictObject({
    ...LocalCommandBase,
    kind: z.literal("set-share-consent"),
    choice: ShareConsentChoiceSchema,
    decidedAt: IsoDateTimeSchema,
  }),
])
export type LocalCommand = z.infer<typeof LocalCommandSchema>

export const StorageRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("DOP_STORAGE_READ_PUBLIC") }),
  z.strictObject({ type: z.literal("DOP_STORAGE_READ_VAULT") }),
  z.strictObject({ type: z.literal("DOP_STORAGE_COMMAND"), command: LocalCommandSchema }),
  z.strictObject({ type: z.literal("DOP_STORAGE_READ_TRANSIENT") }),
  z.strictObject({ type: z.literal("DOP_STORAGE_WRITE_TRANSIENT"), state: TransientStateSchema }),
])
export type StorageRequest = z.infer<typeof StorageRequestSchema>

export const SafeExportEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(LOCAL_SCHEMA_VERSION),
  playlists: z.array(LocalPlaylistSchema),
})
export type SafeExportEnvelope = z.infer<typeof SafeExportEnvelopeSchema>
