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

export function createBrowserStorageDriver(area: BrowserStorageArea): StorageDriver {
  return {
    get: (keys) => area.get(keys),
    set: async (values) => {
      try {
        await area.set(values)
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

  constructor(initial: Readonly<Record<string, unknown>> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.#values.set(key, structuredClone(value))
    }
  }

  async get(keys: readonly string[]): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      if (this.#values.has(key)) result[key] = structuredClone(this.#values.get(key))
    }
    return result
  }

  async set(values: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.#nextSetError !== undefined) {
      const error = this.#nextSetError
      this.#nextSetError = undefined
      throw error
    }
    for (const [key, value] of Object.entries(values)) {
      this.#values.set(key, structuredClone(value))
    }
  }

  failNextSet(error: StorageWriteError): void {
    this.#nextSetError = error
  }
}
