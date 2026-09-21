import { TRANSIENT_STATE_KEY } from "../../../../packages/shared/src/limits"
import {
  type TransientState,
  TransientStateSchema,
} from "../../../../packages/shared/src/local-model"
import type { StorageDriver } from "./driver"

export class MalformedTransientStateError extends Error {
  override readonly name = "MalformedTransientStateError"

  constructor(readonly paths: readonly string[]) {
    super("stored transient state is malformed")
  }
}

export function emptyTransientState(): TransientState {
  return { schemaVersion: 1, generation: 0 }
}

export async function readTransientState(driver: StorageDriver): Promise<TransientState> {
  const stored = await driver.get([TRANSIENT_STATE_KEY])
  const raw = stored[TRANSIENT_STATE_KEY]
  if (raw === undefined) return emptyTransientState()
  const parsed = TransientStateSchema.safeParse(raw)
  if (!parsed.success) {
    throw new MalformedTransientStateError(
      parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
    )
  }
  return parsed.data
}

export async function writeTransientState(
  driver: StorageDriver,
  state: TransientState,
): Promise<void> {
  await driver.set({ [TRANSIENT_STATE_KEY]: TransientStateSchema.parse(state) })
}
