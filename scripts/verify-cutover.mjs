#!/usr/bin/env node
// verify:cutover — task 29 production cutover gate for d-op.sasnews.dev.
//
// Read-only, non-destructive proof that the canonical domain is served by
// the d-OP v2 Worker (not legacy GitHub Pages): DNS no longer points at
// Pages, TLS is valid, SSR pages render the v2 shell, legacy links still
// resolve, the Share API answers with contract envelopes, and security
// headers are applied. It creates/deletes NOTHING on production — the
// disposable-resource flow is verify:staging's job (docs/staging.md).
//
// Usage:
//   node scripts/verify-cutover.mjs --base-url https://d-op.sasnews.dev [--evidence <path>]
//   node scripts/verify-cutover.mjs --base-url http://127.0.0.1:8787 --allow-other-origin
//
// --allow-other-origin is the documented escape for rehearsing this gate
// against a candidate/local origin BEFORE the domain is cut over. A
// rehearsal PASS is local/candidate proof only — it is never production
// cutover proof.
//
// Exit 0 = every enforced check passed. Exit 1 = at least one check failed
// (the failing check name is printed and recorded). Exit 2 = refused
// arguments (missing base-url, non-canonical origin without the escape).

import dns from "node:dns/promises"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import tls from "node:tls"

const CANONICAL_HOST = "d-op.sasnews.dev"
const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`
const DEFAULT_TIMEOUT_MS = 15_000
const MIN_CERT_DAYS = 7
// GitHub Pages apex addresses are the /24s 185.199.108-111 and the
// 2606:50c0:8000-8003::/64s (x.x.x.153 and siblings inside each block), and
// a CNAME to *.github.io is the same signal without an address lookup. A
// canonical answer matching any of these means the domain still resolves
// to legacy hosting — the cutover has not happened.
const GITHUB_PAGES_V4_PREFIXES = ["185.199.108.", "185.199.109.", "185.199.110.", "185.199.111."]
const GITHUB_PAGES_V6_PREFIXES = [
  "2606:50c0:8000:",
  "2606:50c0:8001:",
  "2606:50c0:8002:",
  "2606:50c0:8003:",
]
const GITHUB_IO_SUFFIX = ".github.io"
// A syntactically valid shareId (22-char base64url alphabet) that cannot
// exist: probes the real routes without an existence oracle side channel.
const SYNTHETIC_SHARE_ID = "AAAAAAAAAAAAAAAAAAAAAA"

function usage(message) {
  console.error(`verify-cutover: ${message}`)
  console.error(
    "usage: node scripts/verify-cutover.mjs --base-url <origin> " +
      "[--allow-other-origin] [--timeout <ms>] [--evidence <path>]",
  )
  process.exit(2)
}

// --- args -----------------------------------------------------------------

const args = process.argv.slice(2)
let baseUrl
let allowOtherOrigin = false
let evidencePath
let timeoutMs = DEFAULT_TIMEOUT_MS
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === "--base-url") {
    baseUrl = args[++i]
  } else if (arg?.startsWith("--base-url=")) {
    baseUrl = arg.slice("--base-url=".length)
  } else if (arg === "--allow-other-origin") {
    allowOtherOrigin = true
  } else if (arg === "--timeout") {
    timeoutMs = Number(args[++i])
  } else if (arg?.startsWith("--timeout=")) {
    timeoutMs = Number(arg.slice("--timeout=".length))
  } else if (arg === "--evidence") {
    evidencePath = args[++i]
  } else if (arg?.startsWith("--evidence=")) {
    evidencePath = arg.slice("--evidence=".length)
  } else {
    usage(`unknown argument: ${arg}`)
  }
}
if (baseUrl === undefined || baseUrl === "") {
  usage("missing --base-url")
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  usage(`invalid --timeout: ${timeoutMs}`)
}

const origin = URL.parse(baseUrl)
if (origin === null || (origin.protocol !== "https:" && origin.protocol !== "http:")) {
  usage(`--base-url must be an http(s) origin, got: ${baseUrl}`)
}
const host = origin.hostname.toLowerCase()
const isCanonical = host === CANONICAL_HOST && origin.protocol === "https:"
if (!isCanonical && !allowOtherOrigin) {
  console.error(
    `verify-cutover: refusing non-canonical origin ${origin.origin} — ` +
      `the production gate targets ${CANONICAL_ORIGIN} only. ` +
      "Pass --allow-other-origin explicitly to rehearse against a " +
      "candidate or local origin (rehearsal is never cutover proof).",
  )
  process.exit(2)
}
const base = origin.origin
const isIpLiteral = /^[0-9.]+$/.test(host) || host.includes(":") || host === "[::1]"
const tlsPort = origin.port === "" ? 443 : Number(origin.port)

// --- evidence --------------------------------------------------------------

const checks = [] // {name, status:"pass"|"fail"|"skip", detail}
const requests = [] // {check, method, url, status, headers}
const bodies = [] // {check, url, text} — bounded, for the leakage audit
const startedAt = new Date()

function record(check, status, detail) {
  checks.push({ name: check, status, detail })
  const tag = status === "pass" ? "ok" : status === "skip" ? "skip" : "FAIL"
  console.log(`[${tag}] ${check}: ${detail}`)
}

async function run(check, fn) {
  try {
    const detail = await fn()
    record(check, "pass", detail ?? "ok")
  } catch (error) {
    if (error?.skip) {
      record(check, "skip", error.message)
    } else {
      record(check, "fail", error?.message ?? String(error))
    }
  }
}

function skip(reason) {
  const error = new Error(reason)
  error.skip = true
  throw error
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

async function request(check, method, url, options = {}) {
  const init = {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: options.headers,
  }
  if (options.body !== undefined) init.body = options.body
  let response
  try {
    response = await fetch(url, init)
  } catch (cause) {
    throw new Error(`${method} ${url} transport failure: ${cause?.message ?? cause}`)
  }
  const text = await response.text()
  const headers = {}
  for (const [name, value] of response.headers) headers[name] = value
  requests.push({ check, method, url, status: response.status, headers })
  bodies.push({ check, url, text: text.slice(0, 64 * 1024) })
  return { status: response.status, headers, text }
}

function expectHtmlShell(got, path) {
  expect(
    got.status === 200,
    `GET ${path} -> ${got.status} (expected 200; the v2 SSR page must serve the canonical route)`,
  )
  expect(
    (got.headers["content-type"] ?? "").includes("text/html"),
    `GET ${path} content-type ${got.headers["content-type"] ?? "(none)"} (expected text/html)`,
  )
  expect(
    got.text.includes('data-testid="site-header"'),
    `GET ${path} lacks the v2 shell marker data-testid="site-header" — ` +
      "the legacy site has no test ids, so the legacy host is still serving",
  )
  expect(
    !got.text.includes("There isn't a GitHub Pages site here"),
    `GET ${path} returned a GitHub Pages 404 page`,
  )
}

function expectJsonEnvelope(got, path, status, description) {
  expect(
    got.status === status,
    `GET ${path} -> ${got.status} (expected ${status} for ${description})`,
  )
  let json
  try {
    json = JSON.parse(got.text)
  } catch {
    throw new Error(`GET ${path} -> ${got.status} with non-JSON body: ${got.text.slice(0, 160)}`)
  }
  return json
}

// --- checks ----------------------------------------------------------------

async function checkDns() {
  if (isIpLiteral) skip("host is an IP literal — nothing to resolve")
  const [a, aaaa, cname] = await Promise.all([
    dns.resolve4(host).then(
      (r) => r,
      () => [],
    ),
    dns.resolve6(host).then(
      (r) => r,
      () => [],
    ),
    dns.resolveCname(host).then(
      (r) => r,
      () => [],
    ),
  ])
  const addresses = [...a, ...aaaa]
  expect(
    addresses.length > 0 || cname.length > 0,
    `${host} resolves to nothing — DNS for the canonical name is broken`,
  )
  const legacy = [
    ...a.filter((addr) => GITHUB_PAGES_V4_PREFIXES.some((prefix) => addr.startsWith(prefix))),
    ...aaaa.filter((addr) =>
      GITHUB_PAGES_V6_PREFIXES.some((prefix) => addr.toLowerCase().startsWith(prefix)),
    ),
    ...cname.filter((name) => name.toLowerCase().endsWith(GITHUB_IO_SUFFIX)),
  ]
  expect(
    legacy.length === 0,
    `${host} still resolves to GitHub Pages (${legacy.join(", ")}) — ` +
      "the DNS cutover to the Worker has not happened",
  )
  return `A=[${a.join(",")}] AAAA=[${aaaa.join(",")}] CNAME=[${cname.join(",")}]`
}

function checkTls() {
  return new Promise((resolve, reject) => {
    if (origin.protocol !== "https:") {
      skip("base origin is http — TLS applies only to the https gate")
    }
    const socket = tls.connect(
      { host, port: tlsPort, servername: host, rejectUnauthorized: true, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate()
        const protocol = socket.getProtocol()
        socket.end()
        if (!cert || Object.keys(cert).length === 0) {
          reject(new Error("no peer certificate presented"))
          return
        }
        const validTo = new Date(cert.valid_to)
        const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86_400_000)
        if (daysLeft < MIN_CERT_DAYS) {
          reject(
            new Error(
              `certificate for ${host} expires in ${daysLeft}d ` +
                `(${cert.valid_to}) — below the ${MIN_CERT_DAYS}d floor`,
            ),
          )
          return
        }
        resolve(
          `${protocol}; subject=${cert.subject?.CN ?? "?"}; issuer=${cert.issuer?.O ?? "?"}; ` +
            `valid ${cert.valid_from} -> ${cert.valid_to} (${daysLeft}d left); ` +
            `san=${cert.subjectaltname ?? "(none)"}`,
        )
      },
    )
    socket.on("error", (error) => {
      reject(
        new Error(
          `TLS handshake with ${host}:${tlsPort} failed: ${error.message} ` +
            "(certificate invalid, hostname mismatch, or no TLS listener)",
        ),
      )
    })
    socket.on("timeout", () => {
      socket.destroy()
      reject(new Error(`TLS handshake with ${host}:${tlsPort} timed out`))
    })
  })
}

async function checkHttpRedirect() {
  if (origin.protocol !== "https:") skip("base origin is http — nothing upgrades to https here")
  const got = await request("http-to-https", "GET", `http://${host}/`)
  expect(
    got.status >= 300 && got.status < 400,
    `http://${host}/ -> ${got.status} (expected a 3xx redirect to https)`,
  )
  const location = got.headers.location ?? ""
  expect(
    location.startsWith("https://"),
    `http://${host}/ redirect location ${location || "(none)"} does not point at https://`,
  )
  return `${got.status} -> ${location}`
}

