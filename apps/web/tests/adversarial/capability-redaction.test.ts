import { beforeAll, describe, expect, it, vi } from "vitest"
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "../../src/pages/api/v1/playlists/[shareId].js"
import { POST as createRoute } from "../../src/pages/api/v1/playlists/index.js"
import { manageSecretHash } from "../../src/server/security/capability.js"
import { loggedApiRequest } from "../../src/server/services/request-log.js"
import {
  activateShare,
  call,
  dataOf,
  db,
  deleteShare,
  flattenJson,
  getViaRoute,
  listBody,
  listViaRoute,
  makePlaylist,
  migratedDb,
  patchShare,
  postCreate,
  secureRequest,
  sharePageView,
  tagsViaRoute,
} from "./helpers.js"

// Task-27 adversarial: capability material must exist in exactly one place —
// the POST 201 acknowledgement — and nowhere else. The manageSecret travels
// back to the server only inside the Authorization header; its SHA-256
// verifier lives only in D1. This suite proves neither ever leaks onto a
// public/management surface (GET, collection, tags, /p/ view-model + OGP,
// PATCH/DELETE acks, error envelopes) and that the redacted request log can
// never record Authorization material, share ids, bodies or client IPs.

const SENTINEL_TITLE = "ADVERSARIAL-TITLE-aa31f0"

type CreateAck = { shareId: string; manageSecret: string; contentHash: string }

async function createPending(): Promise<CreateAck> {
  const created = await call(createRoute, postCreate(makePlaylist({ title: SENTINEL_TITLE })))
  expect(created.status).toBe(201)
  return (await dataOf(created)) as CreateAck
}

/** Every field/key/value of a decoded payload, serialized for substring scans. */
function flattened(payload: unknown): string {
  return flattenJson(payload).join("\n")
}

