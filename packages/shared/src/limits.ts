// Shared limits, runtime-neutral primitives and zod helpers (task 3).
// This module owns every numeric/string budget in the plan so tasks 6/7 and
// 11-15 share one source of truth. No Node/Bun/DOM/Worker imports: only zod
// (boundary parsing) and language built-ins available in all three runtimes.
import { z } from "zod"

// --- Schema versions -------------------------------------------------------

export const LOCAL_SCHEMA_VERSION = 2 as const
export const SHARE_SCHEMA_VERSION = 1 as const
export const LEGACY_MIGRATION_VERSION = 1 as const

// --- Local storage ---------------------------------------------------------

export const LOCAL_STATE_KEY = "dop_v2_state" as const
export const LEGACY_STORAGE_KEYS = [
  "dop_playlists",
  "dop_playback",
  "dop_pending",
  "dop_oped_mode",
  "dop_window_mode",
  "dop_collapsed_playlists",
  "dop_player_window",
] as const
export const MAX_OPERATION_RECEIPTS = 256 as const

// --- Share field budgets ---------------------------------------------------

export const SHARE_TITLE_MIN = 1 as const
export const SHARE_TITLE_MAX = 120 as const
export const SHARE_DESCRIPTION_MAX = 2000 as const
export const SHARE_AUTHOR_MAX = 80 as const
export const SHARE_TAGS_MAX = 10 as const
export const SHARE_TAG_MIN = 1 as const
export const SHARE_TAG_MAX = 24 as const
export const SHARE_ITEMS_MIN = 1 as const
export const SHARE_ITEMS_MAX = 200 as const
export const SHARE_RANGE_MAX_END_MS = 86400000 as const
export const SHARE_PART_ID_MIN = 1 as const
export const SHARE_PART_ID_MAX = 128 as const
export const SHARE_ITEM_TITLE_MAX = 300 as const
export const SHARE_EPISODE_NUMBER_MAX = 64 as const
export const SHARE_RANGE_NAME_MAX = 80 as const

// --- Transport budgets -----------------------------------------------------

export const SHARE_REQUEST_BODY_MAX_BYTES = 262144 as const
export const LOCAL_IMPORT_FILE_MAX_BYTES = 10485760 as const
export const LOCAL_IMPORT_MAX_ITEMS = 10000 as const

// --- API identifiers -------------------------------------------------------

export const SHARE_ID_LENGTH = 22 as const
export const MANAGE_SECRET_LENGTH = 43 as const
export const CONTENT_HASH_LENGTH = 64 as const
export const SERVER_REVISION_START = 1 as const
export const ACTIVATION_EXPIRES_AFTER_MS = 3600000 as const
export const COLLECTION_LIMIT_MIN = 1 as const
export const COLLECTION_LIMIT_MAX = 50 as const
export const COLLECTION_LIMIT_DEFAULT = 20 as const
export const COLLECTION_QUERY_MAX = 100 as const

// --- Retention windows -----------------------------------------------------

export const MUTATION_RECEIPT_TTL_MS = 86400000 as const
export const IMPORT_RECEIPT_TTL_MS = 172800000 as const
export const DAY_BUCKET_RETENTION_DAYS = 90 as const
export const DISCOVERY_SNAPSHOT_TTL_MS = 900000 as const
export const DISCOVERY_SNAPSHOT_MAX_IDS = 1000 as const
export const FIRST_PAGE_SNAPSHOT_REUSE_MS = 60000 as const
export const MIN_POSITIVE_PLAYLISTS = 5 as const
export const RANK_WINDOWS_DAYS = [30, 90] as const

// --- Origins and identifiers -----------------------------------------------

export const SUPPORTED_ORIGINS = [
  "https://animestore.docomo.ne.jp",
  "https://anime.dmkt-sp.jp",
] as const
export const PLAYBACK_URL_PATH = "/animestore/sc_d_pc" as const
export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]+$/
export const RATE_LIMITS = {
  createsPerMinute: 5,
  authedMutationsPerShare: 30,
  importNotifyPerActor: 30,
  readsPerActor: 120,
} as const

// --- Shared zod primitives -------------------------------------------------

/** Integer milliseconds: finite, safe, non-negative. Rejects NaN/Infinity. */
export const MsIntSchema = z.number().refine((value) => Number.isSafeInteger(value) && value >= 0, {
  message: "expected a non-negative safe integer in milliseconds",
})

/** Opaque part/work id: letters, digits, `_`, `-`; never a URL. */
export function opaqueIdSchema(fieldMax: number): z.ZodString {
  return z
    .string()
    .min(SHARE_PART_ID_MIN)
    .max(fieldMax)
    .regex(OPAQUE_ID_PATTERN, { message: "expected an opaque id of letters, digits, _ or -" })
}

/** NFC-normalized string with trim + length checked after normalization. */
export function normalizedStringSchema(options: { readonly min: number; readonly max: number }) {
  const pre = z.string().trim().min(options.min).max(options.max)
  return pre
    .transform((value) => value.normalize("NFC"))
    .pipe(z.string().min(options.min).max(options.max))
}

/** Collapse ASCII/Unicode whitespace runs to a single space. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ")
}

/** Canonical tag order: NFC, trimmed, collapsed, case-insensitive unique, sorted. */
export function sortCanonicalTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const tag of tags) {
    const folded = collapseWhitespace(tag.normalize("NFC").trim()).toLocaleLowerCase("en")
    if (folded.length === 0 || seen.has(folded)) {
      continue
    }
    seen.add(folded)
    unique.push(folded)
  }
  return unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Field-path list (`items.0.range.end`) from a Zod parse failure. */
export function issuePaths(error: z.ZodError): string[] {
  return error.issues.map((issue) => issue.path.map((segment) => String(segment)).join("."))
}

// --- Shared identifier schemas (single definition for local/api) -------------

export const ShareIdSchema = z.string().length(22).regex(OPAQUE_ID_PATTERN)
export type ShareId = z.infer<typeof ShareIdSchema>

export const ManageSecretSchema = z.string().length(43).regex(OPAQUE_ID_PATTERN)
export type ManageSecret = z.infer<typeof ManageSecretSchema>

export const ContentHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
export type ContentHashHex = z.infer<typeof ContentHashSchema>

export const IsoDateTimeSchema = z.iso.datetime()
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>

/** Exhaustive-switch guard for discriminated unions. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`)
}
