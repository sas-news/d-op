/// <reference types="node" />
import { ShareIdSchema } from "../../../packages/shared/src/index"
import {
  TAKEDOWN_ACTOR_MAX,
  TAKEDOWN_REASON_MAX,
  type TakedownInput,
} from "../src/server/repositories/takedown"

// Argument parsing and deployment-credential resolution for the takedown CLI
// (task 14). Credentials come from CLI flags or process env only — never from
// committed files — and are never printed, logged or persisted. The module is
// importable inside workerd tests: Node builtins are reached only through
// dynamic imports inside functions.

export class CliUsageError extends Error {
  override readonly name = "CliUsageError"
}

export type CliArgs = {
  readonly shareId?: string
  readonly actor?: string
  readonly reason?: string
  readonly accountId?: string
  readonly apiToken?: string
  readonly databaseId?: string
  readonly execute: boolean
  readonly help: boolean
}

export function parseTakedownArgs(argv: readonly string[]): CliArgs {
  const out: Record<string, string | boolean | undefined> = { execute: false, help: false }
  const flags: Record<string, string> = {
    "--share-id": "shareId",
    "--actor": "actor",
    "--reason": "reason",
    "--account-id": "accountId",
    "--api-token": "apiToken",
    "--database-id": "databaseId",
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--execute") {
      out["execute"] = true
      continue
    }
    if (arg === "--help" || arg === "-h") {
      out["help"] = true
      continue
    }
    const field = arg === undefined ? undefined : flags[arg]
    if (field === undefined) {
      throw new CliUsageError(`unknown argument: ${arg ?? ""}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`missing value for ${arg}`)
    }
    out[field] = value
    index += 1
  }
  return out as CliArgs
}

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i
const DATABASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000"

/** Extracts the first `"database_id"` value from wrangler config text (regex, so jsonc comments are harmless). */
export function databaseIdFromConfig(rawConfig: string): string | null {
  const match = /"database_id"\s*:\s*"([0-9a-fA-F-]{36})"/.exec(rawConfig)
  return match?.[1] ?? null
}

export type TakedownCredentials = {
  readonly accountId: string
  readonly apiToken: string
  readonly databaseId: string
}

/**
 * Resolves the deployment credential from flags, then env, then
 * `configDatabaseId` (the wrangler.jsonc database id, supplied by the caller —
 * file IO stays in the entry point). Errors name the missing piece and never
 * echo credential material.
 */
export function resolveCredentials(
  args: CliArgs,
  configDatabaseId: string | null,
): TakedownCredentials {
  const accountId = args.accountId ?? process.env["CLOUDFLARE_ACCOUNT_ID"] ?? ""
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new CliUsageError(
      "a 32-hex Cloudflare account id is required (--account-id or CLOUDFLARE_ACCOUNT_ID)",
    )
  }
  const apiToken = args.apiToken ?? process.env["CLOUDFLARE_API_TOKEN"] ?? ""
  if (apiToken.trim() === "") {
    throw new CliUsageError(
      "a D1-capable Cloudflare API token is required (--api-token or CLOUDFLARE_API_TOKEN)",
    )
  }
  const databaseId = args.databaseId ?? process.env["DOP_D1_DATABASE_ID"] ?? configDatabaseId ?? ""
  if (!DATABASE_ID_PATTERN.test(databaseId) || databaseId === PLACEHOLDER_DATABASE_ID) {
    throw new CliUsageError(
      "a real D1 database id is required (--database-id, DOP_D1_DATABASE_ID, or a provisioned wrangler.jsonc entry)",
    )
  }
  return { accountId, apiToken, databaseId }
}

export function buildTakedownInput(args: CliArgs, now: Date): TakedownInput {
  const shareId = ShareIdSchema.safeParse(args.shareId)
  if (!shareId.success) {
    throw new CliUsageError("--share-id must be a 22-character share id")
  }
  const actor = (args.actor ?? "").trim()
  if (actor === "" || actor.length > TAKEDOWN_ACTOR_MAX) {
    throw new CliUsageError(
      `--actor is required (1..${TAKEDOWN_ACTOR_MAX} chars; a ticket or alias, never a credential)`,
    )
  }
  const reason = (args.reason ?? "").trim()
  if (reason === "" || reason.length > TAKEDOWN_REASON_MAX) {
    throw new CliUsageError(`--reason is required (1..${TAKEDOWN_REASON_MAX} chars)`)
  }
  return { shareId: shareId.data, operationKey: crypto.randomUUID(), actor, reason, now }
}
