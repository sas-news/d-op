#!/usr/bin/env node
// verify:staging — task 28 remote/local staging proof for the d-OP Share API.
//
// Exercises the FULL v1 contract against a provisioned staging origin with
// disposable synthetic resources and deletes everything it creates:
//
//   create (public) -> pending-hidden -> activate -> read -> CAS replace ->
//   stale-CAS conflict -> import notify -> create+activate+read (unlisted) ->
//   discover visibility -> delete -> verify gone (both profiles)
//
// Every response body is audited: the plaintext manageSecret may appear in
// exactly ONE place — its own POST 201 create acknowledgement — and in no
// other response ever. The script itself never prints secrets.
//
// Usage:
//   node scripts/verify-staging.mjs --base-url "$DOP_STAGING_ORIGIN"
//   node scripts/verify-staging.mjs --base-url http://127.0.0.1:8787 --allow-local
//
// Exit 0 = every step passed and all resources cleaned. Exit 1 = a step
// failed (the specific failure is printed); cleanup is still attempted so a
// failed run never leaks disposable rows.

const PRODUCTION_ORIGIN = "d-op.sasnews.dev"
const DEFAULT_TIMEOUT_MS = 15_000

function usage(message) {
  console.error(`verify-staging: ${message}`)
  console.error(
    "usage: node scripts/verify-staging.mjs --base-url <origin> [--allow-local] [--timeout <ms>]",
  )
  process.exit(2)
}

// --- args -----------------------------------------------------------------

const args = process.argv.slice(2)
let baseUrl
let allowLocal = false
let timeoutMs = DEFAULT_TIMEOUT_MS
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === "--base-url") {
    baseUrl = args[++i]
  } else if (arg?.startsWith("--base-url=")) {
    baseUrl = arg.slice("--base-url=".length)
  } else if (arg === "--allow-local") {
    allowLocal = true
  } else if (arg === "--timeout") {
    timeoutMs = Number(args[++i])
  } else if (arg?.startsWith("--timeout=")) {
    timeoutMs = Number(arg.slice("--timeout=".length))
  } else {
    usage(`unknown argument: ${arg}`)
  }
}
baseUrl ??= process.env.DOP_STAGING_ORIGIN
if (baseUrl === undefined || baseUrl === "") {
  usage("missing --base-url (or DOP_STAGING_ORIGIN env)")
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  usage(`invalid --timeout: ${timeoutMs}`)
}

const origin = URL.parse(baseUrl)
if (origin === null || (origin.protocol !== "https:" && origin.protocol !== "http:")) {
  usage(`--base-url must be an http(s) origin, got: ${baseUrl}`)
}
const host = origin.hostname.toLowerCase()
const isLoopback =
  host === "localhost" ||
  host === "127.0.0.1" ||
  host === "::1" ||
  host === "[::1]" ||
  host === "0.0.0.0" ||
  host.endsWith(".localhost")
if (host === PRODUCTION_ORIGIN) {
  console.error(
    `verify-staging: refusing the production origin ${PRODUCTION_ORIGIN} — ` +
      "this script creates and deletes disposable resources; production " +
      "cutover proof is a different gate (verify:cutover, task 29)",
  )
  process.exit(2)
}
if (isLoopback && !allowLocal) {
  console.error(
    `verify-staging: refusing loopback origin ${origin.origin} without --allow-local — ` +
      "a local Miniflare run is rehearsal, not staging proof; pass --allow-local " +
      "explicitly to rehearse the script against a local worker",
  )
  process.exit(2)
}
if (!isLoopback && origin.protocol !== "https:") {
  console.error(
    `verify-staging: refusing insecure remote origin ${origin.origin} — ` +
      "staging origins are https (e.g. https://<worker>.<subdomain>.workers.dev)",
  )
  process.exit(2)
}
const base = origin.origin

// --- helpers ---------------------------------------------------------------

const secrets = new Set() // capability values that must never be re-emitted
const auditLog = [] // {step, method, path, status, bodyText}
let stepsRun = 0

