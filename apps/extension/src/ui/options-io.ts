// Import/export for the options page — ports options.js:816-891. Export
// writes the schema envelope (SafeExportEnvelope); import accepts both the
// envelope and the legacy bare array via parseLegacyLibrary, asks
// replace/merge, resolves same-name conflicts, and commits one
// replace-library that always preserves internal __dop_ playlists.

import { LOCAL_SCHEMA_VERSION } from "../../../../packages/shared/src/limits"
import {
  FutureExportVersionError,
  MalformedExportError,
  parseLegacyLibrary,
} from "../../../../packages/shared/src/local-import"
import type { LocalPlaylist } from "../../../../packages/shared/src/local-model"
import type { ModalHost } from "../player/modal"
import { isSystemPlaylist } from "./format"
import { dedupeNames, findNameConflicts, mergePlaylists } from "./import-merge"
import type { OptionsDeps } from "./options"
import { runMutation } from "./storage-client"

export type ImportExportContext = {
  readonly doc: Document
  readonly deps: OptionsDeps
  readonly modal: ModalHost
  readonly showStatus: (text: string, type?: "success" | "error") => void
  readonly render: () => void
}

export type ImportExport = {
  readonly exportJson: () => Promise<void>
  readonly importJson: (file: File, input: HTMLInputElement) => Promise<void>
}

export function createImportExport(ctx: ImportExportContext): ImportExport {
  const { doc, deps, modal, showStatus, render } = ctx

  async function exportJson(): Promise<void> {
    const state = await deps.storage.readPublic()
    const playlists = state.playlists.filter((playlist) => !isSystemPlaylist(playlist))
    // v2 exports the schema envelope (SafeExportEnvelope); the legacy bare
    // array stays accepted on import via parseLegacyLibrary.
    const envelope = { schemaVersion: LOCAL_SCHEMA_VERSION, playlists }
    const blob = new Blob([JSON.stringify(envelope, null, 2)], {
      type: "application/json",
    })
    const url = URL.createObjectURL(blob)
    const anchor = doc.createElement("a")
    anchor.href = url
    anchor.download = `dop_playlists_${deps.now()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    showStatus("エクスポートしました。")
  }

  async function showImportChoice(): Promise<"replace" | "merge" | null> {
    const value = await modal.show({
      title: "インポート方法",
      body: "すでにプレイリストが存在します。インポートしたデータをマージしますか？それとも既存データをすべて上書きしますか？",
      buttons: [
        { label: "キャンセル", value: "cancel" },
        { label: "上書き", value: "replace" },
        { label: "マージ", value: "merge", primary: true },
      ],
    })
    return value === "replace" || value === "merge" ? value : null
  }

  async function showMergeNameChoice(
    conflicts: readonly LocalPlaylist[],
  ): Promise<"merge" | "separate" | null> {
    const names = conflicts.map((c) => `「${c.name}」（${c.items.length}件）`).join("、")
    const value = await modal.show({
      title: "同名のプレイリスト",
      body: `既存の${names}と統合しますか？`,
      buttons: [
        { label: "キャンセル", value: "cancel" },
        { label: "別名で追加", value: "separate" },
        { label: "マージ（重複スキップ）", value: "merge", primary: true },
      ],
    })
    return value === "merge" || value === "separate" ? value : null
  }

  async function importJson(file: File, input: HTMLInputElement): Promise<void> {
    try {
      const text = await file.text()
      const parsed = parseLegacyLibrary(JSON.parse(text))
      const cleaned = parsed.playlists.filter((playlist) => !isSystemPlaylist(playlist))
      const fresh = await deps.storage.readPublic()
      // v2 deviation: a "replace" import keeps internal __dop_ playlists —
      // legacy dropped them because dopSavePlaylists wrote the filtered list.
      const existing = fresh.playlists.filter((playlist) => !isSystemPlaylist(playlist))

      const commit = (playlists: readonly LocalPlaylist[]): Promise<unknown> =>
        runMutation(
          deps.storage,
          (latest) => ({
            kind: "replace-library",
            playlists: [
              ...playlists,
              ...latest.playlists.filter((playlist) => isSystemPlaylist(playlist)),
            ],
          }),
          deps.newId,
        )

      if (existing.length > 0) {
        const choice = await showImportChoice()
        if (choice === "replace") {
          await commit(cleaned)
          render()
          showStatus("インポートしました（上書き）。")
        } else if (choice === "merge") {
          const conflicts = findNameConflicts(existing, cleaned)
          let mergeMode: "merge" | "separate" | null = "merge"
          if (conflicts.length > 0) {
            mergeMode = await showMergeNameChoice(conflicts)
            if (mergeMode === null) {
              input.value = ""
              return
            }
          }
          const toImport =
            mergeMode === "separate" ? dedupeNames(cleaned, existing, deps.newId) : cleaned
          const mergeNames = mergeMode === "merge" ? conflicts.map((c) => c.name) : []
          const { playlists: merged, skipped } = mergePlaylists(existing, toImport, mergeNames)
          await commit(merged)
          render()
          const imported = cleaned.reduce((sum, p) => sum + p.items.length, 0)
          const added = imported - skipped
          showStatus(
            `インポート: ${added}件追加${skipped > 0 ? `（${skipped}件の重複をスキップ）` : ""}`,
          )
        }
      } else {
        await commit(cleaned)
        render()
        const total = cleaned.reduce((sum, p) => sum + p.items.length, 0)
        showStatus(`インポート: ${total}件追加`)
      }
      if (parsed.quarantined.length > 0 || parsed.repairedIdCount > 0) {
        deps.log?.("import-repaired", {
          quarantined: parsed.quarantined.length,
          repaired: parsed.repairedIdCount,
        })
      }
    } catch (error) {
      const detail =
        error instanceof FutureExportVersionError || error instanceof MalformedExportError
          ? error.message
          : "invalid format"
      showStatus(`インポートに失敗しました: ${detail}`, "error")
    }
    input.value = ""
  }

  return { exportJson, importJson }
}
