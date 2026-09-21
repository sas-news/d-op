// UI-side storage client for popup/options/store surfaces — every persistent
// read/mutation goes through the background single writer via the typed
// DOP_STORAGE_* envelopes (packages/shared/src/local-model.ts). Extension UI
// never touches chrome.storage.local directly and never sees vault/
// publication fields (publicState projection only).
//
// Command dispatch is revision-checked: `runCommand` reads the current
// revision, dispatches, and on `revision-conflict` re-reads and retries with
// the SAME operationId (a committed-but-lost reply replays the stored receipt
// instead of double-applying — the read-modify-write loop in
// src/storage/repository.ts). Bounded retries, then the last reply surfaces.
import {
  issuePaths,
  LOCAL_STATE_KEY,
  TRANSIENT_STATE_KEY,
} from "../../../../packages/shared/src/limits"
import {
  type LocalCommand,
  LocalV2StateSchema,
  type StorageRequest,
  type TransientState,
  TransientStateSchema,
} from "../../../../packages/shared/src/local-model"
import type { CommandReply } from "../storage/repository"

// Same projection as src/player/storage-client.ts (kept separate so UI code
// never depends on player internals).
const PublicReplySchema = LocalV2StateSchema.pick({
  schemaVersion: true,
  revision: true,
  playlists: true,
  preferences: true,
})
export type PublicReply = ReturnType<typeof PublicReplySchema.parse>

// Vault read for privileged Extension UI (options management list). The reply
// carries publication records including manageSecret — callers may render only
// the non-secret fields and must never export/forward them (task-11 boundary;
// background authorization already rejects non-extension senders).
const VaultReplySchema = LocalV2StateSchema.pick({
  revision: true,
  publications: true,
  pendingCreates: true,
  migrationRecovery: true,
})
export type VaultReply = ReturnType<typeof VaultReplySchema.parse>

type SendMessage = (message: StorageRequest) => Promise<unknown>

export class UiStorageError extends Error {
  override readonly name = "UiStorageError"
  constructor(
    readonly code: "malformed-storage-reply" | "dispatch-rejected",
    message: string,
  ) {
    super(message)
  }
}

function malformed(paths: readonly string[]): UiStorageError {
  return new UiStorageError(
    "malformed-storage-reply",
    `storage reply rejected at ${paths.join(",")}`,
  )
}

/** Structural check for the repository's CommandReply union (internal reply
 *  shape — not a shared contract, so validated by hand, not zod). */
function parseCommandReply(reply: unknown): CommandReply {
  if (typeof reply !== "object" || reply === null) throw malformed(["<root>"])
  const record = reply as Record<string, unknown>
  switch (record["kind"]) {
    case "committed":
      if (typeof record["operationId"] === "string" && typeof record["revision"] === "number")
        return {
          kind: "committed",
          operationId: record["operationId"],
          revision: record["revision"],
        }
      break
    case "revision-conflict":
      if (
        typeof record["actualRevision"] === "number" &&
        typeof record["expectedRevision"] === "number"
      )
        return {
          kind: "revision-conflict",
          actualRevision: record["actualRevision"],
          expectedRevision: record["expectedRevision"],
        }
      break
    case "operation-conflict":
      if (typeof record["operationId"] === "string")
        return { kind: "operation-conflict", operationId: record["operationId"] }
      break
    case "invalid-command":
      if (Array.isArray(record["paths"]))
        return { kind: "invalid-command", paths: record["paths"] as string[] }
      break
    case "mutation-rejected":
      if (typeof record["reason"] === "string")
        return { kind: "mutation-rejected", reason: record["reason"] }
      break
    default:
      break
  }
  throw malformed(["kind"])
}

export type UiStorageClient = {
  readonly readPublic: () => Promise<PublicReply>
  readonly readVault: () => Promise<VaultReply>
  readonly readTransient: () => Promise<TransientState>
  readonly writeTransient: (state: TransientState) => Promise<unknown>
  readonly dispatch: (command: LocalCommand) => Promise<CommandReply>
}

