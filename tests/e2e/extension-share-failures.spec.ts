import { createHash } from "node:crypto"
import path from "node:path"
import {
  type BrowserContext,
  chromium,
  expect,
  type Route,
  type TestInfo,
  test,
  type Worker,
} from "@playwright/test"
import { browserLaunchTarget } from "./browser-target"

// Task-27 adversarial/failure acceptance against the real unpacked WXT build
// (chrome-mv3). The synthetic Share API (route interception, newest-route
// wins over the catch-all abort) implements the real v1 contract PLUS
// idempotency receipts so lost-response retries replay server-side outcomes
// honestly. Everything is driven through chrome.runtime.sendMessage from the
// privileged options page — the real options→background boundary — while the
// fake drops, hangs, aborts and lies about responses. No production traffic
// is ever attempted; the catch-all aborts every other http(s) request.
const EXTENSION_PATH = path.resolve("apps/extension/.output/chrome-mv3")
const SHARE_ORIGIN = "https://d-op.sasnews.dev"
const PLAYER = "https://animestore.docomo.ne.jp/animestore/sc_d_pc"
const NOW = "2026-09-20T00:00:00.000Z"
const SHARE_ID_A = "e2eFailShareId0000000a" // ShareIdSchema: exactly 22 chars
const SHARE_ID_B = "e2eFailShareId0000000b"
const PARENT_ID = "e2eFailParentId000000a"
const SECRET_A = `e2eSecretA${"1".repeat(33)}` // ManageSecretSchema: 43 chars
const SECRET_B = `e2eSecretB${"2".repeat(33)}`
const SECRET_PARENT = `e2eSecretP${"3".repeat(33)}`
/** Synthetic sentinel — proves the capability never leaks beyond Bearer. */
const SENTINEL = `SENTINELkey${"7".repeat(32)}`

test.setTimeout(90_000)

// Canonical JSON (sorted keys) — mirrors packages/shared/src/share-canonical.ts
// so the fake can sign contentHash the way the real service does.
function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
  }
  throw new Error("non-canonical value")
}

const hashOf = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")

type SeedItem = {
  id: string
  partId: string
  title: string
  episodeTitle: string
  episodeNumber?: string
  url?: string
  range: { start: number; end: number; name?: string } | null
}

function item(id: string, partId: string, episodeNumber: string): SeedItem {
  return {
    id,
    partId,
    title: "Fixture Work",
    episodeTitle: `第${episodeNumber}話`,
    episodeNumber,
    url: `${PLAYER}?partId=${partId}`,
    range: { start: 0, end: 90_000, name: "OP" },
  }
}

function v2State(seed: {
  playlists: { id: string; name: string; items: SeedItem[] }[]
  publications?: unknown[]
  pendingCreates?: unknown[]
}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    revision: 0,
    playlists: seed.playlists,
    publications: seed.publications ?? [],
    pendingCreates: seed.pendingCreates ?? [],
    preferences: { windowMode: "tab", collapsedPlaylists: {} },
    appliedOperations: [],
    shareConsent: { choice: "granted", decidedAt: NOW },
  }
}

function activeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shareId: SHARE_ID_A,
    localPlaylistId: "pl-1",
    manageSecret: SECRET_A,
    revision: 2,
    contentHash: "a".repeat(64),
    sentSnapshot: JSON.stringify({
      schemaVersion: 1,
      title: "E2E Share",
      description: "",
      author: "",
      tags: [],
      visibility: "public",
      items: [
        {
          partId: "p1",
          workId: undefined,
          title: "Fixture Work",
          episodeTitle: "第1話",
          episodeNumber: "1",
          range: { start: 0, end: 90_000, name: "OP" },
        },
      ],
    }),
    acknowledgedHash: "a".repeat(64),
    visibility: "public",
    createdAt: NOW,
    updatedAt: NOW,
    state: "active",
    ...overrides,
  }
}

type Remote = {
  shareId: string
  secret: string
  revision: number
  state: "pending" | "active"
  playlist: Record<string, unknown>
  contentHash: string
  createdAt: string
  updatedAt: string
  publishedAt?: string
}

/** Server-side mutation receipt — the real repository binds
 * (operation_key, share_id, secret_hash, request_hash) and replays the
 * recorded outcome even when the parent row is already gone. */
type Receipt = {
  readonly shareId?: string
  readonly secret?: string
  readonly method: string
  readonly requestHash: string
  readonly status: number
  readonly body?: unknown
}

type ApiCall = {
  method: string
  path: string
  key: string | undefined
  auth: string | undefined
  body: string
}

/** Per-request fault policy: normal contract, offline (abort without any
 *  server effect), drop (apply the mutation then kill the response —
 *  the "server processed it, client never saw it" case) or hang (apply,
 *  then never answer — the in-flight request the SW-kill leg needs). */
type FaultPolicy = (method: string, path: string) => "normal" | "offline" | "drop" | "hang"

type Fake = {
  readonly remotes: Map<string, Remote>
  readonly ops: Map<string, Receipt>
  readonly apiLog: ApiCall[]
  policy: FaultPolicy
}

function apiJson(status: number, data: unknown) {
  return { status, contentType: "application/json", body: JSON.stringify({ data }) }
}

function apiError(status: number, code: string, details?: { revision: number }) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify({
      error: {
        code,
        message: `e2e ${code}`,
        requestId: "req-e2e",
        ...(details ? { details } : {}),
      },
    }),
  }
}

function publicGetPayload(remote: Remote) {
  const items = remote.playlist["items"] as { range: { start: number; end: number } }[]
  return {
    shareId: remote.shareId,
    revision: remote.revision,
    publishedAt: remote.publishedAt ?? NOW,
    updatedAt: remote.updatedAt,
    contentHash: remote.contentHash,
    playlist: remote.playlist,
    itemCount: items.length,
    totalDurationMs: items.reduce((sum, entry) => sum + (entry.range.end - entry.range.start), 0),
    importCount: 0,
    source: null,
  }
}

