// Content-side storage client — every persistent read/mutation goes through
// the background single writer via the typed DOP_STORAGE_* envelopes
// (packages/shared/src/local-model.ts). Content code never touches
// chrome.storage.local directly and never writes dop_v2_state or legacy keys.
import { issuePaths, LOCAL_STATE_KEY } from "../../../../packages/shared/src/limits"
import {
  LocalV2StateSchema,
  type StorageRequest,
  type TransientState,
  TransientStateSchema,
} from "../../../../packages/shared/src/local-model"
import { PlayerError } from "./errors"
import type { PlayerStorage } from "./runtime"

// The public reply is the schemaVersion/revision/playlists/preferences
// projection of LocalV2StateSchema (src/storage/repository.ts publicState).
const PublicReplySchema = LocalV2StateSchema.pick({
  schemaVersion: true,
  revision: true,
  playlists: true,
  preferences: true,
})
export type PublicReply = ReturnType<typeof PublicReplySchema.parse>

type SendMessage = (message: StorageRequest) => Promise<unknown>

function malformed(error: Parameters<typeof issuePaths>[0]): PlayerError {
  return new PlayerError(
    "malformed-storage-reply",
    `storage reply rejected at ${issuePaths(error).join(",")}`,
  )
}

export function createPlayerStorageClient(sendMessage: SendMessage): PlayerStorage {
  return {
    readPublic: async () => {
      const reply = await sendMessage({ type: "DOP_STORAGE_READ_PUBLIC" })
      const parsed = PublicReplySchema.safeParse(reply)
      if (!parsed.success) throw malformed(parsed.error)
      return parsed.data
    },
    readTransient: async () => {
      const reply = await sendMessage({ type: "DOP_STORAGE_READ_TRANSIENT" })
      const parsed = TransientStateSchema.safeParse(reply)
      if (!parsed.success) throw malformed(parsed.error)
      return parsed.data
    },
    writeTransient: async (state: TransientState) =>
      sendMessage({ type: "DOP_STORAGE_WRITE_TRANSIENT", state }),
  }
}

// --- Public-state subscription ------------------------------------------------
// Public state is observed through chrome.storage.onChanged on the canonical
// envelope (single-writer broadcast, plan Local data step 2). The listener
// surface is injected so tests do not need a chrome mock.

export type StorageChangeSurface = {
  readonly addListener: (
    listener: (changes: Record<string, { readonly newValue?: unknown }>, area: string) => void,
  ) => void
  readonly removeListener: (
    listener: (changes: Record<string, { readonly newValue?: unknown }>, area: string) => void,
  ) => void
}

const LOCAL_AREA = "local"

/** Subscribe to canonical public-state writes; returns an unsubscribe. */
export function subscribePublicState(
  surface: StorageChangeSurface,
  onChange: (state: PublicReply) => void,
): () => void {
  const listener = (
    changes: Record<string, { readonly newValue?: unknown }>,
    area: string,
  ): void => {
    if (area !== LOCAL_AREA) return
    const change = changes[LOCAL_STATE_KEY]
    if (change === undefined) return
    const parsed = PublicReplySchema.safeParse(change.newValue)
    if (parsed.success) onChange(parsed.data)
  }
  surface.addListener(listener)
  return () => surface.removeListener(listener)
}