/** Never print a capability value, even inside an unexpected body. */
function redact(text) {
  let out = text
  for (const secret of secrets) out = out.split(secret).join("<redacted>")
  return out
}

function fail(step, message) {
  const error = new Error(message)
  error.step = step
  throw error
}

async function api(step, method, path, options = {}) {
  const headers = { ...options.headers }
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error" }
  if (options.secret !== undefined) {
    headers.authorization = `Bearer ${options.secret}`
  }
  if (options.idem !== false) {
    headers["idempotency-key"] = options.idemKey ?? crypto.randomUUID()
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json"
    init.body = JSON.stringify(options.body)
  }
  let response
  try {
    response = await fetch(`${base}${path}`, init)
  } catch (cause) {
    fail(
      step,
      `${method} ${path} failed at transport level: ${cause?.message ?? cause} ` +
        "(is the worker deployed and reachable?)",
    )
  }
  const text = await response.text()
  auditLog.push({ step, method, path, status: response.status, bodyText: text })
  let json = null
  const trimmed = text.trimStart()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      json = JSON.parse(text)
    } catch {
      fail(
        step,
        `${method} ${path} -> ${response.status} with non-JSON body: ${redact(text.slice(0, 300))}`,
      )
    }
  }
  return { response, status: response.status, text, json }
}

function expectStatus(step, got, want, summary) {
  if (got.status !== want) {
    fail(
      step,
      `${summary} -> expected ${want}, got ${got.status}: ${redact(got.text.slice(0, 300))}`,
    )
  }
}

function expectErrorEnvelope(step, got, status, code) {
  expectStatus(step, got, status, "error response")
  const error = got.json?.error
  if (error?.code !== code || typeof error.requestId !== "string") {
    fail(step, `expected {error:{code:${code}}} envelope, got: ${redact(got.text.slice(0, 300))}`)
  }
  return error
}

// --- synthetic fixtures ----------------------------------------------------