const HANG = new Promise<void>(() => undefined) // never resolves — in-flight forever

function handleShareApi(route: Route, fake: Fake, mint: () => [string, string]): Promise<void> {
  const request = route.request()
  const url = new URL(request.url())
  const match = /^\/api\/v1\/playlists(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname)
  const id = match?.[1]
  const headers = request.headers()
  const bodyText = request.postData() ?? ""
  fake.apiLog.push({
    method: request.method(),
    path: url.pathname,
    key: headers["idempotency-key"],
    auth: headers["authorization"],
    body: bodyText,
  })
  const policy = fake.policy(request.method(), url.pathname)
  if (policy === "offline") return route.abort()
  const postBody = (): Record<string, unknown> =>
    JSON.parse(bodyText || "{}") as Record<string, unknown>
  /** Fault injection happens AFTER the mutation+receipt effects below. */
  const finish = (response: ReturnType<typeof apiJson> | { status: number }): Promise<void> => {
    if (policy === "drop") return route.abort()
    if (policy === "hang") return HANG.then(() => undefined)
    return route.fulfill(response)
  }

  /** Request-hash binding mirrors the server's hashRequest: same key plus a
   * different body is an IDEMPOTENCY_CONFLICT, not a replay. */
  const requestHashOf = (method: string, raw: string): string => hashOf({ m: method, b: raw })

  if (request.method() === "POST" && id === undefined) {
    const key = headers["idempotency-key"] ?? ""
    // Receipt replay: the plaintext secret was emitted once and can never be
    // re-emitted — the real contract maps this to 409 CREATE_RECEIPT_UNAVAILABLE.
    const receipt = fake.ops.get(key)
    if (receipt !== undefined) {
      return finish(
        apiError(
          409,
          receipt.requestHash === requestHashOf("create", bodyText)
            ? "CREATE_RECEIPT_UNAVAILABLE"
            : "IDEMPOTENCY_CONFLICT",
        ),
      )
    }
    const playlist = postBody() as unknown as Remote["playlist"]
    const [shareId, secret] = mint()
    const remote: Remote = {
      shareId,
      secret,
      revision: 1,
      state: "pending",
      playlist,
      contentHash: hashOf(playlist),
      createdAt: NOW,
      updatedAt: NOW,
    }
    fake.remotes.set(shareId, remote)
    const ack = {
      shareId,
      manageSecret: secret,
      revision: 1,
      contentHash: remote.contentHash,
      createdAt: NOW,
      activationExpiresAt: "2026-09-20T01:00:00.000Z",
      state: "pending",
    }
    fake.ops.set(key, {
      method: "create",
      requestHash: requestHashOf("create", bodyText),
      status: 201,
      body: ack,
    })
    return finish(apiJson(201, ack))
  }

  const remote = id === undefined ? undefined : fake.remotes.get(id)
  if (request.method() === "GET" && id !== undefined) {
    if (remote === undefined || remote.state !== "active") {
      return finish(apiError(404, "NOT_FOUND"))
    }
    return finish(apiJson(200, publicGetPayload(remote)))
  }

  // Mutation receipt replay — bound to key + shareId + Bearer secret + method +
  // request hash, and honoured even when the parent row is already gone (the
  // repository reads the receipt before the row). This is what makes a
  // dropped-response retry return the recorded outcome.
  if ((request.method() === "PATCH" || request.method() === "DELETE") && id !== undefined) {
    const receipt = fake.ops.get(headers["idempotency-key"] ?? "")
    if (receipt !== undefined) {
      const bearer = /^Bearer (.+)$/.exec(headers["authorization"] ?? "")?.[1]
      if (receipt.secret !== bearer) return finish(apiError(401, "UNAUTHORIZED"))
      if (
        receipt.shareId !== id ||
        receipt.method !== request.method() ||
        receipt.requestHash !== requestHashOf(request.method(), bodyText)
      ) {
        return finish(apiError(409, "IDEMPOTENCY_CONFLICT"))
      }
      return finish(
        receipt.body === undefined
          ? { status: receipt.status }
          : apiJson(receipt.status, receipt.body),
      )
    }
  }
  if (remote === undefined) return finish(apiError(404, "NOT_FOUND"))
  const auth = headers["authorization"]
  if (auth !== `Bearer ${remote.secret}`) return finish(apiError(401, "UNAUTHORIZED"))
  const recordReceipt = (status: number, ack?: unknown) => {
    fake.ops.set(headers["idempotency-key"] ?? "", {
      shareId: remote.shareId,
      secret: remote.secret,
      method: request.method(),
      requestHash: requestHashOf(request.method(), bodyText),
      status,
      ...(ack === undefined ? {} : { body: ack }),
    })
  }

  if (request.method() === "PATCH") {
    const body = postBody()
    if (body["operation"] === "activate") {
      let ack: Record<string, unknown>
      if (remote.state === "active" && remote.revision === 2) {
        // Idempotent repeat-activate (the real contract's INVALID_STATE ack).
        ack = {
          shareId: remote.shareId,
          revision: 2,
          contentHash: remote.contentHash,
          publishedAt: remote.publishedAt ?? NOW,
          updatedAt: remote.updatedAt,
        }
      } else if (remote.state === "pending" && body["expectedRevision"] === 1) {
        remote.state = "active"
        remote.revision = 2
        remote.publishedAt = NOW
        ack = {
          shareId: remote.shareId,
          revision: 2,
          contentHash: remote.contentHash,
          publishedAt: NOW,
          updatedAt: NOW,
        }
      } else {
        return finish(apiError(409, "REVISION_CONFLICT", { revision: remote.revision }))
      }
      recordReceipt(200, ack)
      return finish(apiJson(200, ack))
    }
    if (body["operation"] === "replace") {
      if (body["expectedRevision"] !== remote.revision) {
        return finish(apiError(409, "REVISION_CONFLICT", { revision: remote.revision }))
      }
      remote.revision += 1
      remote.playlist = body["playlist"] as Remote["playlist"]
      remote.contentHash = hashOf(remote.playlist)
      remote.updatedAt = "2026-09-20T02:00:00.000Z"
      const ack = {
        shareId: remote.shareId,
        revision: remote.revision,
        contentHash: remote.contentHash,
        publishedAt: remote.publishedAt ?? NOW,
        updatedAt: remote.updatedAt,
      }
      recordReceipt(200, ack)
      return finish(apiJson(200, ack))
    }
    return finish(apiError(422, "SCHEMA_INVALID"))
  }

  if (request.method() === "DELETE") {
    const body = postBody()
    if (body["expectedRevision"] !== remote.revision) {
      return finish(apiError(409, "REVISION_CONFLICT", { revision: remote.revision }))
    }
    fake.remotes.delete(remote.shareId)
    recordReceipt(204)
    return finish({ status: 204 })
  }
  return finish(apiError(405, "METHOD_NOT_ALLOWED"))
}

