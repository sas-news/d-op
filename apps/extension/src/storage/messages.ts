import { assertNever } from "../../../../packages/shared/src/limits"
import {
  type StorageRequest,
  StorageRequestSchema,
} from "../../../../packages/shared/src/local-model"
import { authorizeStorageRequest, type StorageMessageSender } from "./authorization"
import type { StorageDriver } from "./driver"
import type { LocalRepository } from "./repository"
import { readTransientState, writeTransientState } from "./transient"

type MessageHandlerOptions = {
  readonly repository: LocalRepository
  readonly driver: StorageDriver
  readonly extensionId: string
}

function requiredAccess(request: StorageRequest): "public" | "vault" {
  switch (request.type) {
    case "DOP_STORAGE_READ_VAULT":
      return "vault"
    case "DOP_STORAGE_COMMAND":
      switch (request.command.kind) {
        case "put-publication":
        case "discard-publication-management":
        case "put-pending-create":
        case "remove-pending-create":
        case "set-share-consent":
          return "vault"
        case "create-playlist":
        case "rename-playlist":
        case "delete-playlist":
        case "add-item":
        case "remove-item":
        case "replace-library":
        case "set-preferences":
          return "public"
        default:
          return assertNever(request.command)
      }
    case "DOP_STORAGE_READ_PUBLIC":
    case "DOP_STORAGE_READ_TRANSIENT":
    case "DOP_STORAGE_WRITE_TRANSIENT":
      return "public"
    default:
      return assertNever(request)
  }
}

export async function handleStorageMessage(
  input: unknown,
  sender: StorageMessageSender,
  options: MessageHandlerOptions,
): Promise<unknown> {
  const parsed = StorageRequestSchema.safeParse(input)
  if (!parsed.success) return undefined
  const authorization = authorizeStorageRequest(
    sender,
    requiredAccess(parsed.data),
    options.extensionId,
  )
  if (authorization.kind === "denied") {
    return { kind: "forbidden", reason: authorization.reason }
  }
  switch (parsed.data.type) {
    case "DOP_STORAGE_READ_PUBLIC":
      return options.repository.readPublic()
    case "DOP_STORAGE_READ_VAULT":
      return options.repository.readVault()
    case "DOP_STORAGE_COMMAND":
      return options.repository.dispatch(parsed.data.command)
    case "DOP_STORAGE_READ_TRANSIENT":
      return readTransientState(options.driver)
    case "DOP_STORAGE_WRITE_TRANSIENT":
      await writeTransientState(options.driver, parsed.data.state)
      return { kind: "transient-committed", generation: parsed.data.state.generation }
    default:
      return assertNever(parsed.data)
  }
}
