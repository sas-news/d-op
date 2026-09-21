export interface StorageDriver {
  get(keys: readonly string[]): Promise<Record<string, unknown>>
  set(values: Readonly<Record<string, unknown>>): Promise<void>
}

type BrowserStorageArea = {
  readonly get: (keys: readonly string[]) => Promise<Record<string, unknown>>
  readonly set: (values: Readonly<Record<string, unknown>>) => Promise<void>
}

export class StorageWriteError extends Error {
  override readonly name = "StorageWriteError"

  constructor(
    readonly category: "quota" | "storage",
    options?: ErrorOptions,
  ) {
    super(`local storage write failed: ${category}`, options)
  }
}

/** JSON-canonical form for browser storage: Chrome's storage.local drops
 *  `undefined` object properties on write while Firefox's backend serializes
 *  them to `null` (observed in the task-26 rehearsal: migrated items' absent
 *  workId/url re-read as `null`, which the optional() schema fields reject —
 *  breaking every subsequent state read on that engine). Canonicalizing at
 *  the driver boundary makes the stored bytes identical on both engines:
 *  absent means absent, never null. */
function canon<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createBrowserStorageDriver(area: BrowserStorageArea): StorageDriver {
  return {
    get: (keys) => area.get(keys),
    set: async (values) => {
      try {
        await area.set(canon(values))
      } catch (error) {
        const category =
          error instanceof Error && error.message.toLocaleLowerCase("en").includes("quota")
            ? "quota"
            : "storage"
        throw new StorageWriteError(category, { cause: error })
      }
    },
  }
}

export class InMemoryStorageDriver implements StorageDriver {
  readonly #values = new Map<string, unknown>()
  #nextSetError: StorageWriteError | undefined

  // structuredClone preserves `undefined` properties while real browser
  // storage drops or nulls them — canon keeps the test double faithful.
  constructor(initial: Readonly<Record<string, unknown>> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.#values.set(key, canon(value))
    }
  }

  async get(keys: readonly string[]): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      if (this.#values.has(key)) result[key] = canon(this.#values.get(key))
    }
    return result
  }

  async set(values: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.#nextSetError !== undefined) {
      const error = this.#nextSetError
      this.#nextSetError = undefined
      throw error
    }
    for (const [key, value] of Object.entries(canon(values))) {
      this.#values.set(key, value)
    }
  }

  failNextSet(error: StorageWriteError): void {
    this.#nextSetError = error
  }
}
