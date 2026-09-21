import { describe, expect, it } from "vitest"
import {
  appendImportRecord,
  IMPORT_RECORDS_KEY,
  type ImportRecord,
  MalformedImportRecordsError,
  readImportRecords,
} from "../../src/share/provenance"
import { InMemoryStorageDriver } from "../../src/storage/driver"
import { HASH, SHARE_ID } from "./fixtures"

const record = (playlistId: string, shareId = SHARE_ID): ImportRecord => ({
  playlistId,
  shareId,
  revision: 1,
  contentHash: HASH,
  title: "タイトル",
  itemCount: 3,
  importedAt: "2026-09-21T12:00:00.000Z",
})

describe("import provenance store", () => {
  it("reads an empty store as no records", async () => {
    const driver = new InMemoryStorageDriver()
    expect(await readImportRecords(driver)).toEqual([])
  })

  it("round-trips records and never carries capabilities", async () => {
    const driver = new InMemoryStorageDriver()
    await appendImportRecord(driver, record("pl-1"), ["pl-1"])
    await appendImportRecord(driver, record("pl-2"), ["pl-1", "pl-2"])
    const records = await readImportRecords(driver)
    expect(records.map((entry) => entry.playlistId)).toEqual(["pl-1", "pl-2"])
    const raw = (await driver.get([IMPORT_RECORDS_KEY]))[IMPORT_RECORDS_KEY]
    expect(JSON.stringify(raw)).not.toContain("manageSecret")
  })

  it("prunes records whose playlist no longer exists", async () => {
    const driver = new InMemoryStorageDriver()
    await appendImportRecord(driver, record("pl-1"), ["pl-1"])
    await appendImportRecord(driver, record("pl-2"), ["pl-1", "pl-2"])
    // pl-1 was deleted locally — its provenance entry drops on next append.
    await appendImportRecord(driver, record("pl-3"), ["pl-2", "pl-3"])
    expect((await readImportRecords(driver)).map((entry) => entry.playlistId)).toEqual([
      "pl-2",
      "pl-3",
    ])
  })

  it("throws on malformed stored data instead of trusting it", async () => {
    const driver = new InMemoryStorageDriver({
      [IMPORT_RECORDS_KEY]: { schemaVersion: 1, records: [{ playlistId: "x", manageSecret: "y" }] },
    })
    await expect(readImportRecords(driver)).rejects.toBeInstanceOf(MalformedImportRecordsError)
  })
})