describe("capability redaction on every public/management surface", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("manageSecret appears only in the POST 201 ack — never its hash, never again", async () => {
    const ack = await createPending()
    const secretHash = await manageSecretHash(ack.shareId, ack.manageSecret)

    // The single lawful emission: the create ack carries the plaintext secret
    // exactly once and never carries the persisted verifier.
    const createAckJson = JSON.stringify(ack)
    expect(createAckJson).toContain(ack.manageSecret)
    expect(createAckJson).not.toContain(secretHash)
    expect(createAckJson).not.toContain("secret_hash")

    // Activate (Bearer over the wire) -> 200 ack carries no key material.
    const activated = await call(patchRoute, activateShare(ack.shareId, ack.manageSecret), {
      shareId: ack.shareId,
    })
    expect(activated.status).toBe(200)
    const patchAckJson = await activated.text()
    expect(patchAckJson).not.toContain(ack.manageSecret)
    expect(patchAckJson).not.toContain(secretHash)
    expect(flattened(JSON.parse(patchAckJson))).not.toContain(ack.manageSecret)
    expect(flattened(JSON.parse(patchAckJson))).not.toContain(secretHash)

    // Public GET — the snapshot read an attacker polls for leaked keys.
    const getRes = await getViaRoute(ack.shareId)
    expect(getRes.status).toBe(200)
    const getJson = await getRes.text()
    expect(getJson).not.toContain(ack.manageSecret)
    expect(getJson).not.toContain(secretHash)
    const getFlat = flattened(JSON.parse(getJson))
    expect(getFlat).not.toContain(ack.manageSecret)
    expect(getFlat).not.toContain(secretHash)
    expect(getFlat).not.toMatch(/secret|credential|bearer|authorization/i)

    // Collection listing — same scan over the whole page payload.
    const listRes = await listViaRoute({ q: SENTINEL_TITLE })
    expect(listRes.status).toBe(200)
    const list = await listBody(listRes)
    const listFlat = flattened(list)
    expect(listFlat).not.toContain(ack.manageSecret)
    expect(listFlat).not.toContain(secretHash)
    expect(listFlat).not.toMatch(/secret|credential|bearer|authorization/i)

    // Tag dictionary — a third public surface that must stay key-free.
    const tagsRes = await tagsViaRoute()
    expect(tagsRes.status).toBe(200)
    const tagsFlat = flattened(await tagsRes.json())
    expect(tagsFlat).not.toContain(ack.manageSecret)
    expect(tagsFlat).not.toContain(secretHash)

    // SSR /p/ view-model incl. OGP strings + share intent URL.
    const view = await sharePageView(ack.shareId)
    expect(view.kind).toBe("ready")
    const viewFlat = flattened(view)
    expect(viewFlat).not.toContain(ack.manageSecret)
    expect(viewFlat).not.toContain(secretHash)
    expect(viewFlat).not.toMatch(/secret|credential|bearer|authorization/i)

    // Replace ack + error envelopes — no echo of credentials either way.
    const replaced = await call(
      patchRoute,
      patchShare(ack.shareId, ack.manageSecret, crypto.randomUUID(), {
        operation: "replace",
        expectedRevision: 2,
        playlist: makePlaylist({ title: "ADVERSARIAL-replaced" }),
      }),
      { shareId: ack.shareId },
    )
    expect(replaced.status).toBe(200)
    const replaceJson = await replaced.text()
    expect(replaceJson).not.toContain(ack.manageSecret)
    expect(replaceJson).not.toContain(secretHash)

    const denied = await call(
      patchRoute,
      patchShare(ack.shareId, `${"z".repeat(42)}a`, crypto.randomUUID(), {
        operation: "replace",
        expectedRevision: 3,
        playlist: makePlaylist({}),
      }),
      { shareId: ack.shareId },
    )
    expect(denied.status).toBe(401)
    const deniedJson = await denied.text()
    expect(deniedJson).not.toContain(ack.manageSecret)
    expect(deniedJson).not.toContain(secretHash)
    // The 401 reveals no revision detail — existence/ownership stay opaque.
    expect(flattened(JSON.parse(deniedJson))).not.toContain("revision")

    // DELETE then proves the resource is gone without key leakage anywhere.
    const deleted = await call(
      deleteRoute,
      deleteShare(ack.shareId, ack.manageSecret, crypto.randomUUID(), 3),
      { shareId: ack.shareId },
    )
    expect(deleted.status).toBe(204)
    const after = await getViaRoute(ack.shareId)
    expect(after.status).toBe(404)
    const afterJson = await after.text()
    expect(afterJson).not.toContain(ack.manageSecret)
    expect(afterJson).not.toContain(secretHash)
  })

  it("the stored row holds only the verifier — plaintext secret is never persisted", async () => {
    const ack = await createPending()
    const row = await db()
      .prepare("SELECT secret_hash FROM playlists WHERE share_id = ?1")
      .bind(ack.shareId)
      .first<{ secret_hash: string }>()
    expect(row?.secret_hash).toBe(await manageSecretHash(ack.shareId, ack.manageSecret))
    expect(row?.secret_hash).not.toBe(ack.manageSecret)
  })

  it("redacted request logging never records Authorization, ids, bodies or IPs", async () => {
    const logSpy = vi.spyOn(console, "log")
    const warnSpy = vi.spyOn(console, "warn")
    const errorSpy = vi.spyOn(console, "error")
    const secret = `SENTINELcap${"9".repeat(36)}`
    const sentinelIp = "203.0.113.77"
    const sentinelKey = crypto.randomUUID()
    try {
      const ack = await createPending()
      // Drive a full request mix through the real logged route wrappers:
      // Bearer PATCH, DELETE, a public GET and an import notify — every one
      // emits exactly one structured record via loggedApiRequest.
      await call(patchRoute, activateShare(ack.shareId, ack.manageSecret, sentinelKey), {
        shareId: ack.shareId,
      })
      await call(
        patchRoute,
        patchShare(ack.shareId, secret, crypto.randomUUID(), {
          operation: "replace",
          expectedRevision: 2,
          playlist: makePlaylist({ title: SENTINEL_TITLE }),
        }),
        { shareId: ack.shareId },
      )
      await call(
        getRoute,
        secureRequest({ method: "GET", path: `/${ack.shareId}`, ip: sentinelIp }),
        {
          shareId: ack.shareId,
        },
      )
      await call(deleteRoute, deleteShare(ack.shareId, ack.manageSecret, crypto.randomUUID(), 2), {
        shareId: ack.shareId,
      })
      const raw = JSON.stringify([
        ...logSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ])
      for (const forbidden of [
        secret,
        ack.manageSecret,
        ack.shareId,
        sentinelIp,
        sentinelKey,
        SENTINEL_TITLE,
        "Bearer",
        "authorization",
        "cf-connecting-ip",
        "idempotency",
      ]) {
        expect(raw).not.toContain(forbidden)
      }
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it("a thrown escape inside the logged wrapper cannot leak request material", async () => {
    const logSpy = vi.spyOn(console, "log")
    const secret = `SENTINELesc${"7".repeat(36)}`
    try {
      const request = new Request("https://d-op.sasnews.dev/api/v1/playlists", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ marker: "SENTINEL-body-55" }),
      })
      const res = await loggedApiRequest(request, "/api/v1/playlists", () => {
        throw new Error(`synthetic fault carrying ${secret}`)
      })
      expect(res.status).toBe(503)
      const raw = JSON.stringify(logSpy.mock.calls)
      expect(raw).not.toContain(secret)
      expect(raw).not.toContain("SENTINEL-body-55")
      expect(raw).not.toContain("Bearer")
      expect(raw).not.toContain("synthetic fault")
    } finally {
      logSpy.mockRestore()
    }
  })
})
