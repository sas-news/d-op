// Import provenance: a background-owned audit list under its own storage key
// (`dop_v2_imports`), deliberately OUTSIDE the canonical LocalV2State — the
// shared schema has no provenance field (reported gap). A record states that a
// local playlist was imported from a public snapshot. It NEVER stores
// manageSecret, vault material, or any capability — importing grants none.
import type { StorageDriver } from "../storage/driver"

export const IMPORT_RECORDS_KEY = "dop_v2_imports" as const
export const IMPORT_RECORDS_MAX = 128 as const

export type ImportRecord = {
  readonly playlistId: string
  readonly shareId: string
  readonly revision: number
  readonly contentHash: string
  readonly title: string
  readonly itemCount: number
  readonly importedAt: string
}

export class MalformedImportRecordsError extends Error {
  override readonly name = "MalformedImportRecordsError"
  constructor() {
    super(`stored ${IMPORT_RECORDS_KEY} is malformed`)
  }
}

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

function isImportRecord(input: unknown): input is ImportRecord {
  if (!isRecord(input) || Object.keys(input).length !== 7) return false
  // A provenance record must never carry a capability.
  if ("manageSecret" in input) return false
  return (
    typeof input["playlistId"] === "string" &&
    input["playlistId"].length > 0 &&
    typeof input["shareId"] === "string" &&
    input["shareId"].length === 22 &&
    typeof input["revision"] === "number" &&
    Number.isInteger(input["revision"]) &&
    input["revision"] >= 1 &&
    typeof input["contentHash"] === "string" &&
    /^[0-9a-f]{64}$/.test(input["contentHash"]) &&
    typeof input["title"] === "string" &&
    input["title"].length <= 200 &&
    typeof input["itemCount"] === "number" &&
    Number.isInteger(input["itemCount"]) &&
    input["itemCount"] >= 0 &&
    typeof input["importedAt"] === "string" &&
    !Number.isNaN(Date.parse(input["importedAt"]))
  )
}

type ImportRecordsFile = { readonly schemaVersion: 1; readonly records: readonly ImportRecord[] }

function parseFile(raw: unknown): ImportRecordsFile {
  if (raw === undefined) return { schemaVersion: 1, records: [] }
  if (
    !isRecord(raw) ||
    raw["schemaVersion"] !== 1 ||
    !Array.isArray(raw["records"]) ||
    !raw["records"].every(isImportRecord)
  ) {
    throw new MalformedImportRecordsError()
  }
  return { schemaVersion: 1, records: raw["records"] }
}

export async function readImportRecords(driver: StorageDriver): Promise<readonly ImportRecord[]> {
  const stored = await driver.get([IMPORT_RECORDS_KEY])
  return parseFile(stored[IMPORT_RECORDS_KEY]).records
}

/**
 * Append one record, pruning entries whose playlistId is absent from
 * `livePlaylistIds` (deleted local copies drop their provenance) and capping
 * the list. Non-atomic with the playlist commit by design: a missing record
 * is advisory data only, never a gate on playback or management.
 */
export async function appendImportRecord(
  driver: StorageDriver,
  record: ImportRecord,
  livePlaylistIds: readonly string[],
): Promise<void> {
  const file = parseFile((await driver.get([IMPORT_RECORDS_KEY]))[IMPORT_RECORDS_KEY])
  const live = new Set([...livePlaylistIds, record.playlistId])
  const records = [...file.records.filter((entry) => live.has(entry.playlistId)), record].slice(
    -IMPORT_RECORDS_MAX,
  )
  await driver.set({
    [IMPORT_RECORDS_KEY]: { schemaVersion: 1, records } satisfies ImportRecordsFile,
  })
}
