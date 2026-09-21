// Import/export for the options page — ports options.js:816-891 onto the
// task-11 portable contract (Local data steps 6-7). Export writes ONLY the
// shared SafeExport whitelist via buildSafeExport (no publications, secrets,
// playback or urls — the vault is unreachable here by construction). Import
// accepts the v2 envelope AND the historical bare array via
// parseLegacyLibrary, enforces the 10 MiB / 10,000-item budgets before
// dispatch, rejects envelopes carrying non-portable keys, and aborts
// all-or-nothing with enumerated per-item errors when any entry is invalid.
// Commits are a single replace-library; the repository detaches publication
// records and reconciles transient playback.

import { LOCAL_SCHEMA_VERSION } from "../../../../packages/shared/src/limits"
import {
  buildSafeExport,
  checkLocalImportBudget,
} from "../../../../packages/shared/src/local-export"
import {
  FutureExportVersionError,
  MalformedExportError,
  parseLegacyLibrary,
} from "../../../../packages/shared/src/local-import"
import type { LocalPlaylist, QuarantineEntry } from "../../../../packages/shared/src/local-model"
import { OversizePayloadError } from "../../../../packages/shared/src/share-errors"
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

/** Portable envelopes may carry exactly {schemaVersion, playlists} — a file
 *  containing publications/keys/other state is not a safe export. */
const ENVELOPE_KEYS = new Set(["schemaVersion", "playlists"])

function rejectForeignEnvelopeKeys(data: unknown): void {
  if (Array.isArray(data) || typeof data !== "object" || data === null) return
  const foreign = Object.keys(data).filter((key) => !ENVELOPE_KEYS.has(key))
  if (foreign.length > 0) throw new MalformedExportError(`root.${foreign[0]}`)
}

function describeError(error: unknown): string {
  if (error instanceof FutureExportVersionError)
    return `対応していないエクスポート形式です（schemaVersion: ${JSON.stringify(error.version)}）`
  if (error instanceof MalformedExportError) return `形式が不正です（${error.path}）`
  if (error instanceof OversizePayloadError)
    return `サイズ上限を超えています（${error.amount}${error.unit === "bytes" ? "バイト" : "件"} / 上限${error.limit}）`
  if (error instanceof SyntaxError) return "JSONの構文が不正です"
  return "invalid format"
}

export function createImportExport(ctx: ImportExportContext): ImportExport {
  const { doc, deps, modal, showStatus, render } = ctx

  async function exportJson(): Promise<void> {
    const state = await deps.storage.readPublic()
    const playlists = state.playlists.filter((playlist) => !isSystemPlaylist(playlist))
    // buildSafeExport is the explicit portable whitelist; the vault-only fields
    // are never read, so keys/secrets cannot reach the file by construction.
    const envelope = buildSafeExport({
      schemaVersion: LOCAL_SCHEMA_VERSION,
      revision: state.revision,
      playlists,
      publications: [],
      pendingCreates: [],
      preferences: state.preferences,
      appliedOperations: [],
    })
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

  /** All-or-nothing gate: enumerate per-item errors, change nothing. */
  async function showImportErrors(quarantined: readonly QuarantineEntry[]): Promise<void> {
    const list = doc.createElement("ul")
    list.className = "import-error-list"
    for (const entry of quarantined.slice(0, 8)) {
      const li = doc.createElement("li")
      const where =
        entry.itemIndex === undefined
          ? `プレイリスト${entry.playlistIndex + 1}`
          : `プレイリスト${entry.playlistIndex + 1} / 項目${entry.itemIndex + 1}`
      li.textContent = `${where}: ${entry.reason}`
      list.appendChild(li)
    }
    if (quarantined.length > 8) {
      const more = doc.createElement("li")
      more.textContent = `…他${quarantined.length - 8}件`
      list.appendChild(more)
    }
    await modal.show({
      title: "インポートできない項目",
      body: `${quarantined.length}件の項目が不正なため、インポートを中止しました。既存のデータは変更されていません。`,
      bodyNode: list,
      buttons: [{ label: "OK", value: "ok", primary: true }],
    })
  }

  async function importJson(file: File, input: HTMLInputElement): Promise<void> {
    try {
      // Byte budget BEFORE reading the body; item budget inside the parser.
      checkLocalImportBudget({ byteLength: file.size, itemCount: 0 })
      const data: unknown = JSON.parse(await file.text())
      rejectForeignEnvelopeKeys(data)
      const parsed = parseLegacyLibrary(data)
      if (parsed.quarantined.length > 0) {
        await showImportErrors(parsed.quarantined)
        showStatus(
          `インポートに失敗しました（${parsed.quarantined.length}件の不正な項目）`,
          "error",
        )
        return
      }
      const cleaned = parsed.playlists.filter((playlist) => !isSystemPlaylist(playlist))
      const fresh = await deps.storage.readPublic()
      // v2 deviation: a "replace" import keeps internal __dop_ playlists —
      // legacy dropped them because dopSavePlaylists wrote the filtered list.
      const existing = fresh.playlists.filter((playlist) => !isSystemPlaylist(playlist))
      const repairSuffix =
        parsed.repairedIdCount > 0 ? `（${parsed.repairedIdCount}件のIDを修復）` : ""

      // Commits must be verified: a rejected replace-library (e.g. a duplicate
      // id slipping past the boundary repair) is a failure, not a silent no-op.
      const commit = async (playlists: readonly LocalPlaylist[]): Promise<boolean> => {
        const reply = await runMutation(
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
        if (reply.kind !== "committed") {
          deps.log?.("import-commit-failed", reply)
          showStatus("インポートに失敗しました。", "error")
          return false
        }
        return true
      }

      if (existing.length > 0) {
        const choice = await showImportChoice()
        if (choice === "replace") {
          if (await commit(cleaned)) {
            render()
            showStatus(`インポートしました（上書き）。${repairSuffix}`)
          }
        } else if (choice === "merge") {
          const conflicts = findNameConflicts(existing, cleaned)
          let mergeMode: "merge" | "separate" | null = "merge"
          if (conflicts.length > 0) {
            mergeMode = await showMergeNameChoice(conflicts)
            if (mergeMode === null) return
          }
          const toImport =
            mergeMode === "separate" ? dedupeNames(cleaned, existing, deps.newId) : cleaned
          const mergeNames = mergeMode === "merge" ? conflicts.map((c) => c.name) : []
          const { playlists: merged, skipped } = mergePlaylists(existing, toImport, mergeNames)
          if (await commit(merged)) {
            render()
            const imported = cleaned.reduce((sum, p) => sum + p.items.length, 0)
            const added = imported - skipped
            showStatus(
              `インポート: ${added}件追加${skipped > 0 ? `（${skipped}件の重複をスキップ）` : ""}${repairSuffix}`,
            )
          }
        }
      } else {
        if (await commit(cleaned)) {
          render()
          const total = cleaned.reduce((sum, p) => sum + p.items.length, 0)
          showStatus(`インポート: ${total}件追加${repairSuffix}`)
        }
      }
      if (parsed.repairedIdCount > 0) {
        deps.log?.("import-repaired", { repaired: parsed.repairedIdCount })
      }
    } catch (error) {
      showStatus(`インポートに失敗しました: ${describeError(error)}`, "error")
    } finally {
      input.value = ""
    }
  }

  return { exportJson, importJson }
}
