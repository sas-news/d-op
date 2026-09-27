// @vitest-environment jsdom
// Task-11 import acceptance: historical bare-array JSON and the v2 envelope
// are both accepted; future versions, oversize payloads, foreign envelope
// keys and invalid items are rejected with an explanation BEFORE anything is
// dispatched — imports are all-or-nothing (a single bad item aborts the whole
// commit and enumerates per-item errors). Duplicate ids are repaired at the
// shared boundary, never silent-merged.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  LOCAL_IMPORT_FILE_MAX_BYTES,
  LOCAL_IMPORT_MAX_ITEMS,
} from "../../../../packages/shared/src/limits"
import type { LocalCommand, LocalPlaylist } from "../../../../packages/shared/src/local-model"
import { createModalHost } from "../../src/player/modal"
import type { CommandReply } from "../../src/storage/repository"
import { emptyTransientState } from "../../src/storage/transient"
import type { OptionsDeps } from "../../src/ui/options"
import { createImportExport } from "../../src/ui/options-io"
import { item, playlist } from "../domain/fixtures"

const HTML = `<div id="importStatus"></div>`

type Harness = {
  readonly deps: OptionsDeps
  readonly commands: LocalCommand[]
  readonly statuses: string[]
  readonly state: { public: { playlists: LocalPlaylist[]; revision: number } }
  readonly io: ReturnType<typeof createImportExport>
}

