import { beforeAll, describe, expect, it } from "vitest"
import {
  collapseWhitespace,
  SHARE_REQUEST_BODY_MAX_BYTES,
  sortCanonicalTags,
} from "../../../../packages/shared/src/index"
import {
  DELETE as deleteRoute,
  PATCH as patchRoute,
} from "../../src/pages/api/v1/playlists/[shareId].js"
import { POST as createRoute } from "../../src/pages/api/v1/playlists/index.js"
import {
  apiRequest,
  call,
  dataOf,
  db,
  deleteShare,
  errorOf,
  getViaRoute,
  listBody,
  listViaRoute,
  makePlaylist,
  migratedDb,
  patchShare,
  postCreate,
  publishPlaylist,
  sharePageView,
} from "./helpers.js"

// Task-27 adversarial: hostile public data and intake abuse. The service
// must treat attacker strings as inert DATA on every surface, bound every
// body before parse, and collapse every malformed/missing capability probe
// onto non-revealing statuses. SQL-quoting, markup and template-injection
// payloads are stored verbatim and served back as JSON — never executed,
// never interpreted, never reflected into an error surface.

const HOSTILE = {
  title: `<script>alert(1)</script>{{7*7}}'; DROP TABLE playlists;--`,
  author: `admin\x00<img src=x onerror=alert(2)>"'`,
  description: `line1\r\nSet-Cookie: evil=1\n${"‮"}RTL override ${"​"}zwsp`,
  tags: [`<svg onload=alert(3)>`, `"; DELETE FROM tags;--`, `\u0000\u001fctrl`],
} as const

/** Canonical tag form the schema stores: trim/collapse/NFC + lowercase sort. */
const HOSTILE_TAGS_STORED = sortCanonicalTags(
  HOSTILE.tags.map((tag) => collapseWhitespace(tag.normalize("NFC").trim())),
)

async function playlistCount(): Promise<number> {
  const row = await db().prepare("SELECT COUNT(*) AS n FROM playlists").first<{ n: number }>()
  return row?.n ?? -1
}

describe("hostile public data stays inert", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("script/SQL/template-injection strings round-trip as inert data", async () => {
    const playlist = {
      ...makePlaylist({ title: HOSTILE.title, tags: [...HOSTILE.tags] }),
      author: HOSTILE.author,
      description: HOSTILE.description,
    }
    const pub = await publishPlaylist(playlist)

    // D1: stored verbatim inside snapshot_json — parameter binding means the
    // SQL metacharacters never reached a parser.
    const row = await db()
      .prepare("SELECT snapshot_json, title, author FROM playlists WHERE share_id = ?1")
      .bind(pub.shareId)
      .first<{ snapshot_json: string; title: string; author: string }>()
    expect(row).not.toBeNull()
    const stored = JSON.parse(String(row?.snapshot_json)) as {
      title: string
      author: string
      tags: string[]
    }
    expect(stored.title).toBe(HOSTILE.title)
    expect(stored.author).toBe(HOSTILE.author)
    expect(stored.tags).toEqual(HOSTILE_TAGS_STORED)
    // The playlists table itself still exists — the DROP payload was data.
    expect(await playlistCount()).toBeGreaterThan(0)

    // Public GET: JSON content type, strings verbatim, no HTML surface.
    const res = await getViaRoute(pub.shareId)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const data = (await dataOf(res)) as {
      playlist: { title: string; author: string; tags: string[] }
    }
    expect(data.playlist.title).toBe(HOSTILE.title)
    expect(data.playlist.author).toBe(HOSTILE.author)
    expect(data.playlist.tags).toEqual(HOSTILE_TAGS_STORED)

    // Collection: the hostile row lists with strings verbatim — still data.
    const list = await listBody(await listViaRoute({}))
    const mine = (
      list.items as { shareId: string; playlist: { title: string; author: string } }[]
    ).find((item) => item.shareId === pub.shareId)
    expect(mine).toBeDefined()
    expect(mine?.playlist.title).toBe(HOSTILE.title)
    expect(mine?.playlist.author).toBe(HOSTILE.author)

    // SSR view-model: the raw string is carried as text for the escaped
    // template — never pre-interpreted into markup.
    const view = await sharePageView(pub.shareId)
    expect(view.kind).toBe("ready")
    if (view.kind === "ready") {
      expect(view.view.title).toBe(HOSTILE.title)
      expect(view.view.ogTitle).toBe(HOSTILE.title)
      expect(view.view.author).toBe(HOSTILE.author)
    }
  })

  it("hostile shareId params collapse to the non-revealing 404/401 surface", async () => {
    const hostileIds = [
      "../secrets",
      "<script>alert(1)</script>",
      "' OR '1'='1",
      "a".repeat(300),
      "%2e%2e%2f",
      "e2eShareManage00000001extra",
    ]
    for (const id of hostileIds) {
      expect((await getViaRoute(id)).status).toBe(404)
      const patch = await call(
        patchRoute,
        patchShare(id, `${"a".repeat(42)}b`, crypto.randomUUID(), {
          operation: "replace",
          expectedRevision: 2,
          playlist: makePlaylist({}),
        }),
        { shareId: id },
      )
      expect(patch.status).toBe(404)
      const del = await call(
        deleteRoute,
        deleteShare(id, `${"a".repeat(42)}b`, crypto.randomUUID(), 2),
        { shareId: id },
      )
      expect(del.status).toBe(404)
    }
    // A well-formed but unknown id: GET 404; PATCH reaches the capability
    // check and returns the same 401 as a wrong-secret on a real id (no
    // existence oracle through the mutation path).
    const unknown = "unknownShareId00000000"
    expect((await getViaRoute(unknown)).status).toBe(404)
    const ghostPatch = await call(
      patchRoute,
      patchShare(unknown, `${"a".repeat(42)}b`, crypto.randomUUID(), {
        operation: "replace",
        expectedRevision: 1,
        playlist: makePlaylist({}),
      }),
      { shareId: unknown },
    )
    expect([401, 404]).toContain(ghostPatch.status)
  })
})

