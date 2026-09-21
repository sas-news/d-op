// @vitest-environment jsdom
// Task-11 export acceptance: the portable JSON document is built ONLY through
// the shared SafeExport whitelist (buildSafeExport) — playlist/item/range data,
// local ids and episodeNumber, and nothing else. Publication records, pending
// creates, playback/window state, urls, receipts and vault fields can never
// appear because the exporter is handed a vault-free projection by
// construction.
import { afterEach, describe, expect, it } from "vitest"
import { parseLegacyLibrary } from "../../../../packages/shared/src/local-import"
import type { LocalCommand, LocalPlaylist } from "../../../../packages/shared/src/local-model"
import { createModalHost } from "../../src/player/modal"
import type { CommandReply } from "../../src/storage/repository"
import { emptyTransientState } from "../../src/storage/transient"
import type { OptionsDeps } from "../../src/ui/options"
import { createImportExport } from "../../src/ui/options-io"
import type { VaultReply } from "../../src/ui/storage-client"
import { playlist } from "../domain/fixtures"
import { publicationRecord } from "./fixtures"

const FORBIDDEN_EXPORT_KEYS = [
  "manageSecret",
  "sentSnapshot",
  "acknowledgedHash",
  "contentHash",
  "publications",
  "pendingCreates",
  "appliedOperations",
  "migrationRecovery",
  "revision",
  "visibility",
  "shareId",
  "url",
  "dop_v2",
]

type Harness = {
  readonly deps: OptionsDeps
  readonly commands: LocalCommand[]
}

function makeDeps(playlists: readonly LocalPlaylist[]): Harness {
  const commands: LocalCommand[] = []
  const vault: VaultReply = {
    revision: 0,
    publications: [publicationRecord()],
    pendingCreates: [],
  }
  const deps: OptionsDeps = {
    doc: document,
    storage: {
      readPublic: async () => ({
        schemaVersion: 2,
        revision: 0,
        playlists: [...playlists],
        preferences: { windowMode: "window", collapsedPlaylists: {} },
      }),
      readVault: async () => vault,
      readTransient: async () => emptyTransientState(),
      writeTransient: async () => undefined,
      dispatch: async (command) => {
        commands.push(command)
        const reply: CommandReply = {
          kind: "committed",
          operationId: command.operationId,
          revision: 1,
        }
        return reply
      },
    },
    sendMessage: async () => undefined,
    version: "2.0.0",
    now: () => 1_700_000_000_000,
    newId: () => crypto.randomUUID(),
    schedule: () => ({}),
    cancelTimer: () => {},
    subscribe: () => () => {},
  }
  return { deps, commands }
}

async function captureExport(deps: OptionsDeps): Promise<string> {
  const blobs: Blob[] = []
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  const originalClick = HTMLAnchorElement.prototype.click
  URL.createObjectURL = (blob: Blob) => {
    blobs.push(blob)
    return "blob:mock-export"
  }
  URL.revokeObjectURL = () => {}
  HTMLAnchorElement.prototype.click = () => {}
  try {
    const io = createImportExport({
      doc: document,
      deps,
      modal: createModalHost(document),
      showStatus: () => {},
      render: () => {},
    })
    await io.exportJson()
  } finally {
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
    HTMLAnchorElement.prototype.click = originalClick
  }
  expect(blobs).toHaveLength(1)
  const blob = blobs[0]
  if (blob === undefined) throw new Error("export produced no blob")
  return blob.text()
}

describe("portable export", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })

  it("writes the versioned envelope with only whitelisted playlist fields", async () => {
    const { deps } = makeDeps([playlist("p1"), { ...playlist("sys"), name: "__dop_pending" }])
    const text = await captureExport(deps)
    const parsed: unknown = JSON.parse(text)

    // Envelope shape: exactly schemaVersion + playlists, no extra state keys.
    expect(Object.keys(parsed as Record<string, unknown>).sort()).toEqual([
      "playlists",
      "schemaVersion",
    ])
    expect((parsed as { schemaVersion: unknown }).schemaVersion).toBe(2)

    // Item whitelist: ids, episodeNumber and ranges survive; url does not.
    const envelope = parsed as {
      playlists: { id: string; items: Record<string, unknown>[] }[]
    }
    expect(envelope.playlists[0]?.items[0]).not.toHaveProperty("url")
    const imported = parseLegacyLibrary(parsed)
    expect(imported.source).toBe("envelope-v2")
    expect(imported.quarantined).toHaveLength(0)
    const first = imported.playlists[0]
    expect(first?.id).toBe("p1")
    expect(first?.items.map((entry) => entry.id)).toEqual(["a", "b", "c"])
    expect(first?.items[0]?.episodeNumber).toBe("a")
    expect(first?.items[0]?.range).toEqual({ start: 90_123, end: 180_987, name: "My OP" })

    // __dop_ system playlists never leave the browser.
    expect(imported.playlists.map((entry) => entry.name)).not.toContain("__dop_pending")
    expect(text).not.toContain("__dop_")
  })

  it("contains zero management or storage internals even when a vault exists", async () => {
    const { deps } = makeDeps([playlist("p1")])
    const text = await captureExport(deps)
    for (const key of FORBIDDEN_EXPORT_KEYS) {
      expect(text).not.toContain(`"${key}"`)
    }
    expect(text).not.toContain("m".repeat(43))
  })

  it("round-trips through the importer without quarantine", async () => {
    const original = playlist("p1", ["a", "b"])
    const { deps } = makeDeps([original])
    const text = await captureExport(deps)
    const reimported = parseLegacyLibrary(JSON.parse(text))
    expect(reimported.quarantined).toHaveLength(0)
    expect(reimported.repairedIdCount).toBe(0)
    expect(reimported.playlists[0]?.items.map((entry) => entry.partId)).toEqual(
      original.items.map((entry) => entry.partId),
    )
  })
})
