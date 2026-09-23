// @vitest-environment jsdom
// Share-management dialog tests (task 15): explicit visibility on first
// publish (button disabled until a radio is chosen), dirty badge rendering,
// update/delete actions, inline confirmations (no native dialogs),
// secret never rendered, and zero fetch calls — the dialog only talks to the
// background via the ShareManageClient stub.
import { describe, expect, it, vi } from "vitest"
import type { LocalPlaylist, PublicationRecord } from "../../../../packages/shared/src/local-model"
import { createModalHost } from "../../src/player/modal"
import type { ShareManageClient, ShareManageReply } from "../../src/share/management-protocol"
import { SHARE_ORIGIN, sharePageUrl } from "../../src/share/origins"
import { createShareDialog } from "../../src/ui/share-dialog"
import { playlist } from "../domain/fixtures"
import { linkedRecord, MANAGE_SECRET, SHARE_ID } from "./fixtures"

function reply(status: string, extra: Record<string, unknown> = {}): ShareManageReply {
  return { kind: "share-manage-result", status, ...extra } as ShareManageReply
}

function storageStub(
  playlists: LocalPlaylist[],
  publications: PublicationRecord[],
  shareConsent: { choice: "granted" | "declined"; decidedAt: string } | null = {
    choice: "granted",
    decidedAt: "2026-09-20T00:00:00.000Z",
  },
) {
  return {
    readPublic: async () => ({
      schemaVersion: 2 as const,
      revision: 0,
      playlists,
      preferences: { windowMode: "window" as const, collapsedPlaylists: {} },
    }),
    // Task 22: default the dialog tests to a granted consent so they exercise
    // the management surface; pass null/declined for the consent-panel tests.
    readVault: async () => ({
      revision: 0,
      publications,
      pendingCreates: [],
      ...(shareConsent === null ? {} : { shareConsent }),
    }),
    dispatch: async () => ({ kind: "committed" as const, operationId: "op", revision: 1 }),
  }
}

function manageStub(overrides: Partial<ShareManageClient> = {}): ShareManageClient {
  return {
    publish: vi.fn(async () =>
      reply("published", {
        shareId: SHARE_ID,
        url: sharePageUrl(SHARE_ID),
        revision: 2,
      }),
    ),
    activate: vi.fn(async () => reply("activated", { shareId: SHARE_ID, revision: 2 })),
    update: vi.fn(async () => reply("updated", { shareId: SHARE_ID, revision: 3 })),
    deleteRemote: vi.fn(async () => reply("deleted", { shareId: SHARE_ID })),
    inspect: vi.fn(async () =>
      reply("inspect", { shareId: SHARE_ID, remote: "active", remoteRevision: 2 }),
    ),
    source: vi.fn(async () => reply("source", { sourceState: "none" })),
    ...overrides,
  }
}

type Rig = {
  dialog: ReturnType<typeof createShareDialog>
  manage: ShareManageClient
  storage: ReturnType<typeof storageStub>
  statuses: string[]
  subscribed: () => void
}

function rig(
  playlists: LocalPlaylist[],
  publications: PublicationRecord[],
  manage: ShareManageClient = manageStub(),
  shareConsent?: { choice: "granted" | "declined"; decidedAt: string } | null,
): Rig {
  const listeners: (() => void)[] = []
  const statuses: string[] = []
  const storage =
    shareConsent === undefined
      ? storageStub(playlists, publications)
      : storageStub(playlists, publications, shareConsent)
  const dialog = createShareDialog({
    doc: document,
    modal: createModalHost(document),
    storage,
    manage,
    newId: () => crypto.randomUUID(),
    copyText: async () => true,
    showStatus: (text) => statuses.push(text),
    subscribe: (listener) => {
      listeners.push(listener)
      return () => undefined
    },
  })
  return {
    dialog,
    manage,
    storage,
    statuses,
    subscribed: () => {
      listeners.forEach((listener) => {
        listener()
      })
    },
  }
}

const closeModal = async (): Promise<void> => {
  document.querySelector<HTMLButtonElement>("#d-op-modal .d-op-modal-footer button")?.click()
  await vi.waitFor(() => expect(document.querySelector("#d-op-modal")).toBeNull())
}

const q = <T extends HTMLElement>(selector: string): T => document.querySelector(selector) as T

