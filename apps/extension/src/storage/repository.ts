import { LOCAL_STATE_KEY, MAX_OPERATION_RECEIPTS } from "../../../../packages/shared/src/limits"
import {
  type LocalCommand,
  LocalCommandSchema,
  type LocalV2State,
  type MigrationRecovery,
  type PendingCreate,
  type PublicationRecord,
} from "../../../../packages/shared/src/local-model"
import type { StorageDriver } from "./driver"
import { loadOrMigrateState } from "./migration"
import { applyStorageMutation } from "./mutations"

export type CommandReply =
  | { readonly kind: "committed"; readonly operationId: string; readonly revision: number }
  | {
      readonly kind: "revision-conflict"
      readonly actualRevision: number
      readonly expectedRevision: number
    }
  | { readonly kind: "operation-conflict"; readonly operationId: string }
  | { readonly kind: "invalid-command"; readonly paths: readonly string[] }
  | { readonly kind: "mutation-rejected"; readonly reason: string }

export type PublicLocalState = Pick<
  LocalV2State,
  "schemaVersion" | "revision" | "playlists" | "preferences"
>
export type PublicationVault = {
  readonly revision: number
  readonly publications: readonly PublicationRecord[]
  readonly pendingCreates: readonly PendingCreate[]
  readonly migrationRecovery?: MigrationRecovery
}

export type LocalRepository = {
  readonly initialize: () => Promise<PublicLocalState>
  readonly dispatch: (input: unknown) => Promise<CommandReply>
  readonly readPublic: () => Promise<PublicLocalState>
  readonly readVault: () => Promise<PublicationVault>
}

type RepositoryOptions = {
  readonly driver: StorageDriver
  readonly now: () => string
  readonly newId: () => string
}

function publicState(state: LocalV2State): PublicLocalState {
  return {
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    playlists: state.playlists,
    preferences: state.preferences,
  }
}

function vaultState(state: LocalV2State): PublicationVault {
  const core = {
    revision: state.revision,
    publications: state.publications,
    pendingCreates: state.pendingCreates,
  }
  return state.migrationRecovery === undefined
    ? core
    : { ...core, migrationRecovery: state.migrationRecovery }
}

async function requestHash(command: LocalCommand): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(command))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function createLocalRepository(options: RepositoryOptions): LocalRepository {
  let state: LocalV2State | undefined
  let tail = Promise.resolve()

  const initialized = async (): Promise<LocalV2State> => {
    state ??= await loadOrMigrateState(options.driver, options.now)
    return state
  }
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const running = tail.then(operation, operation)
    tail = running.then(
      () => undefined,
      () => undefined,
    )
    return running
  }
  const dispatch = (input: unknown): Promise<CommandReply> =>
    enqueue(async () => {
      const parsed = LocalCommandSchema.safeParse(input)
      if (!parsed.success) {
        return {
          kind: "invalid-command",
          paths: parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
        }
      }
      const current = await initialized()
      const hash = await requestHash(parsed.data)
      const prior = current.appliedOperations.find(
        (receipt) => receipt.operationId === parsed.data.operationId,
      )
      if (prior !== undefined) {
        return prior.requestHash === hash
          ? prior.result
          : { kind: "operation-conflict", operationId: parsed.data.operationId }
      }
      if (current.revision !== parsed.data.expectedRevision) {
        return {
          kind: "revision-conflict",
          actualRevision: current.revision,
          expectedRevision: parsed.data.expectedRevision,
        }
      }
      const mutation = applyStorageMutation(current, parsed.data, options.newId)
      if (mutation.kind === "rejected") {
        return { kind: "mutation-rejected", reason: mutation.reason }
      }
      const revision = current.revision + 1
      const result = { kind: "committed", operationId: parsed.data.operationId, revision } as const
      const receipt = {
        operationId: parsed.data.operationId,
        expectedRevision: parsed.data.expectedRevision,
        resultingRevision: revision,
        kind: parsed.data.kind,
        requestHash: hash,
        result,
        createdAt: options.now(),
      }
      const candidate: LocalV2State = {
        ...current,
        ...mutation.collections,
        revision,
        appliedOperations: [...current.appliedOperations, receipt].slice(-MAX_OPERATION_RECEIPTS),
      }
      await options.driver.set({ [LOCAL_STATE_KEY]: candidate })
      state = candidate
      return result
    })

  return {
    initialize: async () => publicState(await initialized()),
    dispatch,
    readPublic: async () => publicState(await initialized()),
    readVault: async () => vaultState(await initialized()),
  }
}