async function checkWww() {
  if (!isCanonical) skip("www redirect is a canonical-domain concern only")
  const wwwHost = `www.${CANONICAL_HOST}`
  const resolved = await dns.resolve4(wwwHost).then(
    (r) => r,
    () => [],
  )
  if (resolved.length === 0) {
    skip(`${wwwHost} does not resolve — no www alias is configured (acceptable)`)
  }
  const got = await request("www-redirect", "GET", `https://${wwwHost}/`)
  const location = got.headers.location ?? ""
  if (got.status >= 300 && got.status < 400) {
    expect(
      location.startsWith(`https://${CANONICAL_HOST}`),
      `https://${wwwHost}/ -> ${got.status} ${location} (expected redirect to apex)`,
    )
    return `${got.status} -> ${location}`
  }
  expect(got.status === 200, `https://${wwwHost}/ -> ${got.status} (expected apex redirect or 200)`)
  return "200 on www host (no apex redirect configured — recorded)"
}

async function checkSsrPage(path, marker) {
  const got = await request(`ssr-page:${path}`, "GET", `${base}${path}`)
  expectHtmlShell(got, path)
  expect(
    got.text.includes(marker),
    `GET ${path} lacks page marker ${marker} — wrong page content served`,
  )
  return `200 + ${marker}`
}