export function createUiStorageClient(sendMessage: SendMessage): UiStorageClient {
  return {
    readPublic: async () => {
      const reply = await sendMessage({ type: "DOP_STORAGE_READ_PUBLIC" })
      const parsed = PublicReplySchema.safeParse(reply)
      if (!parsed.success) throw malformed(issuePaths(parsed.error))
      return parsed.data
    },
    readVault: async () => {
      const reply = await sendMessage({ type: "DOP_STORAGE_READ_VAULT" })
      const parsed = VaultReplySchema.safeParse(reply)
      if (!parsed.success) throw malformed(issuePaths(parsed.error))
      return parsed.data
    },
    readTransient: async () => {
      const reply = await sendMessage({ type: "DOP_STORAGE_READ_TRANSIENT" })
      const parsed = TransientStateSchema.safeParse(reply)
      if (!parsed.success) throw malformed(issuePaths(parsed.error))
      return parsed.data
    },
    writeTransient: async (state: TransientState) =>
      sendMessage({ type: "DOP_STORAGE_WRITE_TRANSIENT", state }),
    dispatch: async (command: LocalCommand) => {
      const reply = await sendMessage({ type: "DOP_STORAGE_COMMAND", command })
      return parseCommandReply(reply)
    },
  }
}

/** Max re-read + re-dispatch rounds after a revision conflict. */
const MUTATION_MAX_ATTEMPTS = 4

/** Omit must distribute over the LocalCommand union — a plain Omit collapses
 *  discriminated unions to their common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type CommandBody = DistributiveOmit<LocalCommand, "operationId" | "expectedRevision">

/**
 * Read-modify-write a canonical mutation: `build` maps the freshly-read public
 * state to the command body; `operationId` is minted once so a retry after a
 * lost ack replays the stored receipt rather than double-applying. Returns the
 * final CommandReply; callers check `.kind === "committed"`.
 */
export async function runMutation(
  client: Pick<UiStorageClient, "readPublic" | "dispatch">,
  build: (
    state: PublicReply,
    stamp: { readonly operationId: string; readonly expectedRevision: number },
  ) => CommandBody | null,
  newOperationId: () => string,
): Promise<CommandReply> {
  const operationId = newOperationId()
  let last: CommandReply = { kind: "revision-conflict", actualRevision: -1, expectedRevision: -1 }
  for (let attempt = 0; attempt < MUTATION_MAX_ATTEMPTS; attempt += 1) {
    const state = await client.readPublic()
    const body = build(state, { operationId, expectedRevision: state.revision })
    if (body === null) return { kind: "mutation-rejected", reason: "no-change" }
    const reply = await client.dispatch({
      ...body,
      operationId,
      expectedRevision: state.revision,
    } as LocalCommand)
    if (reply.kind !== "revision-conflict") return reply
    last = reply
  }
  return last
}

// --- Storage-change subscriptions ------------------------------------------
// Canonical/transient writes are observed through chrome.storage.onChanged
// (single-writer broadcast). The listener surface is injected for tests.

export type StorageChangeSurface = {
  readonly addListener: (
    listener: (changes: Record<string, { readonly newValue?: unknown }>, area: string) => void,
  ) => void
  readonly removeListener: (
    listener: (changes: Record<string, { readonly newValue?: unknown }>, area: string) => void,
  ) => void
}

const LOCAL_AREA = "local"

function subscribeKey(
  surface: StorageChangeSurface,
  key: string,
  onChange: (newValue: unknown) => void,
): () => void {
  const listener = (
    changes: Record<string, { readonly newValue?: unknown }>,
    area: string,
  ): void => {
    if (area !== LOCAL_AREA) return
    const change = changes[key]
    if (change === undefined) return
    onChange(change.newValue)
  }
  surface.addListener(listener)
  return () => surface.removeListener(listener)
}

/** Subscribe to canonical public-state writes; returns an unsubscribe. */
export function subscribePublicState(
  surface: StorageChangeSurface,
  onChange: (state: PublicReply) => void,
): () => void {
  return subscribeKey(surface, LOCAL_STATE_KEY, (value) => {
    const parsed = PublicReplySchema.safeParse(value)
    if (parsed.success) onChange(parsed.data)
  })
}

/** Subscribe to transient playback/window writes (popup now-playing view). */
export function subscribeTransientState(
  surface: StorageChangeSurface,
  onChange: (state: TransientState) => void,
): () => void {
  return subscribeKey(surface, TRANSIENT_STATE_KEY, (value) => {
    const parsed = TransientStateSchema.safeParse(value)
    if (parsed.success) onChange(parsed.data)
  })
}
