import { LOCAL_IMPORT_FILE_MAX_BYTES, LOCAL_IMPORT_MAX_ITEMS, LOCAL_SCHEMA_VERSION } from "./limits"
import type { LocalV2State, SafeExportEnvelope } from "./local-model"
import { SafeExportEnvelopeSchema } from "./local-model"
import { OversizePayloadError } from "./share-errors"

export function buildSafeExport(state: LocalV2State): SafeExportEnvelope {
  return SafeExportEnvelopeSchema.parse({
    schemaVersion: LOCAL_SCHEMA_VERSION,
    playlists: state.playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      items: playlist.items.map((item) => ({
        id: item.id,
        partId: item.partId,
        title: item.title,
        episodeTitle: item.episodeTitle,
        episodeNumber: item.episodeNumber ?? "",
        ...(item.workId === undefined ? {} : { workId: item.workId }),
        range: item.range,
      })),
    })),
  })
}

export function checkLocalImportBudget(input: {
  readonly byteLength: number
  readonly itemCount: number
}): { readonly ok: true } {
  if (input.byteLength > LOCAL_IMPORT_FILE_MAX_BYTES)
    throw new OversizePayloadError(
      "local-import",
      input.byteLength,
      LOCAL_IMPORT_FILE_MAX_BYTES,
      "bytes",
    )
  if (input.itemCount > LOCAL_IMPORT_MAX_ITEMS)
    throw new OversizePayloadError("local-import", input.itemCount, LOCAL_IMPORT_MAX_ITEMS, "items")
  return { ok: true }
}