type Launched = {
  readonly context: BrowserContext
  readonly worker: Worker
  readonly extensionId: string
  readonly fake: Fake
  readonly netLog: { url: string; method: string; headers: Record<string, string>; body: string }[]
  /** Mints alternating synthetic share ids/secrets for successive creates. */
  mint: () => [string, string]
}

async function launchFailureRig(
  testInfo: TestInfo,
  seed: Parameters<typeof v2State>[0],
  extra: Record<string, unknown> = {},
): Promise<Launched> {
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    ...browserLaunchTarget(),
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  })
  const netLog: Launched["netLog"] = []
  // Global capture for the sentinel audit: every request from any page or
  // service worker in this context — URLs, headers and bodies.
  context.on("request", (request) => {
    netLog.push({
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      body: request.postData() ?? "",
    })
  })
  const fake: Fake = { remotes: new Map(), ops: new Map(), apiLog: [], policy: () => "normal" }
  let mintIndex = 0
  const mintTable: [string, string][] = [
    [SHARE_ID_A, SECRET_A],
    [SHARE_ID_B, SECRET_B],
    [PARENT_ID, SECRET_PARENT],
  ]
  const mint = (): [string, string] => mintTable[mintIndex++ % mintTable.length] as [string, string]
  await context.route(/^https?:\/\//, (route) => route.abort())
  await context.route(/\/api\/v1\/playlists/, (route) => handleShareApi(route, fake, mint))
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 10_000 }))
  await worker.evaluate(`(async () => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set({ dop_v2_state: ${JSON.stringify(v2State(seed))} })
  })()`)
  if (Object.keys(extra).length > 0) {
    await worker.evaluate(`chrome.storage.local.set(${JSON.stringify(extra)})`)
  }
  const extensionId = new URL(worker.url()).hostname
  return { context, worker, extensionId, fake, netLog, mint }
}

/** Options page: the privileged sender for share-manage-* messages. */
async function openOptions(rig: Launched) {
  const page = await rig.context.newPage()
  await page.goto(`chrome-extension://${rig.extensionId}/options.html`)
  await expect(page.locator("body")).toBeAttached({ timeout: 15_000 })
  return page
}

