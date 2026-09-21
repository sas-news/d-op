import { describe, expect, it } from "vitest"
import { InMemoryStorageDriver } from "../../src/storage/driver"
import { handleStorageMessage } from "../../src/storage/messages"
import { createLocalRepository } from "../../src/storage/repository"
import { NOW } from "./fixtures"

describe("storage message vault confinement", () => {
  it("returns vault data to extension UI but never content senders", async () => {
    // Given: a repository with capability-bearing publication data.
    const extensionId = "abcdefghijklmnopabcdefghijklmnop"
    const driver = new InMemoryStorageDriver()
    const repository = createLocalRepository({ driver, now: () => NOW, newId: () => "unused" })
    await repository.initialize()
    await repository.dispatch({
      kind: "put-publication",
      operationId: "00000000-0000-4000-8000-000000000401",
      expectedRevision: 0,
      publication: {
        shareId: "abcdefghijklmnopqrstuv",
        localPlaylistId: null,
        manageSecret: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
        revision: 1,
        contentHash: "a".repeat(64),
        sentSnapshot: "{}",
        acknowledgedHash: "b".repeat(64),
        visibility: "unlisted",
        createdAt: NOW,
        updatedAt: NOW,
        state: "active",
      },
    })
    const options = { repository, driver, extensionId }

    // When: extension UI and d-Anime content request the same vault surface.
    const uiResult = await handleStorageMessage(
      { type: "DOP_STORAGE_READ_VAULT" },
      { id: extensionId, url: `chrome-extension://${extensionId}/options.html` },
      options,
    )
    const contentResult = await handleStorageMessage(
      { type: "DOP_STORAGE_READ_VAULT" },
      { id: extensionId, url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc" },
      options,
    )

    // Then: only the browser-authenticated extension page receives the record.
    expect(uiResult).toMatchObject({ publications: [{ shareId: "abcdefghijklmnopqrstuv" }] })
    expect(contentResult).toEqual({
      kind: "forbidden",
      reason: "content-sender-cannot-access-vault",
    })
  })
})