const runId = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`.replaceAll("-", "")
const tag = `stg${runId}`.slice(0, 24)

function playlist(title, visibility, itemSuffix) {
  return {
    schemaVersion: 1,
    title,
    description: `synthetic staging verification playlist ${runId} — disposable, deleted by verify-staging`,
    author: "d-op-verify",
    tags: [tag, "staging-verify"],
    visibility,
    items: [
      {
        partId: `stg_${runId}_${itemSuffix}_1`,
        workId: `stgw_${runId}`,
        title: `Synthetic Work ${itemSuffix}`,
        episodeTitle: `Synthetic Episode ${itemSuffix}-1`,
        episodeNumber: "1",
        range: { start: 89_000, end: 178_000, name: "op" },
      },
      {
        partId: `stg_${runId}_${itemSuffix}_2`,
        workId: `stgw_${runId}`,
        title: `Synthetic Work ${itemSuffix}`,
        episodeTitle: `Synthetic Episode ${itemSuffix}-2`,
        episodeNumber: "2",
        range: { start: 5_000, end: 95_000 },
      },
    ],
  }
}

// --- cleanup ---------------------------------------------------------------

const live = new Map() // shareId -> {secret, revision}
async function cleanup() {
  for (const [shareId, entry] of live) {
    try {
      const res = await api("cleanup", "DELETE", `/api/v1/playlists/${shareId}`, {
        secret: entry.secret,
        body: { expectedRevision: entry.revision },
      })
      if (res.status === 204) {
        console.log(`[cleanup] deleted ${shareId}`)
      } else {
        console.error(
          `[cleanup] DELETE ${shareId} -> ${res.status}: ${redact(res.text.slice(0, 200))}`,
        )
      }
    } catch (error) {
      console.error(`[cleanup] DELETE ${shareId} failed: ${error.message}`)
    }
  }
}

// --- flow ------------------------------------------------------------------

let ok = false
try {
  // 0. Reachability — any HTTP response proves the worker serves traffic.
  {
    const step = "reachability"
    stepsRun += 1
    const res = await api(step, "GET", "/", { idem: false })
    if (res.status >= 500) {
      fail(step, `GET / -> ${res.status} (worker unhealthy)`)
    }
    console.log(`[ok] ${step}: GET / -> ${res.status}`)
  }

  // 1. CREATE public (pending) — the plaintext secret is legal ONLY here.
  const publicShare = { id: null, secret: null, revision: 1 }
  {
    const step = "create-public"
    stepsRun += 1
    const res = await api(step, "POST", "/api/v1/playlists", {
      body: playlist(`Staging verify ${runId} public`, "public", "pa"),
    })
    expectStatus(step, res, 201, "POST /api/v1/playlists")
    const data = res.json?.data
    if (
      typeof data?.shareId !== "string" ||
      typeof data?.manageSecret !== "string" ||
      data?.state !== "pending" ||
      data?.revision !== 1
    ) {
      fail(step, `malformed create ack: ${redact(res.text.slice(0, 300))}`)
    }
    publicShare.id = data.shareId
    publicShare.secret = data.manageSecret
    publicShare.revision = data.revision
    secrets.add(data.manageSecret)
    live.set(data.shareId, { secret: data.manageSecret, revision: data.revision })
    console.log(`[ok] ${step}: shareId ${publicShare.id} created pending`)
  }

  // 2. Pending provisional is publicly invisible (same 404 as absent).
  {
    const step = "pending-hidden"
    stepsRun += 1
    const res = await api(step, "GET", `/api/v1/playlists/${publicShare.id}`, { idem: false })
    expectErrorEnvelope(step, res, 404, "NOT_FOUND")
    console.log(`[ok] ${step}: pending share reads 404`)
  }

  // 3. ACTIVATE public (CAS rev 1 -> 2).
  {
    const step = "activate-public"
    stepsRun += 1
    const res = await api(step, "PATCH", `/api/v1/playlists/${publicShare.id}`, {
      secret: publicShare.secret,
      body: { operation: "activate", expectedRevision: 1 },
    })
    expectStatus(step, res, 200, "PATCH activate")
    if (res.json?.data?.revision !== 2 || res.json?.data?.shareId !== publicShare.id) {
      fail(step, `activate ack mismatch: ${redact(res.text.slice(0, 300))}`)
    }
    publicShare.revision = res.json.data.revision
    live.get(publicShare.id).revision = publicShare.revision
    console.log(`[ok] ${step}: revision -> ${publicShare.revision}`)
  }

  // 4. READ public snapshot.
  {
    const step = "read-public"
    stepsRun += 1
    const res = await api(step, "GET", `/api/v1/playlists/${publicShare.id}`, { idem: false })
    expectStatus(step, res, 200, "GET playlist")
    const data = res.json?.data
    if (
      data?.shareId !== publicShare.id ||
      data?.revision !== 2 ||
      data?.playlist?.visibility !== "public" ||
      data?.importCount !== 0 ||
      typeof data?.contentHash !== "string"
    ) {
      fail(step, `read payload mismatch: ${redact(res.text.slice(0, 300))}`)
    }
    console.log(`[ok] ${step}: public snapshot readable (rev ${data.revision})`)
  }

  // 5. CAS replace (rev 2 -> 3).
  {
    const step = "cas-replace"
    stepsRun += 1
    const res = await api(step, "PATCH", `/api/v1/playlists/${publicShare.id}`, {
      secret: publicShare.secret,
      body: {
        operation: "replace",
        expectedRevision: 2,
        playlist: playlist(`Staging verify ${runId} public v2`, "public", "pa"),
      },
    })
    expectStatus(step, res, 200, "PATCH replace")
    if (res.json?.data?.revision !== 3) {
      fail(step, `replace ack revision mismatch: ${redact(res.text.slice(0, 300))}`)
    }
    publicShare.revision = res.json.data.revision
    live.get(publicShare.id).revision = publicShare.revision
    console.log(`[ok] ${step}: revision -> ${publicShare.revision}`)
  }

  // 6. Stale CAS must conflict with the authenticated current revision.
  {
    const step = "cas-stale-conflict"
    stepsRun += 1
    const res = await api(step, "PATCH", `/api/v1/playlists/${publicShare.id}`, {
      secret: publicShare.secret,
      body: {
        operation: "replace",
        expectedRevision: 2,
        playlist: playlist(`Staging verify ${runId} public v3`, "public", "pa"),
      },
    })
    const error = expectErrorEnvelope(step, res, 409, "REVISION_CONFLICT")
    if (error.details?.revision !== 3) {
      fail(step, `conflict did not disclose current revision 3: ${redact(res.text.slice(0, 300))}`)
    }
    console.log(`[ok] ${step}: stale expectedRevision -> 409 (current rev 3)`)
  }

  // 7. Import notify + observable importCount.
  {
    const step = "import-notify"
    stepsRun += 1
    const res = await api(step, "POST", `/api/v1/playlists/${publicShare.id}/import`, {
      body: { eventId: crypto.randomUUID() },
    })
    expectStatus(step, res, 204, "POST import")
    console.log(`[ok] ${step}: import notification -> 204`)
  }
  {
    const step = "read-import-count"
    stepsRun += 1
    const res = await api(step, "GET", `/api/v1/playlists/${publicShare.id}`, { idem: false })
    expectStatus(step, res, 200, "GET playlist")
    if (res.json?.data?.importCount !== 1) {
      fail(step, `importCount expected 1, got: ${redact(res.text.slice(0, 300))}`)
    }
    console.log(`[ok] ${step}: importCount == 1`)
  }

  // 8. Second profile: unlisted create -> activate -> read.
  const unlistedShare = { id: null, secret: null, revision: 1 }
  {
    const step = "create-unlisted"
    stepsRun += 1
    const res = await api(step, "POST", "/api/v1/playlists", {
      body: playlist(`Staging verify ${runId} unlisted`, "unlisted", "ub"),
    })
    expectStatus(step, res, 201, "POST /api/v1/playlists")
    const data = res.json?.data
    if (typeof data?.shareId !== "string" || typeof data?.manageSecret !== "string") {
      fail(step, `malformed create ack: ${redact(res.text.slice(0, 300))}`)
    }
    unlistedShare.id = data.shareId
    unlistedShare.secret = data.manageSecret
    secrets.add(data.manageSecret)
    live.set(data.shareId, { secret: data.manageSecret, revision: 1 })
    console.log(`[ok] ${step}: shareId ${unlistedShare.id} created pending`)
  }
  {
    const step = "activate-unlisted"
    stepsRun += 1
    const res = await api(step, "PATCH", `/api/v1/playlists/${unlistedShare.id}`, {
      secret: unlistedShare.secret,
      body: { operation: "activate", expectedRevision: 1 },
    })
    expectStatus(step, res, 200, "PATCH activate")
    unlistedShare.revision = res.json?.data?.revision ?? 2
    live.get(unlistedShare.id).revision = unlistedShare.revision
    console.log(`[ok] ${step}: revision -> ${unlistedShare.revision}`)
  }
  {
    const step = "read-unlisted"
    stepsRun += 1
    const res = await api(step, "GET", `/api/v1/playlists/${unlistedShare.id}`, {
      idem: false,
    })
    expectStatus(step, res, 200, "GET playlist")
    if (res.json?.data?.playlist?.visibility !== "unlisted") {
      fail(step, `unlisted read mismatch: ${redact(res.text.slice(0, 300))}`)
    }
    console.log(`[ok] ${step}: unlisted snapshot readable by link`)
  }

  // 9. Discover: public appears under the unique tag; unlisted never does.
  {
    const step = "discover-visibility"
    stepsRun += 1
    const res = await api(step, "GET", `/api/v1/playlists?tag=${tag}&limit=50`, {
      idem: false,
    })
    expectStatus(step, res, 200, "GET collection")
    const items = res.json?.data?.items
    if (!Array.isArray(items) || typeof res.json?.data?.ranking !== "object") {
      fail(step, `malformed collection: ${redact(res.text.slice(0, 300))}`)
    }
    const ids = items.map((item) => item?.shareId)
    if (!ids.includes(publicShare.id)) {
      fail(step, `public share absent from tag listing: ${ids.join(",") || "(empty)"}`)
    }
    if (ids.includes(unlistedShare.id)) {
      fail(step, "unlisted share leaked into the public collection listing")
    }
    console.log(`[ok] ${step}: public listed, unlisted absent`)
  }
  {
    const step = "discover-tags"
    stepsRun += 1
    const res = await api(step, "GET", "/api/v1/playlists/tags", { idem: false })
    expectStatus(step, res, 200, "GET tags")
    const entry = res.json?.data?.tags?.find((t) => t?.tag === tag)
    if (entry === undefined) {
      fail(step, `verification tag absent from tag dictionary`)
    }
    if (entry.count !== 1) {
      fail(step, `tag count expected 1 (public only), got ${entry.count}`)
    }
    console.log(`[ok] ${step}: tag dictionary counts public only (count=1)`)
  }

  // 10. Delete public -> verify gone.
  {
    const step = "delete-public"
    stepsRun += 1
    const res = await api(step, "DELETE", `/api/v1/playlists/${publicShare.id}`, {
      secret: publicShare.secret,
      body: { expectedRevision: publicShare.revision },
    })
    expectStatus(step, res, 204, "DELETE playlist")
    live.delete(publicShare.id)
    console.log(`[ok] ${step}: deleted`)
  }
  {
    const step = "verify-gone-public"
    stepsRun += 1
    const res = await api(step, "GET", `/api/v1/playlists/${publicShare.id}`, { idem: false })
    expectErrorEnvelope(step, res, 404, "NOT_FOUND")
    console.log(`[ok] ${step}: deleted share reads 404`)
  }

  // 11. Delete unlisted -> verify gone.
  {
    const step = "delete-unlisted"
    stepsRun += 1
    const res = await api(step, "DELETE", `/api/v1/playlists/${unlistedShare.id}`, {
      secret: unlistedShare.secret,
      body: { expectedRevision: unlistedShare.revision },
    })
    expectStatus(step, res, 204, "DELETE playlist")
    live.delete(unlistedShare.id)
    console.log(`[ok] ${step}: deleted`)
  }
  {
    const step = "verify-gone-unlisted"
    stepsRun += 1
    const res = await api(step, "GET", `/api/v1/playlists/${unlistedShare.id}`, {
      idem: false,
    })
    expectErrorEnvelope(step, res, 404, "NOT_FOUND")
    console.log(`[ok] ${step}: deleted share reads 404`)
  }

  // 12. Capability audit: no response except each POST 201 ack may contain a
  // manageSecret value or key name. Secrets never appear in URLs either.
  {
    const step = "capability-audit"
    stepsRun += 1
    const createAcks = new Set(["create-public", "create-unlisted"])
    const offenders = []
    for (const record of auditLog) {
      if (createAcks.has(record.step)) continue
      if (record.bodyText.includes('"manageSecret"')) {
        offenders.push(`${record.step}: body contains a manageSecret field`)
      }
      for (const secret of secrets) {
        if (secret !== null && record.bodyText.includes(secret)) {
          offenders.push(`${record.step}: body echoes the manage capability`)
        }
      }
      if (record.bodyText.includes("Bearer ")) {
        offenders.push(`${record.step}: body echoes an Authorization header`)
      }
    }
    if (offenders.length > 0) {
      fail(step, offenders.join("; "))
    }
    console.log(`[ok] ${step}: ${auditLog.length} responses audited, no capability leakage`)
  }

  ok = true
} catch (error) {
  console.error(`verify-staging FAILED at step ${error.step ?? "?"}: ${redact(error.message)}`)
} finally {
  if (live.size > 0) {
    await cleanup()
  }
}

if (ok && live.size === 0) {
  console.log(
    `verify-staging PASS: ${stepsRun} steps against ${base} — ` +
      "create/activate/read/CAS/import/discover/delete verified, all disposable resources removed",
  )
  process.exit(0)
}
process.exit(1)
