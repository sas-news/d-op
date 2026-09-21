import { describe, expect, it } from "vitest"
import { LOCAL_STATE_KEY } from "../../../../packages/shared/src/limits"
import type { LocalV2State } from "../../../../packages/shared/src/local-model"
import { commitImport } from "../../src/share/import-commit"
import { IMPORT_RECORDS_KEY, readImportRecords } from "../../src/share/provenance"
import { InMemoryStorageDriver, StorageWriteError } from "../../src/storage/driver"
import { createLocalRepository } from "../../src/storage/repository"
import { newUuid, resetUuidCounter, SHARE_ID, shareResponse } from "./fixtures"

function setup(initial?: LocalV2State) {
  resetUuidCounter()
  const driver = new InMemoryStorageDriver(
    initial === undefined ? {} : { [LOCAL_STATE_KEY]: initial },
  )
  const repository = createLocalRepository({
    driver,
    now: () => "2026-09-21T12:00:00.000Z",
    newId: newUuid,
  })
  return { driver, repository }
}

const baseOptions = (
  driver: InMemoryStorageDriver,
  repository: ReturnType<typeof createLocalRepository>,
) => ({
  repository,
  driver,
  response: shareResponse(),
  operationId: "11111111-2222-4333-8444-555555555501",
  newId: newUuid,
  now: () => "2026-09-21T12:00:00.000Z",
})

describe("commitImport", () => {
  it("creates an independent playlist with fresh local ids and provenance", async () => {
    const { driver, repository } = setup()
    const result = await commitImport(baseOptions(driver, repository))
    expect(result.kind).toBe("committed")

    const state = await repository.readPublic()
    expect(state.playlists).toHaveLength(1)
    const playlist = state.playlists[0]
    expect(playlist).toBeDefined()
    if (playlist === undefined) return
    expect(playlist.name).toBe("共有リスト")
    expect(playlist.items).toHaveLength(2)
    // Fresh opaque local ids — never share-side ids, never urls, no secrets.
    expect(playlist.id).not.toBe(SHARE_ID)
    for (const item of playlist.items) {
      expect(item.id).toMatch(/^[0-9a-f-]{36}$/)
      expect("url" in item).toBe(false)
      expect(item.partId).toMatch(/^part_/)
    }
    expect(playlist.items[0]?.episodeNumber).toBe("1")
    expect(playlist.items[1]?.episodeNumber).toBeUndefined()
    expect("workId" in (playlist.items[1] ?? {})).toBe(false)

    const raw = (await driver.get([LOCAL_STATE_KEY]))[LOCAL_STATE_KEY] as LocalV2State
    expect(raw.publications).toHaveLength(0) // no capability was granted
    expect(JSON.stringify(raw)).not.toContain("manageSecret")

    const records = await readImportRecords(driver)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      playlistId: playlist.id,
      shareId: SHARE_ID,
      revision: 2,
      itemCount: 2,
      title: "共有リスト",
    })
    expect(Object.keys(records[0] ?? {})).not.toContain("manageSecret")
    if (result.kind === "committed") expect(result.provenance).toBe("written")
  })

  it("fails closed on a divergent replay of the same operationId (no duplicate)", async () => {
    const { driver, repository } = setup()
    const options = baseOptions(driver, repository)
    const first = await commitImport(options)
    expect(first.kind).toBe("committed")
    // A second call mints different fresh ids, so the payload hash differs —
    // the repository's operation receipt correctly reports a conflict and
    // nothing new is written. Within one call, retries reuse the same
    // payload so a lost reply replays the original receipt instead.
    const second = await commitImport(options)
    expect(second).toMatchObject({ kind: "failed" })
    const state = await repository.readPublic()
    expect(state.playlists).toHaveLength(1)
  })

  it("returns provenance=failed when the sidecar write hits quota", async () => {
    const { driver, repository } = setup()
    const options = baseOptions(driver, repository)
    // Let the canonical write succeed, then fail only the provenance write.
    const realSet = driver.set.bind(driver)
    let calls = 0
    driver.set = async (values: Readonly<Record<string, unknown>>) => {
      calls += 1
      if (Object.keys(values).includes(IMPORT_RECORDS_KEY)) {
        throw new StorageWriteError("quota")
      }
      return realSet(values)
    }
    const result = await commitImport(options)
    expect(calls).toBeGreaterThan(0)
    expect(result).toMatchObject({ kind: "committed", provenance: "failed" })
    expect((await repository.readPublic()).playlists).toHaveLength(1)
  })

  it("maps rejections to failed without touching state", async () => {
    const { driver, repository } = setup()
    // A foreign repository that always rejects the command shape.
    const badRepository = {
      ...repository,
      dispatch: async () => ({ kind: "mutation-rejected" as const, reason: "x" }),
      readPublic: repository.readPublic,
      initialize: repository.initialize,
      readVault: repository.readVault,
    }
    const result = await commitImport({ ...baseOptions(driver, badRepository) })
    expect(result).toMatchObject({ kind: "failed" })
    expect((await repository.readPublic()).playlists).toHaveLength(0)
  })
})
