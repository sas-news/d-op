import type { APIRoute } from "astro"
import { beforeAll, describe, expect, it } from "vitest"
import {
  d1RestExecutor,
  runOperatorTakedown,
  type StatementResult,
} from "../../scripts/takedown.js"
import {
  buildTakedownInput,
  CliUsageError,
  databaseIdFromConfig,
  parseTakedownArgs,
  resolveCredentials,
} from "../../scripts/takedown-lib.js"
import { GET as getRoute } from "../../src/pages/api/v1/playlists/[shareId].js"
import { getSnapshot } from "../../src/server/repositories/snapshots/read.js"
import {
  operatorTakedown,
  operatorTakedownAuditStatement,
  operatorTakedownStatements,
} from "../../src/server/repositories/takedown.js"
import { publishPlaylist } from "../publication-api/helpers.js"
import { call, db, makePlaylist, migratedDb, secureRequest } from "./helpers.js"

// Given: the audited operator takedown — a deployment-credential CLI that
// executes the repository's ordered statement list (block -> purge -> parent
// delete -> audit). No public endpoint exists.
// Then: real D1 proves removal + audit durability, and the CLI's parsing,
// credential resolution, sequential execution and failure reporting are
// covered against fakes.

const SHARE_ID = "abcdefghijklmnopqrstuv"

function inputFor(shareId: string) {
  return buildTakedownInput(
    parseTakedownArgs([
      "--share-id",
      shareId,
      "--actor",
      "ticket-1234",
      "--reason",
      "test takedown",
    ]),
    new Date("2026-09-19T12:00:00Z"),
  )
}

describe("operator takedown repository", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("orders statements fail-safe: block first, parent delete last", () => {
    const statements = operatorTakedownStatements(inputFor(SHARE_ID))
    expect(statements[0]?.sql).toContain("UPDATE playlists SET blocked = 1")
    expect(statements[statements.length - 1]?.sql).toBe("DELETE FROM playlists WHERE share_id = ?1")
    const audit = operatorTakedownAuditStatement(inputFor(SHARE_ID), true)
    expect(audit.sql).toContain("INSERT INTO operator_takedowns")
  })

  it("removes an active publication and records the audit row", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const outcome = await operatorTakedown(db(), inputFor(published.shareId))
    expect(outcome.removed).toBe(true)
    expect(outcome.auditRecorded).toBe(true)

    // Row and associations are gone; public GET is a non-revealing 404.
    expect(await getSnapshot(db(), published.shareId)).toBeNull()
    const response = await call(
      getRoute as APIRoute,
      secureRequest({ method: "GET", path: `/${published.shareId}` }),
      { shareId: published.shareId },
    )
    expect(response.status).toBe(404)

    const audit = await db()
      .prepare(
        "SELECT share_id, actor, reason, removed FROM operator_takedowns WHERE operation_key = ?1",
      )
      .bind(outcome.operationKey)
      .first<{ share_id: string; actor: string; reason: string; removed: number }>()
    expect(audit?.share_id).toBe(published.shareId)
    expect(audit?.actor).toBe("ticket-1234")
    expect(audit?.removed).toBe(1)

    // Owner-side receipts for the removed resource are purged too.
    const receipts = await db()
      .prepare("SELECT COUNT(*) AS n FROM publication_operations WHERE share_id = ?1")
      .bind(published.shareId)
      .first<{ n: number }>()
    expect(receipts?.n).toBe(0)
  })

  it("reports removed=false for an unknown shareId but still audits", async () => {
    const outcome = await operatorTakedown(db(), inputFor(SHARE_ID))
    expect(outcome.removed).toBe(false)
    expect(outcome.auditRecorded).toBe(true)
  })
})

