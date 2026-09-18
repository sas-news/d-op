import type { D1Database } from "@cloudflare/workers-types"

// Worker environment guard (task 2). A missing D1 binding is a named configuration
// error; silent in-memory fallback is forbidden. Runtime-neutral: no Bun/Node APIs.

export const DOP_MISSING_D1_BINDING = "DOP_MISSING_D1_BINDING" as const

export class DOpConfigurationError extends Error {
  readonly code: string
  readonly binding: string

  constructor(code: string, binding: string, message: string) {
    super(message)
    this.name = "DOpConfigurationError"
    this.code = code
    this.binding = binding
  }
}

export type DOpEnv = {
  readonly DB?: D1Database | undefined
}

export function requireDb(env: DOpEnv): D1Database {
  const db: D1Database | undefined = env.DB
  if (db === undefined) {
    throw new DOpConfigurationError(
      DOP_MISSING_D1_BINDING,
      "DB",
      'D1 database binding "DB" is not configured for this Worker. Configure d1_databases in wrangler.jsonc; refusing silent in-memory fallback.',
    )
  }
  return db
}