/** Sends a share-manage-* message from an extension page; returns the reply. */
function manage(page: { evaluate: (arg: string) => Promise<unknown> }, message: unknown) {
  return page.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`) as Promise<
    Record<string, unknown> | undefined
  >
}

type VaultShape = {
  revision: number
  playlists: { id: string; name: string; items: unknown[] }[]
  publications: {
    shareId: string
    localPlaylistId: string | null
    manageSecret: string
    revision: number
    state: string
    sentSnapshot?: string
  }[]
  pendingCreates: { operationId: string; idempotencyKey: string; payloadHash: string }[]
}

function readVault(worker: Worker): Promise<VaultShape> {
  return worker.evaluate(
    `chrome.storage.local.get("dop_v2_state").then((r) => r.dop_v2_state)`,
  ) as Promise<VaultShape>
}

function readVaultViaPage(page: {
  evaluate: (arg: string) => Promise<unknown>
}): Promise<VaultShape> {
  return page.evaluate(
    `chrome.storage.local.get("dop_v2_state").then((r) => r.dop_v2_state)`,
  ) as Promise<VaultShape>
}

/** Kills the extension's service_worker target via real CDP — the abrupt
 *  equivalent of Chrome's idle suspension, mid-flow. */
async function killExtensionServiceWorker(
  context: BrowserContext,
  pageUrl: string,
): Promise<string> {
  const page = context.pages().find((p) => p.url() === pageUrl) ?? (await context.newPage())
  const cdp = await context.newCDPSession(page)
  const targets = new Map<string, { targetId: string; type: string; url: string }>()
  cdp.on("Target.targetCreated", ({ targetInfo }) => targets.set(targetInfo.targetId, targetInfo))
  cdp.on("Target.targetInfoChanged", ({ targetInfo }) =>
    targets.set(targetInfo.targetId, targetInfo),
  )
  cdp.on("Target.targetDestroyed", ({ targetId }) => targets.delete(targetId))
  await cdp.send("Target.setDiscoverTargets", { discover: true })
  const sw = [...targets.values()].find(
    (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"),
  )
  if (sw === undefined) throw new Error("extension service_worker target not found")
  await cdp.send("Target.closeTarget", { targetId: sw.targetId })
  return sw.targetId
}

// ---------------------------------------------------------------------------
// Dropped responses across the whole mutation surface.

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("dropped create response: pendingCreate durable, replay is receipt-unavailable, fresh attempt publishes exactly once", async ({}, testInfo) => {
  const rig = await launchFailureRig(testInfo, {
    playlists: [
      { id: "pl-1", name: "E2E Share", items: [item("a", "p1", "1"), item("b", "p2", "2")] },
    ],
  })
  try {
    const page = await openOptions(rig)
    const opId = crypto.randomUUID()
    // The server processed the create (remote + receipt exist) but the
    // response never reached the client.
    rig.fake.policy = (method) => (method === "POST" ? "drop" : "normal")
    const lost = await manage(page, {
      kind: "share-manage-publish",
      operationId: opId,
      playlistId: "pl-1",
      metadata: { visibility: "public" },
    })
    expect(lost?.["status"]).toBe("offline")
    rig.fake.policy = () => "normal"
    // Server truth: the provisional remote EXISTS — the attempt is not free.
    expect(rig.fake.remotes.has(SHARE_ID_A)).toBe(true)
    expect(rig.fake.remotes.get(SHARE_ID_A)?.state).toBe("pending")
    // Local truth: durable pendingCreate, zero publications, playlist intact.
    let vault = await readVault(rig.worker)
    expect(vault.publications).toEqual([])
    expect(vault.pendingCreates).toHaveLength(1)
    expect(vault.pendingCreates[0]?.operationId).toBe(opId)
    expect(vault.playlists).toHaveLength(1)

    // Same-attempt retry reuses the durable idempotency key — the server
    // cannot re-emit the plaintext secret, so the attempt must be abandoned,
    // never double-published.
    const replay = await manage(page, {
      kind: "share-manage-publish",
      operationId: opId,
      playlistId: "pl-1",
      metadata: { visibility: "public" },
    })
    expect(replay?.["status"]).toBe("receipt-unavailable")
    vault = await readVault(rig.worker)
    expect(vault.pendingCreates).toEqual([])
    expect(vault.publications).toEqual([])
    expect(rig.fake.remotes.size).toBe(1) // still only the orphan provisional

    // A NEW attempt (new operation id) publishes cleanly — and is the only
    // locally managed publication.
    const fresh = await manage(page, {
      kind: "share-manage-publish",
      operationId: crypto.randomUUID(),
      playlistId: "pl-1",
      metadata: { visibility: "public" },
    })
    expect(fresh?.["status"]).toBe("published")
    expect(fresh?.["shareId"]).toBe(SHARE_ID_B)
    vault = await readVault(rig.worker)
    expect(vault.publications).toHaveLength(1)
    expect(vault.publications[0]).toMatchObject({
      shareId: SHARE_ID_B,
      manageSecret: SECRET_B,
      revision: 2,
      state: "active",
    })
    // The orphan provisional stays server-side-pending (unreadable publicly,
    // lazy-expired) — never a second managed publication locally.
    expect(rig.fake.remotes.get(SHARE_ID_A)?.state).toBe("pending")
    expect(vault.playlists[0]?.items).toHaveLength(2)
  } finally {
    await rig.context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("dropped activate response: key persisted before activation, retry completes the same transition", async ({}, testInfo) => {
  const rig = await launchFailureRig(testInfo, {
    playlists: [{ id: "pl-1", name: "E2E Share", items: [item("a", "p1", "1")] }],
  })
  try {
    const page = await openOptions(rig)
    rig.fake.policy = (method) => (method === "PATCH" ? "drop" : "normal")
    const lost = await manage(page, {
      kind: "share-manage-publish",
      operationId: crypto.randomUUID(),
      playlistId: "pl-1",
      metadata: { visibility: "public" },
    })
    expect(lost?.["status"]).toBe("activate-pending")
    expect(lost?.["shareId"]).toBe(SHARE_ID_A)
    rig.fake.policy = () => "normal"
    // The capability was durably persisted BEFORE activation — the retry is safe.
    const vault = await readVault(rig.worker)
    expect(vault.publications).toHaveLength(1)
    expect(vault.publications[0]).toMatchObject({
      shareId: SHARE_ID_A,
      manageSecret: SECRET_A,
      revision: 1,
      state: "pending",
    })
    // Server already applied the transition; the client just never heard it.
    expect(rig.fake.remotes.get(SHARE_ID_A)?.state).toBe("active")

    const retried = await manage(page, {
      kind: "share-manage-activate",
      shareId: SHARE_ID_A,
      operationId: crypto.randomUUID(),
    })
    expect(retried?.["status"]).toBe("activated")
    const after = await readVault(rig.worker)
    expect(after.publications[0]).toMatchObject({ revision: 2, state: "active" })
    // Exactly one remote transition — the repeat-activate did not bump again.
    expect(rig.fake.remotes.get(SHARE_ID_A)?.revision).toBe(2)
  } finally {
    await rig.context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("dropped update response: same-key retry replays the recorded ack — one remote effect, honest local state", async ({}, testInfo) => {
  const rig = await launchFailureRig(testInfo, {
    playlists: [
      { id: "pl-1", name: "E2E Share", items: [item("a", "p1", "1"), item("b", "p2", "2")] },
    ],
    publications: [activeRecord()],
  })
  rig.fake.remotes.set(SHARE_ID_A, {
    shareId: SHARE_ID_A,
    secret: SECRET_A,
    revision: 2,
    state: "active",
    playlist: JSON.parse(String(activeRecord()["sentSnapshot"])) as Record<string, unknown>,
    contentHash: "a".repeat(64),
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: NOW,
  })
  try {
    const page = await openOptions(rig)
    const opId = crypto.randomUUID()
    rig.fake.policy = (method) => (method === "PATCH" ? "drop" : "normal")
    const lost = await manage(page, {
      kind: "share-manage-update",
      shareId: SHARE_ID_A,
      operationId: opId,
    })
    expect(lost?.["status"]).toBe("offline")
    rig.fake.policy = () => "normal"
    // Remote advanced to revision 3; the local record honestly stayed at 2 —
    // acknowledged state is never advanced without a confirmed ack.
    expect(rig.fake.remotes.get(SHARE_ID_A)?.revision).toBe(3)
    let vault = await readVault(rig.worker)
    expect(vault.publications[0]?.revision).toBe(2)

    // Same-operation retry replays the ORIGINAL recorded ack — no second
    // revision bump, no partial mutation.
    const retried = await manage(page, {
      kind: "share-manage-update",
      shareId: SHARE_ID_A,
      operationId: opId,
    })
    expect(retried?.["status"]).toBe("updated")
    expect(retried?.["revision"]).toBe(3)
    vault = await readVault(rig.worker)
    expect(vault.publications[0]?.revision).toBe(3)
    expect(rig.fake.remotes.get(SHARE_ID_A)?.revision).toBe(3)
    expect(vault.playlists[0]?.items).toHaveLength(2)
  } finally {
    await rig.context.close()
  }
})

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("dropped delete response: local capability is never discarded without a confirmed outcome", async ({}, testInfo) => {
  const rig = await launchFailureRig(testInfo, {
    playlists: [{ id: "pl-1", name: "E2E Share", items: [item("a", "p1", "1")] }],
    publications: [activeRecord()],
  })
  rig.fake.remotes.set(SHARE_ID_A, {
    shareId: SHARE_ID_A,
    secret: SECRET_A,
    revision: 2,
    state: "active",
    playlist: JSON.parse(String(activeRecord()["sentSnapshot"])) as Record<string, unknown>,
    contentHash: "a".repeat(64),
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: NOW,
  })
  try {
    const page = await openOptions(rig)
    const opId = crypto.randomUUID()
    rig.fake.policy = (method) => (method === "DELETE" ? "drop" : "normal")
    const lost = await manage(page, {
      kind: "share-manage-delete",
      shareId: SHARE_ID_A,
      operationId: opId,
    })
    expect(lost?.["status"]).toBe("offline")
    rig.fake.policy = () => "normal"
    // Remote is gone; the local capability survives — an unconfirmed delete
    // must never strand a remote the user can no longer manage.
    expect(rig.fake.remotes.has(SHARE_ID_A)).toBe(false)
    let vault = await readVault(rig.worker)
    expect(vault.publications).toHaveLength(1)

    // Replayed receipt: the same operation completes as "deleted" (204 replay).
    const retried = await manage(page, {
      kind: "share-manage-delete",
      shareId: SHARE_ID_A,
      operationId: opId,
    })
    expect(retried?.["status"]).toBe("deleted")
    vault = await readVault(rig.worker)
    expect(vault.publications).toEqual([])
    expect(vault.playlists).toHaveLength(1) // local copy survives
  } finally {
    await rig.context.close()
  }
})

// ---------------------------------------------------------------------------
// Offline management: honest failures, durable state, explicit reconcile.

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("offline management: operations fail honestly, nothing half-persists, reconnect reconciles", async ({}, testInfo) => {
  const rig = await launchFailureRig(testInfo, {
    playlists: [{ id: "pl-1", name: "E2E Share", items: [item("a", "p1", "1")] }],
    publications: [activeRecord()],
  })
  rig.fake.remotes.set(SHARE_ID_A, {
    shareId: SHARE_ID_A,
    secret: SECRET_A,
    revision: 2,
    state: "active",
    playlist: JSON.parse(String(activeRecord()["sentSnapshot"])) as Record<string, unknown>,
    contentHash: "a".repeat(64),
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: NOW,
  })
  try {
    const page = await openOptions(rig)
    // Idle worker: no automatic sync, zero remote traffic without user intent.
    await page.waitForTimeout(400)
    expect(rig.fake.apiLog).toEqual([])

    rig.fake.policy = () => "offline"
    const pub = await manage(page, {
      kind: "share-manage-publish",
      operationId: crypto.randomUUID(),
      playlistId: "pl-1",
      metadata: { visibility: "public" },
    })
    // pl-1 already has a publication — a second publish is an honest
    // invalid-state, not a network attempt.
    expect(pub?.["status"]).toBe("invalid-state")
    const upd = await manage(page, {
      kind: "share-manage-update",
      shareId: SHARE_ID_A,
      operationId: crypto.randomUUID(),
      metadata: { description: "offline edit" },
    })
    expect(upd?.["status"]).toBe("offline")
    const ins = await manage(page, { kind: "share-manage-inspect", shareId: SHARE_ID_A })
    expect(ins?.["remote"]).toBe("unknown")
    const del = await manage(page, {
      kind: "share-manage-delete",
      shareId: SHARE_ID_A,
      operationId: crypto.randomUUID(),
    })
    expect(del?.["status"]).toBe("offline")

    // Nothing half-persisted: record + key intact, no remote touched.
    const vault = await readVault(rig.worker)
    expect(vault.publications).toHaveLength(1)
    expect(vault.publications[0]?.manageSecret).toBe(SECRET_A)
    expect(vault.publications[0]?.revision).toBe(2)
    expect(rig.fake.remotes.get(SHARE_ID_A)?.revision).toBe(2)

    // Reconnect: explicit inspect reconciles; update then succeeds.
    rig.fake.policy = () => "normal"
    const live = await manage(page, { kind: "share-manage-inspect", shareId: SHARE_ID_A })
    expect(live?.["remote"]).toBe("active")
    const updated = await manage(page, {
      kind: "share-manage-update",
      shareId: SHARE_ID_A,
      operationId: crypto.randomUUID(),
      metadata: { description: "reconnected edit" },
    })
    expect(updated?.["status"]).toBe("updated")
    expect(updated?.["revision"]).toBe(3)
    expect(rig.fake.remotes.get(SHARE_ID_A)?.revision).toBe(3)
  } finally {
    await rig.context.close()
  }
})

// ---------------------------------------------------------------------------
// Storage writer stop: kill the SW mid-flight, prove the durable record.

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("service-worker kill mid-publish: durable vault record survives, fresh worker completes activation", async ({}, testInfo) => {
  const rig = await launchFailureRig(testInfo, {
    playlists: [{ id: "pl-1", name: "E2E Share", items: [item("a", "p1", "1")] }],
  })
  try {
    const page = await openOptions(rig)
    // PATCH hangs forever — the publish flow is parked between "secret
    // persisted" and "activate acknowledged" when the worker dies.
    rig.fake.policy = (method) => (method === "PATCH" ? "hang" : "normal")
    const publishPromise = manage(page, {
      kind: "share-manage-publish",
      operationId: crypto.randomUUID(),
      playlistId: "pl-1",
      metadata: { visibility: "public" },
    }).then(
      (reply) => reply,
      () => "sendMessage-rejected" as const,
    )
    // Wait until the activate PATCH actually left the worker.
    await expect
      .poll(() => rig.fake.apiLog.filter((call) => call.method === "PATCH").length, {
        timeout: 10_000,
      })
      .toBe(1)
    await killExtensionServiceWorker(rig.context, page.url())
    // The hang policy lives in the Node-side route handler, not the dead
    // worker — disarm it so the fresh worker's retry can actually complete.
    rig.fake.policy = () => "normal"
    // The in-flight publish can never answer — the worker that held it is gone.
    const outcome = await Promise.race([
      publishPromise,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5_000)),
    ])
    expect(["hung", "sendMessage-rejected"]).toContain(outcome)

    // Any real message wakes a fresh worker; activate completes the pending
    // publication that was durably recorded BEFORE the kill.
    const retried = await manage(page, {
      kind: "share-manage-activate",
      shareId: SHARE_ID_A,
      operationId: crypto.randomUUID(),
    })
    expect(retried?.["status"]).toBe("activated")

    const vault = await readVaultViaPage(page)
    expect(vault.playlists).toHaveLength(1)
    expect(vault.publications).toHaveLength(1)
    // A complete, well-formed record — no torn/partial vault write exists.
    expect(vault.publications[0]).toMatchObject({
      shareId: SHARE_ID_A,
      localPlaylistId: "pl-1",
      manageSecret: SECRET_A,
      revision: 2,
      state: "active",
    })
    for (const entry of vault.pendingCreates) {
      expect(entry.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    }
    expect(rig.fake.remotes.get(SHARE_ID_A)?.state).toBe("active")
  } finally {
    await rig.context.close()
  }
})

// ---------------------------------------------------------------------------
// Sentinel-secret exfiltration audit across every observable surface.

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("sentinel manage secret: leaves the extension only as Bearer to the fixed API origin", async ({}, testInfo) => {
  const rig = await launchFailureRig(testInfo, {
    playlists: [{ id: "pl-1", name: "E2E Share", items: [item("a", "p1", "1")] }],
    publications: [activeRecord({ manageSecret: SENTINEL })],
  })
  rig.fake.remotes.set(SHARE_ID_A, {
    shareId: SHARE_ID_A,
    secret: SENTINEL,
    revision: 2,
    state: "active",
    playlist: JSON.parse(String(activeRecord()["sentSnapshot"])) as Record<string, unknown>,
    contentHash: "a".repeat(64),
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: NOW,
  })
  try {
    const page = await openOptions(rig)
    const consoleLines: string[] = []
    page.on("console", (message) => consoleLines.push(message.text()))
    // Drive the full management surface: inspect (GET), update (PATCH),
    // delete (DELETE) — every one crosses the real network boundary.
    const inspect = await manage(page, { kind: "share-manage-inspect", shareId: SHARE_ID_A })
    expect(inspect?.["remote"]).toBe("active")
    const updated = await manage(page, {
      kind: "share-manage-update",
      shareId: SHARE_ID_A,
      operationId: crypto.randomUUID(),
      metadata: { description: "sentinel update" },
    })
    expect(updated?.["status"]).toBe("updated")
    const deleted = await manage(page, {
      kind: "share-manage-delete",
      shareId: SHARE_ID_A,
      operationId: crypto.randomUUID(),
    })
    expect(deleted?.["status"]).toBe("deleted")

    // Global netLog: the sentinel appears ONLY as the Authorization value on
    // PATCH/DELETE to the fixed API origin — never in a URL, body, or any
    // other header, and never on any other request.
    for (const request of rig.netLog) {
      const auth = request.headers["authorization"]
      const url = new URL(request.url)
      if (request.url.includes(SENTINEL)) {
        throw new Error(`sentinel in URL: ${request.url}`)
      }
      if (request.body.includes(SENTINEL)) {
        throw new Error(`sentinel in request body: ${request.method} ${request.url}`)
      }
      for (const [name, value] of Object.entries(request.headers)) {
        if (name !== "authorization" && value.includes(SENTINEL)) {
          throw new Error(`sentinel in header ${name}: ${request.method} ${request.url}`)
        }
      }
      if (auth?.includes(SENTINEL)) {
        expect(url.origin).toBe(SHARE_ORIGIN)
        expect(["PATCH", "DELETE"]).toContain(request.method)
      }
      // No non-extension http(s) request escaped the synthetic origin at all.
      if (url.protocol.startsWith("http")) {
        expect(url.origin).toBe(SHARE_ORIGIN)
      }
    }
    // The replies themselves never carried the secret.
    for (const reply of [inspect, updated, deleted]) {
      expect(JSON.stringify(reply)).not.toContain(SENTINEL)
    }
    // DOM and console surfaces stay clean.
    expect(await page.content()).not.toContain(SENTINEL)
    for (const line of consoleLines) expect(line).not.toContain(SENTINEL)
    // API log: exactly the management calls, Bearer only on PATCH/DELETE.
    const authed = rig.fake.apiLog.filter((call) => call.auth !== undefined)
    for (const call of authed) {
      expect(call.auth).toBe(`Bearer ${SENTINEL}`)
      expect(["PATCH", "DELETE"]).toContain(call.method)
    }
  } finally {
    await rig.context.close()
  }
})

// ---------------------------------------------------------------------------
// Receiver spoofing: non-options senders, forged relays, malformed frames.

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("management receiver spoofing: non-options senders get forbidden; relays with mismatched shareId are rejected", async ({}, testInfo) => {
  const rig = await launchFailureRig(testInfo, {
    playlists: [{ id: "pl-1", name: "E2E Share", items: [item("a", "p1", "1")] }],
    publications: [activeRecord()],
  })
  rig.fake.remotes.set(SHARE_ID_A, {
    shareId: SHARE_ID_A,
    secret: SECRET_A,
    revision: 2,
    state: "active",
    playlist: JSON.parse(String(activeRecord()["sentSnapshot"])) as Record<string, unknown>,
    contentHash: "a".repeat(64),
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: NOW,
  })
  try {
    const inspect = { kind: "share-manage-inspect", shareId: SHARE_ID_A }
    // Control: the options page itself is honored.
    const options = await openOptions(rig)
    const ok = await manage(options, inspect)
    expect(ok?.["status"]).toBe("inspect")

    // Any OTHER extension surface is forbidden — import.html and popup.html.
    for (const pageName of ["import.html", "popup.html"]) {
      const surface = await rig.context.newPage()
      await surface.goto(`chrome-extension://${rig.extensionId}/${pageName}`)
      await expect(surface.locator("body")).toBeAttached()
      const reply = await manage(surface, inspect)
      expect(reply?.["status"]).toBe("forbidden")
      await surface.close()
    }

    // A nested options iframe (sender.url matches but frameId !== 0) is
    // forbidden too — an injected frame inside the privileged page cannot
    // drive management. Drive the nested frame via Playwright's frame handle
    // so its own chrome.runtime.sendMessage is what is measured.
    await options.evaluate(`(async () => {
      const iframe = document.createElement("iframe")
      iframe.src = "options.html"
      await new Promise((resolve) => {
        iframe.onload = resolve
        document.body.appendChild(iframe)
      })
    })()`)
    const nested = options
      .frames()
      .find((frame) => frame !== options.mainFrame() && frame.url().endsWith("/options.html"))
    expect(nested).toBeDefined()
    if (nested !== undefined) {
      const innerReply = await manage(nested, inspect)
      expect(innerReply?.["status"]).toBe("forbidden")
    }

    // Malformed management frames parse to nothing: sendMessage resolves
    // undefined and never reaches a flow.
    for (const malformed of [
      { kind: "share-manage-inspect" }, // missing shareId
      { kind: "share-manage-inspect", shareId: "not-a-share-id" },
      { kind: "share-manage-delete", shareId: SHARE_ID_A, operationId: "not-uuid" },
      { kind: "share-manage-publish", operationId: crypto.randomUUID(), playlistId: "pl-1" },
      { kind: "totally-unknown", shareId: SHARE_ID_A },
    ]) {
      const reply = await manage(options, malformed)
      expect(reply).toBeUndefined()
    }

    // Forged relay: a share page whose save button claims a DIFFERENT shareId
    // than the page URL — the background re-derives the id from the tab URL
    // and rejects the mismatch before any fetch.
    await rig.context.route(`${SHARE_ORIGIN}/p/*`, (route) => {
      const id = route.request().url().split("/").pop() ?? ""
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body>
          <button data-share-save data-share-id="e2eForgedShareId000001" disabled
            data-testid="save-open-button">open</button>
          <p data-share-save-status data-testid="save-status"></p>
          <script src="/share-page.js" defer></script>
          <script>document.title=${JSON.stringify(`forged-${id}`)}</script>
        </body></html>`,
      })
    })
    await rig.context.route(`${SHARE_ORIGIN}/share-page.js`, async (route) => {
      const fs = await import("node:fs")
      return route.fulfill({
        status: 200,
        contentType: "text/javascript; charset=utf-8",
        body: fs.readFileSync(path.resolve("apps/web/public/share-page.js")),
      })
    })
    const sharePage = await rig.context.newPage()
    await sharePage.goto(`${SHARE_ORIGIN}/p/${SHARE_ID_B}`)
    await expect(sharePage.locator("[data-testid='save-open-button']")).toBeEnabled({
      timeout: 10_000,
    })
    const apiBefore = rig.fake.apiLog.length
    await sharePage.locator("[data-testid='save-open-button']").click()
    await expect(sharePage.locator("[data-testid='save-status']")).toContainText(
      "受け付けられませんでした",
      { timeout: 10_000 },
    )
    // No confirmation window, no fetch for the forged id.
    await sharePage.waitForTimeout(400)
    expect(rig.fake.apiLog.length).toBe(apiBefore)
    expect(
      rig.context.pages().filter((candidate) => candidate.url().includes("/import.html")),
    ).toHaveLength(0)
  } finally {
    await rig.context.close()
  }
})

// ---------------------------------------------------------------------------
// Hidden-source relationship: parent visibility decides public lineage.

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("hidden-source republish: public parent links derivedFrom; hidden parent withholds it publicly but keeps local provenance", async ({}, testInfo) => {
  const provenance = (playlistId: string) => ({
    schemaVersion: 1,
    records: [
      {
        playlistId,
        shareId: PARENT_ID,
        revision: 2,
        contentHash: "c".repeat(64),
        title: "Parent Share",
        itemCount: 1,
        importedAt: NOW,
      },
    ],
  })
  const rig = await launchFailureRig(
    testInfo,
    {
      playlists: [
        { id: "pl-1", name: "Child One", items: [item("a", "p1", "1")] },
        { id: "pl-2", name: "Child Two", items: [item("b", "p2", "2")] },
      ],
    },
    {
      dop_v2_imports: {
        schemaVersion: 1,
        records: [...provenance("pl-1").records, ...provenance("pl-2").records],
      },
    },
  )
  // Parent remote exists and is public/active.
  rig.fake.remotes.set(PARENT_ID, {
    shareId: PARENT_ID,
    secret: SECRET_PARENT,
    revision: 2,
    state: "active",
    playlist: {
      schemaVersion: 1,
      title: "Parent Share",
      description: "",
      author: "",
      tags: [],
      visibility: "public",
      items: [
        {
          partId: "pp",
          title: "Parent Work",
          episodeTitle: "Ep",
          range: { start: 0, end: 90_000, name: "OP" },
        },
      ],
    },
    contentHash: "c".repeat(64),
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: NOW,
  })
  try {
    const page = await openOptions(rig)
    // Publish pl-1 while the parent is public — the source check GETs the
    // parent and attaches derivedFrom to the outgoing snapshot.
    const linked = await manage(page, {
      kind: "share-manage-publish",
      operationId: crypto.randomUUID(),
      playlistId: "pl-1",
      metadata: { visibility: "public" },
    })
    expect(linked?.["status"]).toBe("published")
    expect(linked?.["sourceState"]).toBe("linked")
    const createPost = rig.fake.apiLog.findLast((call) => call.method === "POST")
    expect(createPost?.body).toContain(`"derivedFrom"`)
    expect(createPost?.body).toContain(PARENT_ID)

    // Hide the parent (remote takedown/delete) — a fresh publish of the
    // second imported copy must withhold lineage from the PUBLIC payload.
    rig.fake.remotes.delete(PARENT_ID)
    const withheld = await manage(page, {
      kind: "share-manage-publish",
      operationId: crypto.randomUUID(),
      playlistId: "pl-2",
      metadata: { visibility: "public" },
    })
    expect(withheld?.["status"]).toBe("published")
    expect(withheld?.["sourceState"]).toBe("withheld")
    const secondPost = rig.fake.apiLog.findLast((call) => call.method === "POST")
    expect(secondPost?.body).not.toContain("derivedFrom")
    expect(secondPost?.body).not.toContain(PARENT_ID)
    // The remote snapshot the server would serve carries no lineage either.
    const childRemote = rig.fake.remotes.get(SHARE_ID_B)
    expect(childRemote).toBeDefined()
    expect("derivedFrom" in (childRemote?.playlist ?? {})).toBe(false)

    // Private provenance survives intact — the link is hidden publicly, not
    // destroyed locally.
    const imports = (await rig.worker.evaluate(
      `chrome.storage.local.get("dop_v2_imports").then((r) => r.dop_v2_imports)`,
    )) as { records: { playlistId: string; shareId: string }[] }
    expect(imports.records).toHaveLength(2)
    expect(imports.records.map((record) => record.shareId)).toEqual([PARENT_ID, PARENT_ID])
  } finally {
    await rig.context.close()
  }
})

// ---------------------------------------------------------------------------
// Stream byte cap: oversized share response is bounded mid-stream.

// biome-ignore lint/correctness/noEmptyPattern: playwright requires object destructuring for fixtures
test("share response byte cap: oversized streamed body is rejected without partial import", async ({}, testInfo) => {
  const streamId = "e2eStreamShareId000001" // 22 chars
  // Seed BEFORE launch: the repository caches vault state at first init, so a
  // post-launch raw storage.set would be invisible to the flow.
  const rig = await launchFailureRig(testInfo, {
    playlists: [],
    publications: [activeRecord({ shareId: streamId, localPlaylistId: null })],
  })
  const shared = {
    shareId: streamId,
    revision: 2,
    publishedAt: NOW,
    updatedAt: NOW,
    contentHash: "d".repeat(64),
    playlist: {
      schemaVersion: 1,
      title: "Oversized",
      description: "",
      author: "",
      tags: [],
      visibility: "public",
      items: [
        {
          partId: "p1",
          title: "Work",
          episodeTitle: "Ep",
          range: { start: 0, end: 90_000, name: "OP" },
        },
      ],
    },
    itemCount: 1,
    totalDurationMs: 90_000,
    importCount: 0,
    source: null,
  }
  // A body that streams past SHARE_REQUEST_BODY_MAX_BYTES (256 KiB) while
  // declaring a tiny Content-Length — the streamed counter, not the header
  // shortcut, is what must stop the read.
  const oversizedBody = `{"data":${JSON.stringify(shared).slice(0, -1)},"pad":"${"x".repeat(300_000)}"}`
  await rig.context.route(`${SHARE_ORIGIN}/api/v1/playlists/${streamId}`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-length": "128" },
      contentType: "application/json",
      body: oversizedBody,
    }),
  )
  try {
    const page = await openOptions(rig)
    // Drive the public GET through the real management inspect path — the
    // same api-client stream reader the import preview uses. The dedicated
    // route above (registered last) shadows the generic contract route and
    // serves the lying-length oversized body.
    const inspect = await manage(page, { kind: "share-manage-inspect", shareId: streamId })
    // Bounded outcome: remote state is "unknown" (the oversized body never
    // became data) — and no playlist/publication state was partially written.
    expect(inspect?.["remote"]).toBe("unknown")
    const vault = await readVault(rig.worker)
    expect(vault.playlists).toEqual([])
    expect(vault.publications[0]?.revision).toBe(2) // untouched by the failure
  } finally {
    await rig.context.close()
  }
})