async function checkSharePage() {
  const path = `/p/${SYNTHETIC_SHARE_ID}`
  const got = await request("share-page-shell", "GET", `${base}${path}`)
  expect(
    got.status === 404,
    `GET ${path} -> ${got.status} (expected 404 for a nonexistent shareId)`,
  )
  expect(
    (got.headers["content-type"] ?? "").includes("text/html"),
    `GET ${path} content-type ${got.headers["content-type"] ?? "(none)"} (expected the HTML shell)`,
  )
  expect(
    got.text.includes("共有プレイリストが見つかりません") && got.text.includes("d-OP Share"),
    `GET ${path} is not the d-OP not-found view — a platform/host error ` +
      "page would mean the route is not served by the v2 worker",
  )
  expect(
    !got.text.includes("There isn't a GitHub Pages site here"),
    `GET ${path} returned a GitHub Pages 404 page`,
  )
  return "404 with the d-OP not-found shell (route served by the v2 worker)"
}

async function checkPrivacyRedirect() {
  const got = await request("legacy-privacy-redirect", "GET", `${base}/PRIVACY.md`)
  expect(
    got.status === 301,
    `GET /PRIVACY.md -> ${got.status} (expected the permanent 301 legacy redirect, ` +
      "not the legacy file body and not a 404)",
  )
  const location = got.headers.location ?? ""
  expect(
    location === "/privacy" || location === `${CANONICAL_ORIGIN}/privacy`,
    `GET /PRIVACY.md location ${location || "(none)"} (expected /privacy)`,
  )
  return `301 -> ${location}`
}

