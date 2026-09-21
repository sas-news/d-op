import { describe, expect, it } from "vitest"
import { authorizeStorageRequest } from "../../src/storage/authorization"

describe("storage sender authorization", () => {
  it("allows extension UI and background-owned access", () => {
    // Given: trusted extension URLs and the background's direct invocation.
    const extensionId = "abcdefghijklmnopabcdefghijklmnop"

    // When: public and vault requests are authorized.
    const popup = authorizeStorageRequest(
      { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` },
      "public",
      extensionId,
    )
    const optionsVault = authorizeStorageRequest(
      { id: extensionId, url: `chrome-extension://${extensionId}/options.html` },
      "vault",
      extensionId,
    )
    const background = authorizeStorageRequest(undefined, "vault", extensionId)

    // Then: all are classified from trusted sender metadata.
    expect([popup, optionsVault, background]).toEqual([
      { kind: "allowed", surface: "extension-ui" },
      { kind: "allowed", surface: "extension-ui" },
      { kind: "allowed", surface: "background" },
    ])
  })

  it("denies publication vault reads from d-Anime and Share content senders", () => {
    // Given: content-script sender metadata, regardless of caller-supplied claims.
    const extensionId = "abcdefghijklmnopabcdefghijklmnop"
    const senders = [
      { id: extensionId, url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=1" },
      { id: extensionId, url: "https://d-op.sasnews.dev/share/abc" },
    ] as const

    // When: each asks for the vault while claiming to be options UI.
    const results = senders.map((sender) => {
      const claimedSender = { ...sender, claimedSurface: "options" }
      return authorizeStorageRequest(claimedSender, "vault", extensionId)
    })

    // Then: trusted browser sender URLs win and both requests are denied.
    expect(results).toEqual([
      { kind: "denied", reason: "content-sender-cannot-access-vault" },
      { kind: "denied", reason: "content-sender-cannot-access-vault" },
    ])
  })
})