describe("takedown CLI argument and credential handling", () => {
  it("parses flags and rejects unknown arguments", () => {
    const args = parseTakedownArgs([
      "--share-id",
      SHARE_ID,
      "--actor",
      "ops",
      "--reason",
      "court order",
      "--execute",
    ])
    expect(args.shareId).toBe(SHARE_ID)
    expect(args.execute).toBe(true)
    expect(() => parseTakedownArgs(["--bogus"])).toThrow(CliUsageError)
    expect(() => parseTakedownArgs(["--share-id"])).toThrow(CliUsageError)
  })

  it("validates the target and rejects malformed ids/actors", () => {
    expect(() =>
      buildTakedownInput(
        parseTakedownArgs(["--share-id", "short", "--actor", "a", "--reason", "r"]),
        new Date(),
      ),
    ).toThrow(CliUsageError)
    expect(() =>
      buildTakedownInput(parseTakedownArgs(["--share-id", SHARE_ID, "--reason", "r"]), new Date()),
    ).toThrow(CliUsageError)
  })

  it("requires deployment credentials and never accepts the placeholder db id", () => {
    const good = {
      shareId: SHARE_ID,
      actor: "a",
      reason: "r",
      execute: true,
      help: false,
      accountId: "a".repeat(32),
      apiToken: "token",
      databaseId: "11111111-2222-3333-4444-555555555555",
    }
    const resolved = resolveCredentials(good, null)
    expect(resolved.databaseId).toBe("11111111-2222-3333-4444-555555555555")
    expect(() => resolveCredentials({ ...good, accountId: "nothex" }, null)).toThrow(CliUsageError)
    expect(() => resolveCredentials({ ...good, apiToken: " " }, null)).toThrow(CliUsageError)
    expect(() =>
      resolveCredentials({ ...good, databaseId: "00000000-0000-0000-0000-000000000000" }, null),
    ).toThrow(CliUsageError)
    // Config fallback is used only when flag and env are absent.
    const fallback = resolveCredentials(
      {
        shareId: SHARE_ID,
        actor: "a",
        reason: "r",
        execute: true,
        help: false,
        accountId: "a".repeat(32),
        apiToken: "token",
      },
      "99999999-8888-7777-6666-555555555555",
    )
    expect(fallback.databaseId).toBe("99999999-8888-7777-6666-555555555555")
  })

  it("extracts the database id from wrangler config text", () => {
    const withComments = `{
      // comment line
      "d1_databases": [{ "database_id": "00000000-0000-0000-0000-000000000000" }]
    }`
    expect(databaseIdFromConfig(withComments)).toBe("00000000-0000-0000-0000-000000000000")
    expect(databaseIdFromConfig("{ }")).toBeNull()
  })
})

describe("runOperatorTakedown executor orchestration", () => {
  it("runs the repository statements in order and verifies the audit row", async () => {
    const executed: { sql: string; params: readonly unknown[] }[] = []
    const input = inputFor(SHARE_ID)
    const execute = async (
      sql: string,
      params: readonly (string | number)[],
    ): Promise<StatementResult> => {
      executed.push({ sql, params })
      if (sql.startsWith("SELECT operation_key")) {
        return { rowsWritten: 0, rows: [{ operation_key: input.operationKey }] }
      }
      if (sql === "DELETE FROM playlists WHERE share_id = ?1") {
        return { rowsWritten: 1, rows: [] }
      }
      return { rowsWritten: 0, rows: [] }
    }
    const record = await runOperatorTakedown(execute, input, "db-id")
    // 7 purge statements + audit insert + verify select.
    expect(executed).toHaveLength(9)
    expect(executed[0]?.sql).toContain("blocked = 1")
    expect(executed[6]?.sql).toBe("DELETE FROM playlists WHERE share_id = ?1")
    expect(executed[7]?.sql).toContain("INSERT INTO operator_takedowns")
    expect(record.removed).toBe(true)
    expect(record.auditRecorded).toBe(true)
    expect(record.event).toBe("operator_takedown")
    expect(record.shareId).toBe(SHARE_ID)
    expect(record.databaseId).toBe("db-id")
    expect(record.statements).toHaveLength(7)
  })

  it("fails loudly with the failing statement index on partial execution", async () => {
    const input = inputFor(SHARE_ID)
    const execute = async (
      sql: string,
      _params: readonly (string | number)[],
    ): Promise<StatementResult> => {
      if (sql.startsWith("DELETE FROM import_daily")) {
        throw new Error("d1 unavailable")
      }
      return { rowsWritten: 0, rows: [] }
    }
    await expect(runOperatorTakedown(execute, input, "db-id")).rejects.toThrow("statement 2")
  })

  it("d1RestExecutor sends sql+params with the token in the header only", async () => {
    const seen: { url: string; auth: string | null; body: string }[] = []
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        body: String(init?.body),
      })
      return new Response(
        JSON.stringify({ success: true, result: [{ meta: { rows_written: 3 }, results: [] }] }),
        { status: 200 },
      )
    }
    const execute = d1RestExecutor(
      { accountId: "a".repeat(32), apiToken: "secret-token", databaseId: "db" },
      fetchImpl as typeof fetch,
    )
    const result = await execute("DELETE FROM playlists WHERE share_id = ?1", ["abc"])
    expect(result.rowsWritten).toBe(3)
    expect(seen[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/d1/database/db/query`,
    )
    expect(seen[0]?.auth).toBe("Bearer secret-token")
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
      sql: "DELETE FROM playlists WHERE share_id = ?1",
      params: ["abc"],
    })
    // The token never enters the SQL or the URL.
    expect(seen[0]?.url).not.toContain("secret-token")
  })

  it("d1RestExecutor surfaces API errors without credential material", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ success: false, errors: [{ message: "invalid database id" }] }),
        { status: 400 },
      )
    const execute = d1RestExecutor(
      { accountId: "a".repeat(32), apiToken: "secret-token", databaseId: "db" },
      fetchImpl as typeof fetch,
    )
    await expect(execute("SELECT 1", [])).rejects.toThrow("invalid database id")
  })
})
