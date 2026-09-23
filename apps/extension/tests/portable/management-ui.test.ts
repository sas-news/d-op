// @vitest-environment jsdom
// Task-11 detached-management UI acceptance: the options page exposes the
// '共有管理 / ローカル削除済み' list backed by the REAL repository vault and
// shows only detached records without ever rendering key material. There is
// no standalone key-discard action — remote delete retires the key only
// after a confirmed remote deletion.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { InMemoryStorageDriver } from "../../src/storage/driver"
import { createLocalRepository } from "../../src/storage/repository"
import { createOptionsController, type OptionsDeps } from "../../src/ui/options"
import { NOW_ISO, publicationRecord, v2State } from "./fixtures"

const HTML = `
  <span id="optionsVersion"></span>
  <input id="newPlaylistName" /><button id="createPlaylistBtn"></button>
  <button id="exportBtn"></button><input id="importFile" type="file" />
  <div id="importStatus"></div>
  <label><input type="radio" name="windowMode" value="window" /></label>
  <label><input type="radio" name="windowMode" value="tab" /></label>
  <div id="playlistsContainer"></div>
  <div id="managementList"></div>
`

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function makeController(state = v2State()): {
  readonly deps: OptionsDeps
  readonly driver: InMemoryStorageDriver
} {
  const driver = new InMemoryStorageDriver({ dop_v2_state: state })
  const repository = createLocalRepository({
    driver,
    now: () => NOW_ISO,
    newId: () => crypto.randomUUID(),
  })
  const deps: OptionsDeps = {
    doc: document,
    storage: {
      readPublic: () => repository.readPublic(),
      // VaultReply carries mutable arrays; PublicationVault is readonly.
      readVault: async () => {
        const vault = await repository.readVault()
        return {
          revision: vault.revision,
          publications: [...vault.publications],
          pendingCreates: [...vault.pendingCreates],
        }
      },
      readTransient: async () => ({ schemaVersion: 1, generation: 0 }),
      writeTransient: async () => undefined,
      dispatch: (command) => repository.dispatch(command),
    },
    sendMessage: async () => undefined,
    version: "2.0.0",
    now: () => 1_700_000_000_000,
    newId: () => crypto.randomUUID(),
    schedule: () => ({}),
    cancelTimer: () => {},
    subscribe: () => () => {},
  }
  return { deps, driver }
}

async function clickModalButton(label: string): Promise<void> {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>(".d-op-modal-footer button"),
  ].find((candidate) => candidate.textContent === label)
  if (button === undefined) throw new Error(`modal button not found: ${label}`)
  button.click()
  await settle()
}

describe("options 共有管理 (detached publication records)", () => {
  beforeEach(() => {
    document.body.innerHTML = HTML
  })
  afterEach(() => {
    document.body.innerHTML = ""
  })

  it("lists only local-deleted records and never renders key material", async () => {
    const { deps } = makeController(
      v2State({
        publications: [
          publicationRecord({ localPlaylistId: null, state: "local-deleted" }),
          publicationRecord({
            shareId: "0123456789abcdefghijkl",
            localPlaylistId: "p1",
            state: "active",
            manageSecret: "S".repeat(43),
          }),
        ],
      }),
    )
    const controller = createOptionsController(deps)
    controller.start()
    await settle()

    const rows = document.querySelectorAll("#managementList .management-row")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain("abcdefghijklmnopqrstuv")
    // Neither manageSecret nor sentSnapshot/acknowledgedHash reach the DOM.
    expect(document.body.innerHTML).not.toContain("m".repeat(43))
    expect(document.body.innerHTML).not.toContain("S".repeat(43))
    expect(document.body.innerHTML).not.toContain("sentSnapshot")
    controller.dispose()
  })

  it("local playlist delete detaches the record and surfaces it in the list", async () => {
    const { deps } = makeController(
      v2State({ publications: [publicationRecord({ localPlaylistId: "p1" })] }),
    )
    const controller = createOptionsController(deps)
    controller.start()
    await settle()
    expect(document.querySelectorAll("#managementList .management-row")).toHaveLength(0)

    // Delete playlist p1 through the existing UI confirm flow.
    const deleteBtn = [
      ...document.querySelectorAll<HTMLButtonElement>(".playlist-card .playlist-actions button"),
    ].find((candidate) => candidate.textContent === "削除")
    deleteBtn?.click()
    await settle()
    await clickModalButton("削除")
    await settle()

    // The record is detached — not dropped — and listed as ローカル削除済み.
    const rows = document.querySelectorAll("#managementList .management-row")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.getAttribute("data-share-id")).toBe("abcdefghijklmnopqrstuv")
    const vault = await deps.storage.readVault()
    expect(vault.publications[0]).toMatchObject({
      state: "local-deleted",
      localPlaylistId: null,
      manageSecret: "m".repeat(43),
    })
    controller.dispose()
  })

  it("detached rows expose no key-discard action", async () => {
    const { deps } = makeController(
      v2State({
        publications: [publicationRecord({ localPlaylistId: null, state: "local-deleted" })],
      }),
    )
    const controller = createOptionsController(deps)
    controller.start()
    await settle()

    const row = document.querySelector("#managementList .management-row")
    expect(row).not.toBeNull()
    // No standalone discard surface — the only destructive path is remote
    // delete, which retires the key internally after confirmed removal.
    expect(row?.querySelector(".management-destroy")).toBeNull()
    expect(row?.textContent).not.toContain("破棄")
    expect((await deps.storage.readVault()).publications).toHaveLength(1)
    controller.dispose()
  })

  it("shows an empty-state note when nothing is detached", async () => {
    const { deps } = makeController()
    const controller = createOptionsController(deps)
    controller.start()
    await settle()
    expect(document.querySelector("#managementList .management-empty")?.textContent).toContain(
      "ありません",
    )
    controller.dispose()
  })
})