function makeDeps(existing: readonly LocalPlaylist[] = []): Harness {
  const commands: LocalCommand[] = []
  const statuses: string[] = []
  const state = {
    public: {
      schemaVersion: 2 as const,
      revision: 0,
      playlists: [...existing],
      preferences: { windowMode: "window" as const, collapsedPlaylists: {} },
    },
  }
  const deps: OptionsDeps = {
    doc: document,
    storage: {
      readPublic: async () => state.public,
      readVault: async () => ({ revision: 0, publications: [], pendingCreates: [] }),
      readTransient: async () => emptyTransientState(),
      writeTransient: async () => undefined,
      dispatch: async (command) => {
        commands.push(command)
        if (command.kind === "replace-library") {
          state.public = { ...state.public, playlists: [...command.playlists] }
        }
        state.public.revision += 1
        const reply: CommandReply = {
          kind: "committed",
          operationId: command.operationId,
          revision: state.public.revision,
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
  const io = createImportExport({
    doc: document,
    deps,
    modal: createModalHost(document),
    showStatus: (text) => statuses.push(text),
    render: () => {},
  })
  return { deps, commands, statuses, state, io }
}

function importFile(data: unknown): File {
  const text = typeof data === "string" ? data : JSON.stringify(data)
  return new File([text], "import.json", { type: "application/json" })
}

async function runImport(harness: Harness, file: File): Promise<void> {
  const input = document.createElement("input")
  input.type = "file"
  await harness.io.importJson(file, input)
  // Resolve any modal the flow opened (e.g. the import-choice dialog) by
  // leaving it for the test to drive.
}

async function clickModalButton(label: string): Promise<void> {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>(".d-op-modal-footer button"),
  ].find((candidate) => candidate.textContent === label)
  if (button === undefined) throw new Error(`modal button not found: ${label}`)
  button.click()
  await settle()
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

const VALID_ITEM = {
  id: "imp-item-1",
  partId: "pt_1",
  title: "作品",
  episodeTitle: "第1話",
  episodeNumber: "1",
  url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=pt_1",
  range: { start: 90_000, end: 180_000, name: "OP" },
}

describe("portable import", () => {
  beforeEach(() => {
    document.body.innerHTML = HTML
  })
  afterEach(() => {
    document.body.innerHTML = ""
  })

  it("accepts the historical bare-array export into an empty library", async () => {
    const harness = makeDeps()
    await runImport(harness, importFile([{ id: "imp-pl", name: "旧リスト", items: [VALID_ITEM] }]))
    await settle()
    const replace = harness.commands.find((c) => c.kind === "replace-library")
    expect(replace).toBeDefined()
    expect(harness.state.public.playlists.map((p) => p.id)).toEqual(["imp-pl"])
    expect(harness.state.public.playlists[0]?.items[0]?.episodeNumber).toBe("1")
  })

  it("accepts the v2 envelope and preserves ranges + ids", async () => {
    const harness = makeDeps()
    await runImport(
      harness,
      importFile({
        schemaVersion: 2,
        playlists: [{ id: "env-pl", name: "Envelope", items: [{ ...VALID_ITEM, id: "env-item" }] }],
      }),
    )
    await settle()
    expect(harness.state.public.playlists[0]?.items[0]?.id).toBe("env-item")
    expect(harness.state.public.playlists[0]?.items[0]?.range).toEqual({
      start: 90_000,
      end: 180_000,
      name: "OP",
    })
  })

  it("maps legacy range.type into names on import", async () => {
    const harness = makeDeps()
    await runImport(
      harness,
      importFile([
        {
          id: "typed-pl",
          name: "Typed",
          items: [{ ...VALID_ITEM, range: { start: 0, end: 90_000, type: "op" } }],
        },
      ]),
    )
    await settle()
    expect(harness.state.public.playlists[0]?.items[0]?.range?.name).toBe("OP")
  })

  it("rejects a future export version without touching the library", async () => {
    const harness = makeDeps([playlist("p1")])
    await runImport(harness, importFile({ schemaVersion: 3, playlists: [] }))
    await settle()
    expect(harness.commands).toHaveLength(0)
    expect(harness.state.public.playlists).toHaveLength(1)
    expect(harness.statuses.at(-1)).toContain("インポートに失敗")
  })

  it("rejects envelopes carrying non-portable keys (publications/secrets)", async () => {
    const harness = makeDeps([playlist("p1")])
    const hostile = {
      schemaVersion: 2,
      playlists: [{ id: "x", name: "X", items: [VALID_ITEM] }],
      publications: [{ shareId: "abcdefghijklmnopqrstuv", manageSecret: "k".repeat(43) }],
    }
    await runImport(harness, importFile(hostile))
    await settle()
    expect(harness.commands).toHaveLength(0)
    expect(harness.state.public.playlists.map((p) => p.id)).toEqual(["p1"])
    expect(harness.statuses.at(-1)).toContain("インポートに失敗")
  })

  it("rejects files over the byte cap before parsing", async () => {
    const harness = makeDeps()
    // VALID json (empty array) padded past 10 MiB — the byte cap must reject
    // it, not the parser, and nothing may be dispatched.
    const padded = `[${" ".repeat(LOCAL_IMPORT_FILE_MAX_BYTES)}]`
    const file = new File([padded], "big.json")
    expect(file.size).toBeGreaterThan(LOCAL_IMPORT_FILE_MAX_BYTES)
    await runImport(harness, file)
    await settle()
    expect(harness.commands).toHaveLength(0)
    expect(harness.statuses.at(-1)).toContain("インポートに失敗")
  })

  it("rejects libraries over the item cap", async () => {
    const harness = makeDeps()
    const items = Array.from({ length: LOCAL_IMPORT_MAX_ITEMS + 1 }, (_, i) => ({
      ...VALID_ITEM,
      id: `overflow-${i}`,
    }))
    await runImport(harness, importFile([{ id: "huge", name: "Huge", items }]))
    await settle()
    expect(harness.commands).toHaveLength(0)
    expect(harness.statuses.at(-1)).toContain("インポートに失敗")
  })

  it("aborts the whole import when any item is invalid and enumerates errors", async () => {
    const harness = makeDeps([playlist("p1")])
    const bad = {
      id: "bad-pl",
      name: "Bad",
      // Unrecoverable under the lenient parser: empty partId and a url with
      // no partId parameter to rescue it from.
      items: [
        {
          ...VALID_ITEM,
          id: "bad-item",
          partId: "",
          url: "https://animestore.docomo.ne.jp/animestore/sc_d_pc",
        },
      ],
    }
    const pending = runImport(
      harness,
      importFile([{ id: "ok", name: "OK", items: [VALID_ITEM] }, bad]),
    )
    await settle()
    // The enumerated-error modal lists the failing playlist/item.
    const list = document.querySelector(".import-error-list")
    expect(list?.textContent).toContain("プレイリスト2")
    await clickModalButton("OK")
    await pending
    await settle()
    expect(harness.commands).toHaveLength(0)
    expect(harness.state.public.playlists.map((p) => p.id)).toEqual(["p1"])
    expect(harness.statuses.at(-1)).toContain("1件")
  })

  it("repairs duplicate ids at the boundary instead of silent-merging", async () => {
    const harness = makeDeps()
    const dup = {
      id: "dup-pl",
      name: "Dup",
      items: [
        { ...VALID_ITEM, id: "shared" },
        { ...VALID_ITEM, id: "shared", partId: "pt_2" },
      ],
    }
    await runImport(harness, importFile([dup]))
    await settle()
    const ids = harness.state.public.playlists[0]?.items.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids?.[0]).toBe("shared")
    expect(ids?.[1]).not.toBe("shared")
  })

  it("merge with same-name conflict offers 別名で追加 (separate)", async () => {
    const harness = makeDeps([playlist("p1")]) // playlist named "Playlist p1"
    const imported = [{ id: "imp", name: "Playlist p1", items: [item("brand-new")] }]
    const pending = runImport(harness, importFile(imported))
    await settle()
    await clickModalButton("マージ") // import choice: merge
    await clickModalButton("別名で追加") // name conflict: separate
    await pending
    await settle()
    const names = harness.state.public.playlists.map((p) => p.name)
    expect(names).toContain("Playlist p1")
    expect(names.some((name) => name !== "Playlist p1" && name.startsWith("Playlist p1"))).toBe(
      true,
    )
    const replace = harness.commands.find((c) => c.kind === "replace-library")
    expect(replace).toBeDefined()
  })

  it("cancel at the import-choice dialog dispatches nothing", async () => {
    const harness = makeDeps([playlist("p1")])
    const pending = runImport(harness, importFile([{ id: "imp", name: "Other", items: [] }]))
    await settle()
    await clickModalButton("キャンセル")
    await pending
    await settle()
    expect(harness.commands).toHaveLength(0)
    expect(harness.state.public.playlists.map((p) => p.id)).toEqual(["p1"])
  })

  it("replace mode commits exactly one replace-library", async () => {
    const harness = makeDeps([playlist("p1"), playlist("p2", ["x"])])
    const pending = runImport(
      harness,
      importFile([{ id: "fresh", name: "Fresh", items: [VALID_ITEM] }]),
    )
    await settle()
    await clickModalButton("上書き")
    await pending
    await settle()
    const replaces = harness.commands.filter((c) => c.kind === "replace-library")
    expect(replaces).toHaveLength(1)
    expect(harness.state.public.playlists.map((p) => p.id)).toEqual(["fresh"])
  })

  it("malformed JSON reports a parse failure", async () => {
    const harness = makeDeps()
    await runImport(harness, importFile("{not json"))
    await settle()
    expect(harness.commands).toHaveLength(0)
    expect(harness.statuses.at(-1)).toContain("インポートに失敗")
  })
})