async function checkAssets() {
  const favicon = await request("static-assets", "GET", `${base}/favicon.svg`)
  expect(
    favicon.status === 200 && (favicon.headers["content-type"] ?? "").includes("svg"),
    `GET /favicon.svg -> ${favicon.status} ${favicon.headers["content-type"] ?? ""}`,
  )
  const icon = await request("static-assets", "GET", `${base}/assets/d-OP-icon.png`)
  expect(
    icon.status === 200 && (icon.headers["content-type"] ?? "").includes("image/png"),
    `GET /assets/d-OP-icon.png -> ${icon.status} ${icon.headers["content-type"] ?? ""}`,
  )
  return "favicon.svg + d-OP-icon.png served with image content types"
}

async function checkApiTags() {
  const got = await request("api-tags", "GET", `${base}/api/v1/playlists/tags`)
  const json = expectJsonEnvelope(got, "/api/v1/playlists/tags", 200, "the public tag dictionary")
  const tags = json?.data?.tags
  expect(
    Array.isArray(tags),
    `GET /api/v1/playlists/tags missing data.tags[]: ${got.text.slice(0, 160)}`,
  )
  const malformed = tags.find((t) => typeof t?.tag !== "string" || typeof t?.count !== "number")
  expect(malformed === undefined, `tag entry malformed: ${JSON.stringify(malformed)}`)
  return `200 data.tags[${tags.length}] (public dictionary)`
}

async function checkApiCollection() {
  const path = "/api/v1/playlists?sort=new&limit=1"
  const got = await request("api-collection", "GET", `${base}${path}`)
  const json = expectJsonEnvelope(got, path, 200, "the public collection")
  const data = json?.data
  expect(
    Array.isArray(data?.items) && typeof data?.ranking === "object" && data.ranking !== null,
    `GET ${path} missing data.items[]/data.ranking{}: ${got.text.slice(0, 160)}`,
  )
  const ranking = data.ranking
  expect(
    typeof ranking.mode === "string" &&
      typeof ranking.effectiveWindow === "string" &&
      typeof ranking.asOf === "string",
    `GET ${path} ranking shape malformed: ${JSON.stringify(ranking)}`,
  )
  return `200 items[${data.items.length}] ranking.mode=${ranking.mode} window=${ranking.effectiveWindow}`
}