describe("share-dialog", () => {
  it("requires an explicit visibility choice before first publish", async () => {
    const local = playlist("p1", ["a"])
    const publications: PublicationRecord[] = []
    const manage = manageStub({
      publish: vi.fn(async () => {
        // The committed vault write makes the record visible on reload.
        publications.push(await linkedRecord(local))
        return reply("published", {
          shareId: SHARE_ID,
          url: sharePageUrl(SHARE_ID),
          revision: 2,
        })
      }),
    })
    const { dialog } = rig([local], publications, manage)
    const open = dialog.open("p1")
    await vi.waitFor(() => expect(q(".share-dialog")).not.toBeNull())
    expect(q<HTMLButtonElement>(".share-publish").disabled).toBe(true)
    expect(q<HTMLInputElement>("input[name='dopShareVisibility']:checked")).toBeNull()

    const radio = q<HTMLInputElement>("input[name='dopShareVisibility'][value='public']")
    radio.checked = true
    radio.dispatchEvent(new Event("change", { bubbles: true }))
    await vi.waitFor(() => expect(q<HTMLButtonElement>(".share-publish").disabled).toBe(false))

    q<HTMLButtonElement>(".share-publish").click()
    await vi.waitFor(() => expect(manage.publish).toHaveBeenCalledOnce())
    expect(manage.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        playlistId: "p1",
        metadata: expect.objectContaining({ visibility: "public" }),
      }),
    )
    await vi.waitFor(() =>
      expect(q(".share-url").textContent).toBe(`${SHARE_ORIGIN}/p/${SHARE_ID}`),
    )
    await closeModal()
    await open
  })

  it("shows the dirty badge and URL for an edited active record; update sends a replace intent", async () => {
    const local = playlist("p1", ["a"])
    const record = await linkedRecord(local)
    const edited = { ...local, name: "Edited name" }
    const { dialog, manage } = rig([edited], [record])
    const open = dialog.open("p1")
    await vi.waitFor(() => expect(q(".share-dirty")).not.toBeNull())
    expect(q(".share-dirty").textContent).toBe("未公開の変更があります")
    expect(q(".share-url").textContent).toBe(`${SHARE_ORIGIN}/p/${SHARE_ID}`)
    // Opening an active record reconciles remote once (explicit open = action).
    await vi.waitFor(() => expect(manage.inspect).toHaveBeenCalledOnce())

    q<HTMLButtonElement>(".share-update").click()
    await vi.waitFor(() => expect(manage.update).toHaveBeenCalledOnce())
    expect(manage.update).toHaveBeenCalledWith(
      expect.objectContaining({ shareId: SHARE_ID, operationId: expect.any(String) }),
    )
    await closeModal()
    await open
  })

  it("delete needs the inline confirmation and issues a conditional remote delete", async () => {
    const local = playlist("p1", ["a"])
    const record = await linkedRecord(local)
    const { dialog, manage, statuses } = rig([local], [record])
    const open = dialog.open("p1")
    await vi.waitFor(() => expect(q(".share-delete")).not.toBeNull())
    q<HTMLButtonElement>(".share-delete").click()
    await vi.waitFor(() => expect(q(".share-confirm-delete")).not.toBeNull())
    expect(manage.deleteRemote).not.toHaveBeenCalled() // not yet — confirm first
    q<HTMLButtonElement>(".share-confirm-delete").click()
    await vi.waitFor(() => expect(manage.deleteRemote).toHaveBeenCalledOnce())
    expect(manage.deleteRemote).toHaveBeenCalledWith(expect.objectContaining({ shareId: SHARE_ID }))
    // 'deleted' closes the dialog with a status toast.
    await vi.waitFor(() => expect(document.querySelector("#d-op-modal")).toBeNull())
    expect(statuses).toContain("公開版を削除しました。")
    await open
  })

  it("never renders the manageSecret and never calls fetch during render", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const local = playlist("p1", ["a"])
    const record = await linkedRecord(local)
    const { dialog, subscribed } = rig([local], [record])
    const open = dialog.open("p1")
    await vi.waitFor(() => expect(q(".share-dialog")).not.toBeNull())
    expect(document.body.innerHTML).not.toContain(MANAGE_SECRET)
    // A storage-change nudge re-renders status only — still no fetch.
    subscribed()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchSpy).not.toHaveBeenCalled()
    await closeModal()
    await open
    fetchSpy.mockRestore()
  })

  it("pending records offer the resume-activation action", async () => {
    const local = playlist("p1", ["a"])
    const record = await linkedRecord(local, { state: "pending", revision: 1 })
    const { dialog, manage } = rig([local], [record])
    const open = dialog.open("p1")
    await vi.waitFor(() => expect(q(".share-activate")).not.toBeNull())
    q<HTMLButtonElement>(".share-activate").click()
    await vi.waitFor(() => expect(manage.activate).toHaveBeenCalledOnce())
    expect(manage.activate).toHaveBeenCalledWith(expect.objectContaining({ shareId: SHARE_ID }))
    await closeModal()
    await open
  })
})