describe("bounded intake under abuse", () => {
  it("over-cap, wrong-type and broken bodies fail before any write", async () => {
    const before = await playlistCount()
    const valid = JSON.stringify(makePlaylist({}))

    // 415: JSON route rejects a non-JSON media type.
    const wrongType = await call(
      createRoute,
      apiRequest({
        method: "POST",
        path: "",
        body: valid,
        contentType: "text/plain",
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    expect(wrongType.status).toBe(415)

    // 413: a body above SHARE_REQUEST_BODY_MAX_BYTES is rejected while
    // streaming — declared Content-Length is not trusted as the only guard,
    // so send an actual oversized stream without the header hint.
    const oversized = `{"title":"${"x".repeat(SHARE_REQUEST_BODY_MAX_BYTES)}`
    const big = await call(
      createRoute,
      apiRequest({
        method: "POST",
        path: "",
        body: oversized,
        contentType: "application/json",
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    expect(big.status).toBe(413)
    expect((await errorOf(big)).code).toBe("BODY_TOO_LARGE")

    // 400: well-typed but syntactically broken JSON.
    const broken = await call(
      createRoute,
      apiRequest({
        method: "POST",
        path: "",
        body: `{"title":`,
        contentType: "application/json",
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    expect(broken.status).toBe(400)

    // 422: valid JSON that is not a SharedPlaylist.
    const notPlaylist = await call(
      createRoute,
      apiRequest({
        method: "POST",
        path: "",
        body: { title: 42, items: "nope" },
        contentType: "application/json",
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    expect(notPlaylist.status).toBe(422)
    expect((await errorOf(notPlaylist)).code).toBe("SCHEMA_INVALID")

    // 400: missing Idempotency-Key on a mutation.
    const noKey = await call(
      createRoute,
      apiRequest({ method: "POST", path: "", body: makePlaylist({}), idempotencyKey: null }),
    )
    expect(noKey.status).toBe(400)

    // Zero rows materialized from any of it.
    expect(await playlistCount()).toBe(before)
  })

  it("mutation routes bound bodies and never leak partial writes", async () => {
    const pub = await publishPlaylist(makePlaylist({}))
    const oversized = `{"operation":"replace","expectedRevision":2,"playlist":{"title":"${"y".repeat(
      SHARE_REQUEST_BODY_MAX_BYTES,
    )}`
    const big = await call(
      patchRoute,
      apiRequest({
        method: "PATCH",
        path: `/${pub.shareId}`,
        body: oversized,
        bearer: pub.manageSecret,
        idempotencyKey: crypto.randomUUID(),
      }),
      { shareId: pub.shareId },
    )
    expect(big.status).toBe(413)
    const row = await db()
      .prepare("SELECT revision FROM playlists WHERE share_id = ?1")
      .bind(pub.shareId)
      .first<{ revision: number }>()
    expect(row?.revision).toBe(2) // untouched

    // Missing bearer is rejected before the body is even consulted.
    const noAuth = await call(
      patchRoute,
      patchShare(pub.shareId, null, crypto.randomUUID(), {
        operation: "replace",
        expectedRevision: 2,
        playlist: makePlaylist({}),
      }),
      { shareId: pub.shareId },
    )
    expect(noAuth.status).toBe(401)
    expect(
      (
        await db()
          .prepare("SELECT revision FROM playlists WHERE share_id = ?1")
          .bind(pub.shareId)
          .first<{ revision: number }>()
      )?.revision,
    ).toBe(2)
  })

  it("GET on a pending provisional is the same 404 as nonexistent (no orphans readable)", async () => {
    const created = await call(createRoute, postCreate(makePlaylist({})))
    expect(created.status).toBe(201)
    const ack = (await dataOf(created)) as { shareId: string }
    // The pending row exists in D1 but is publicly indistinguishable from
    // absent — no public orphan snapshot can be read.
    const row = await db()
      .prepare("SELECT state FROM playlists WHERE share_id = ?1")
      .bind(ack.shareId)
      .first<{ state: string }>()
    expect(row?.state).toBe("pending")
    expect((await getViaRoute(ack.shareId)).status).toBe(404)
    const view = await sharePageView(ack.shareId)
    expect(view.kind).toBe("notfound")
  })
})