async function checkApiReadNotFound() {
  const path = `/api/v1/playlists/${SYNTHETIC_SHARE_ID}`
  const got = await request("api-read-not-found", "GET", `${base}${path}`)
  const json = expectJsonEnvelope(got, path, 404, "an absent playlist")
  const error = json?.error
  expect(
    error?.code === "NOT_FOUND" && typeof error?.requestId === "string",
    `GET ${path} error envelope malformed: ${got.text.slice(0, 160)}`,
  )
  return "404 {error:{code:NOT_FOUND,requestId}} — API + D1 read path healthy"
}

async function checkApiMutationEnvelope() {
  // Two probes, neither can create a row:
  //  1. POST with no content-type and no body — the edge CSRF guard
  //     (Astro security.checkOrigin) or the route must reject it 4xx.
  //  2. POST application/json with malformed JSON — reaches the route and
  //     must return the contract {error:{code,requestId}} envelope.
  // A 201 or a 5xx on either probe is a hard failure: this gate must never
  // mutate production, and a healthy API rejects bad input in-band.
  const edge = await request("api-mutation-envelope", "POST", `${base}/api/v1/playlists`)
  expect(
    edge.status !== 201,
    "POST /api/v1/playlists unexpectedly created a resource — verify:cutover must never mutate production",
  )
  expect(
    edge.status >= 400 && edge.status < 500,
    `POST /api/v1/playlists (no content-type) -> ${edge.status} (expected a 4xx rejection)`,
  )
  const body = await request("api-mutation-envelope", "POST", `${base}/api/v1/playlists`, {
    headers: { "content-type": "application/json" },
    body: "{",
  })
  expect(
    body.status !== 201,
    "POST /api/v1/playlists unexpectedly created a resource — verify:cutover must never mutate production",
  )
  expect(
    body.status >= 400 && body.status < 500,
    `POST /api/v1/playlists (malformed json) -> ${body.status} (expected a 4xx contract rejection)`,
  )
  let json
  try {
    json = JSON.parse(body.text)
  } catch {
    throw new Error(
      `POST malformed json -> ${body.status} non-JSON body: ${body.text.slice(0, 160)}`,
    )
  }
  expect(
    typeof json?.error?.code === "string" && typeof json?.error?.requestId === "string",
    `POST error envelope malformed: ${body.text.slice(0, 160)}`,
  )
  return `edge ${edge.status}; malformed json ${body.status} {error:{code:${json.error.code}}} — mutation path validates and rejects`
}

function checkSecurityHeaders() {
  const page = requests.find((r) => r.check === "ssr-page:/" && r.method === "GET")
  expect(page !== undefined, "ssr-page:/ response not recorded")
  const required = {
    "content-security-policy": (v) =>
      v.includes("default-src 'none'") && v.includes("frame-ancestors 'none'"),
    "referrer-policy": (v) => v === "no-referrer",
    "x-content-type-options": (v) => v === "nosniff",
    "x-frame-options": (v) => v === "DENY",
    "permissions-policy": (v) => v.length > 0,
  }
  const missing = []
  for (const [name, test] of Object.entries(required)) {
    const value = page.headers[name]
    if (typeof value !== "string" || !test(value)) {
      missing.push(`${name}=${value ?? "(absent)"}`)
    }
  }
  expect(missing.length === 0, `GET / missing/weakened security headers: ${missing.join("; ")}`)
  const server = page.headers.server ?? ""
  expect(
    !server.toLowerCase().includes("github"),
    `GET / Server header "${server}" — still served by GitHub Pages, not the Worker`,
  )
  const api = requests.find((r) => r.check === "api-tags")
  if (api !== undefined) {
    expect(
      api.headers["content-security-policy"] !== undefined &&
        api.headers["x-content-type-options"] === "nosniff",
      "API responses lack the security header set — headers must cover SSR AND API",
    )
  }
  return `required set present on / and API; Server=${server || "(none)"}`
}

