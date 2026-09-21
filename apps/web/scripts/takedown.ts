/// <reference types="node" />
import {
  operatorTakedownAuditStatement,
  operatorTakedownStatements,
  type TakedownInput,
} from "../src/server/repositories/takedown"
import {
  buildTakedownInput,
  CliUsageError,
  databaseIdFromConfig,
  parseTakedownArgs,
  resolveCredentials,
  type TakedownCredentials,
} from "./takedown-lib"

// Audited operator takedown CLI (task 14).
//
// Removes a published resource using the SAME ordered statement list the
// repository exposes for resource deletion (src/server/repositories/
// takedown.ts). There is deliberately no public admin endpoint, no account
// surface and no fake publisher identity: authority is the Cloudflare
// deployment credential supplied via environment or flags, used only for the
// D1 REST query API. The credential is never printed, logged or persisted.
//
// Statements run sequentially over the REST API (no multi-statement
// transaction exists there), so the repository orders them fail-safe: the
// row is blocked first and an interrupted run can never leave content
// publicly visible.
//
// Usage (from the repo, requires Bun):
//   DOP_D1_DATABASE_ID=<uuid> CLOUDFLARE_ACCOUNT_ID=<32hex> \
//   CLOUDFLARE_API_TOKEN=<token> \
//   bun run --cwd apps/web takedown --share-id <22-char id> \
//       --actor <operator-or-ticket> --reason "<justification>" --execute
//
// Without --execute the tool prints the exact statement plan (dry run) and
// performs no network call.

export type StatementResult = {
  readonly rowsWritten: number
  readonly rows: readonly unknown[]
}

export type StatementExecutor = (
  sql: string,
  params: readonly (string | number)[],
) => Promise<StatementResult>

/** Sequential executor over the D1 REST query API; the token never leaves the Authorization header. */
export function d1RestExecutor(
  credentials: TakedownCredentials,
  fetchImpl: typeof fetch = fetch,
): StatementExecutor {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${credentials.databaseId}/query`
  return async (sql, params) => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params: [...params] }),
    })
    const body: unknown = await response.json().catch(() => null)
    const payload =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
    if (!response.ok || payload["success"] !== true) {
      const errors = Array.isArray(payload["errors"]) ? payload["errors"] : []
      const detail = errors
        .map((entry: unknown) =>
          typeof entry === "object" && entry !== null
            ? String((entry as Record<string, unknown>)["message"] ?? "api error")
            : "api error",
        )
        .join("; ")
      throw new Error(`D1 query failed (HTTP ${response.status}): ${detail || "unknown error"}`)
    }
    const result = Array.isArray(payload["result"]) ? payload["result"] : []
    const first: unknown = result[0]
    const record =
      typeof first === "object" && first !== null ? (first as Record<string, unknown>) : {}
    const meta =
      typeof record["meta"] === "object" && record["meta"] !== null
        ? (record["meta"] as Record<string, unknown>)
        : {}
    const rowsWritten = typeof meta["rows_written"] === "number" ? meta["rows_written"] : 0
    const rows = Array.isArray(record["results"]) ? (record["results"] as unknown[]) : []
    return { rowsWritten, rows }
  }
}

export type TakedownAuditRecord = {
  readonly event: "operator_takedown"
  readonly operationKey: string
  readonly shareId: string
  readonly actor: string
  readonly reason: string
  readonly databaseId: string
  readonly removed: boolean
  readonly auditRecorded: boolean
  readonly at: string
  readonly statements: readonly { readonly index: number; readonly rowsWritten: number }[]
}

/**
 * Executes the repository's ordered statement list through `execute`, then
 * writes and verifies the audit row. Fails loudly: a partial run reports
 * exactly which statement failed (the resource is already blocked at that
 * point, so a partial run can never leave content visible).
 */
export async function runOperatorTakedown(
  execute: StatementExecutor,
  input: TakedownInput,
  databaseId: string,
): Promise<TakedownAuditRecord> {
  const statements = operatorTakedownStatements(input)
  const applied: { index: number; rowsWritten: number }[] = []
  for (const [index, statement] of statements.entries()) {
    try {
      const result = await execute(statement.sql, statement.params)
      applied.push({ index, rowsWritten: result.rowsWritten })
    } catch (cause) {
      throw new Error(
        `takedown statement ${index} failed after ${applied.length} applied: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }
  const removed = (applied[applied.length - 1]?.rowsWritten ?? 0) > 0
  const audit = operatorTakedownAuditStatement(input, removed)
  await execute(audit.sql, audit.params)
  const verify = await execute(
    "SELECT operation_key FROM operator_takedowns WHERE operation_key = ?1",
    [input.operationKey],
  )
  return {
    event: "operator_takedown",
    operationKey: input.operationKey,
    shareId: input.shareId,
    actor: input.actor,
    reason: input.reason,
    databaseId,
    removed,
    auditRecorded: verify.rows.length > 0,
    at: input.now.toISOString(),
    statements: applied,
  }
}

// --- entry point -------------------------------------------------------------

async function main(argv: readonly string[]): Promise<number> {
  const args = parseTakedownArgs(argv)
  if (args.help) {
    console.log(
      "usage: takedown --share-id <id> --actor <id> --reason <text> [--account-id --api-token --database-id] --execute",
    )
    return 0
  }
  const { fileURLToPath } = await import("node:url")
  const { readFile } = await import("node:fs/promises")
  const wranglerPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url))
  const configDatabaseId = databaseIdFromConfig(
    await readFile(wranglerPath, "utf8").catch(() => ""),
  )
  const input = buildTakedownInput(args, new Date())
  const credentials = resolveCredentials(args, configDatabaseId)
  if (!args.execute) {
    console.log(
      JSON.stringify({
        event: "operator_takedown_dry_run",
        shareId: input.shareId,
        operationKey: input.operationKey,
        databaseId: credentials.databaseId,
        statements: operatorTakedownStatements(input).map((s) => s.sql),
      }),
    )
    console.error("dry run only — pass --execute to apply")
    return 0
  }
  const record = await runOperatorTakedown(
    d1RestExecutor(credentials),
    input,
    credentials.databaseId,
  )
  console.log(JSON.stringify(record))
  if (!record.auditRecorded) {
    console.error("WARNING: audit row could not be verified in operator_takedowns")
    return 1
  }
  return 0
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      if (error instanceof CliUsageError) {
        console.error(`usage error: ${error.message}`)
        process.exit(2)
      }
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