function checkNoLeakage() {
  const badHeaderNames = ["x-powered-by", "x-astro", "x-debug", "x-vercel", "x-doppler"]
  const headerHits = []
  for (const r of requests) {
    for (const name of Object.keys(r.headers)) {
      if (badHeaderNames.some((bad) => name.startsWith(bad))) {
        headerHits.push(`${r.check}: header ${name}`)
      }
    }
  }
  const badBodyTokens = [
    "manageSecret",
    "secret_hash",
    "rate_limit_hmac",
    "RATE_LIMIT_HMAC",
    "Bearer ",
    "SQLITE_",
    "D1_ERROR",
    "/node_modules/",
  ]
  const bodyHits = []
  for (const b of bodies) {
    for (const token of badBodyTokens) {
      if (b.text.includes(token)) {
        bodyHits.push(`${b.check}: body contains ${token}`)
      }
    }
    if (/\n\s+at [\w$.<>]+\s*\(/.test(b.text)) {
      bodyHits.push(`${b.check}: body contains a stack trace frame`)
    }
  }
  const hits = [...headerHits, ...bodyHits]
  expect(hits.length === 0, `debug/secret leakage: ${hits.join("; ")}`)
  return `${requests.length} responses scanned — no secret/debug leakage`
}

// --- flow ------------------------------------------------------------------

await run("dns-resolution", checkDns)
await run("tls-certificate", checkTls)
await run("http-to-https", checkHttpRedirect)
await run("www-redirect", checkWww)
await run("ssr-page:/", () => checkSsrPage("/", 'href="/explore"'))
await run("ssr-page:/explore", () => checkSsrPage("/explore", 'data-testid="explore-sorts"'))
await run("ssr-page:/privacy", () => checkSsrPage("/privacy", "プライバシーポリシー"))
await run("ssr-page:/terms", () => checkSsrPage("/terms", "利用規約"))
await run("share-page-shell", checkSharePage)
await run("legacy-privacy-redirect", checkPrivacyRedirect)
await run("static-assets", checkAssets)
await run("api-tags", checkApiTags)
await run("api-collection", checkApiCollection)
await run("api-read-not-found", checkApiReadNotFound)
await run("api-mutation-envelope", checkApiMutationEnvelope)
await run("security-headers", checkSecurityHeaders)
await run("no-secret-leakage", checkNoLeakage)

const summary = {
  pass: checks.filter((c) => c.status === "pass").length,
  fail: checks.filter((c) => c.status === "fail").length,
  skip: checks.filter((c) => c.status === "skip").length,
}
const failed = checks.filter((c) => c.status === "fail").map((c) => c.name)
const verdict = failed.length === 0 ? "PASS" : "FAIL"

const evidence = {
  tool: "verify-cutover",
  spec: "task-29 d-op-v2-share",
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  baseUrl: base,
  canonical: isCanonical,
  allowOtherOrigin,
  checks,
  requests: requests.map(({ check, method, url, status }) => ({ check, method, url, status })),
  summary,
  verdict,
}

if (evidencePath !== undefined) {
  mkdirSync(dirname(evidencePath), { recursive: true })
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`[evidence] written to ${evidencePath}`)
}
console.log(`[evidence] ${JSON.stringify({ summary, verdict })}`)

if (verdict === "PASS") {
  console.log(
    `verify-cutover PASS: ${summary.pass} checks against ${base}` +
      (summary.skip > 0 ? ` (${summary.skip} skipped)` : "") +
      (isCanonical ? "" : " — rehearsal origin, NOT production cutover proof"),
  )
  process.exit(0)
}
console.error(`verify-cutover FAIL: failing checks: ${failed.join(", ")}`)
process.exit(1)
