import { beforeAll, describe, expect, it } from "vitest"
import { contentHashOf, SharedPlaylistSchema } from "../../../../packages/shared/src/index"
import {
  activateShare,
  call,
  createRoute,
  dataOf,
  db,
  deleteRoute,
  deleteShare,
  errorOf,
  getRoute,
  getShare,
  listItems,
  makePlaylist,
  migratedDb,
  PHANTOM_PARENT,
  page,
  patchRoute,
  patchShare,
  postCreate,
  publishPlaylist,
  remixPlaylist,
} from "./helpers.js"

// Remix provenance — write-path validation (task 20). derivedFrom is a
// first-publication-only link to an EXISTING OLDER PUBLIC source: the parent
// must be active, public, unblocked, at-or-past the referenced revision, and
// published strictly before the child. Replace can never change it, which
// also closes the self-reference/cycle path through update.

beforeAll(async () => {
  await migratedDb()
})

type CreatedAck = { shareId: string; manageSecret: string; contentHash: string }

describe("derivedFrom create validation", () => {
  it("happy path: a public child links to its public parent everywhere", async () => {
    const parent = await publishPlaylist(makePlaylist({ title: "remix-happy-parent" }))
    const childPlaylist = remixPlaylist(
      { shareId: parent.shareId, revision: 2 },
      "remix-happy-child",
    )
    const created = await call(createRoute, postCreate(childPlaylist))
    expect(created.status).toBe(201)
    const ack = (await dataOf(created)) as CreatedAck
    const activated = await call(patchRoute, activateShare(ack.shareId, ack.manageSecret), {
      shareId: ack.shareId,
    })
    expect(activated.status).toBe(200)

    // GET: projected source + stored canonical hash.
    const get = await call(getRoute, getShare(ack.shareId), { shareId: ack.shareId })
    const data = (await dataOf(get)) as Record<string, unknown>
    expect(data["source"]).toEqual({ shareId: parent.shareId, revision: 2 })
    expect((data["playlist"] as Record<string, unknown>)["derivedFrom"]).toEqual({
      shareId: parent.shareId,
      revision: 2,
    })
    expect(data["contentHash"]).toBe(await contentHashOf(childPlaylist))

    // Collection list: the same projection appears on the child item.
    const items = await listItems("&q=remix-happy-child")
    const childItem = items.find((item) => item["shareId"] === ack.shareId)
    expect(childItem?.["source"]).toEqual({ shareId: parent.shareId, revision: 2 })

    // Page view: source link + OGP Remix marker on the child…
    const childPage = await page(ack.shareId)
    expect(childPage.kind).toBe("ready")
    if (childPage.kind !== "ready") return
    expect(childPage.view.sourceUrl).toBe(`/p/${parent.shareId}`)
    expect(childPage.view.ogDescription).toContain("Remix")

    // …and a direct-children entry on the parent's page.
    const parentPage = await page(parent.shareId)
    expect(parentPage.kind).toBe("ready")
    if (parentPage.kind !== "ready") return
    expect(parentPage.view.remix.total).toBe(1)
    expect(parentPage.view.remix.items[0]).toMatchObject({
      title: "remix-happy-child",
      url: `/p/${ack.shareId}`,
    })
  })

  it("rejects a public child whose parent is unlisted — no silent downgrade", async () => {
    const parent = await publishPlaylist(
      makePlaylist({ title: "remix-unlisted-parent", visibility: "unlisted" }),
    )
    const res = await call(
      createRoute,
      postCreate(remixPlaylist({ shareId: parent.shareId, revision: 2 }, "remix-unlisted-child")),
    )
    expect(res.status).toBe(422)
    const error = await errorOf(res)
    expect(error.code).toBe("SCHEMA_INVALID")
    expect(error.details).toEqual(["derivedFrom"])
  })

  it("rejects pending, blocked and nonexistent parents identically", async () => {
    // pending: created but never activated — invisible to the public contract.
    const pendingCreate = await call(createRoute, postCreate(makePlaylist({})))
    const pendingAck = (await dataOf(pendingCreate)) as CreatedAck
    // blocked: published then operator-hidden.
    const blocked = await publishPlaylist(makePlaylist({}))
    await db()
      .prepare("UPDATE playlists SET blocked = 1 WHERE share_id = ?1")
      .bind(blocked.shareId)
      .run()

    for (const parentId of [pendingAck.shareId, blocked.shareId, PHANTOM_PARENT]) {
      const res = await call(
        createRoute,
        postCreate(remixPlaylist({ shareId: parentId, revision: 1 }, "remix-forged-child")),
      )
      expect(res.status).toBe(422)
      expect((await errorOf(res)).details).toEqual(["derivedFrom"])
    }
  })

  it("rejects a parent that is not strictly older (first_published_at in the future)", async () => {
    const parent = await publishPlaylist(makePlaylist({ title: "remix-future-parent" }))
    await db()
      .prepare("UPDATE playlists SET first_published_at = ?1 WHERE share_id = ?2")
      .bind(new Date(Date.now() + 3_600_000).toISOString(), parent.shareId)
      .run()
    const res = await call(
      createRoute,
      postCreate(remixPlaylist({ shareId: parent.shareId, revision: 2 }, "remix-future-child")),
    )
    expect(res.status).toBe(422)
    expect((await errorOf(res)).details).toEqual(["derivedFrom"])
  })

  it("rejects a revision the parent never had; accepts a past revision", async () => {
    const parent = await publishPlaylist(makePlaylist({ title: "remix-rev-parent" }))
    const future = await call(
      createRoute,
      postCreate(remixPlaylist({ shareId: parent.shareId, revision: 99 }, "remix-rev-future")),
    )
    expect(future.status).toBe(422)
    expect((await errorOf(future)).details).toEqual(["derivedFrom"])
    // revision 1 is the parent's provisional snapshot — it existed, so the
    // recorded lineage is honest even though the parent has since moved on.
    const past = await call(
      createRoute,
      postCreate(remixPlaylist({ shareId: parent.shareId, revision: 1 }, "remix-rev-past")),
    )
    expect(past.status).toBe(201)
  })
})

describe("derivedFrom immutability on replace", () => {
  it("cannot be removed, changed or added after first publication", async () => {
    const parent = await publishPlaylist(makePlaylist({ title: "remix-immutable-parent" }))
    const other = await publishPlaylist(makePlaylist({ title: "remix-immutable-other" }))
    const childPlaylist = remixPlaylist(
      { shareId: parent.shareId, revision: 2 },
      "remix-immutable-child",
    )
    const child = await publishPlaylist(childPlaylist)

    const replace = (playlist: unknown) =>
      call(
        patchRoute,
        patchShare(child.shareId, child.manageSecret, crypto.randomUUID(), {
          operation: "replace",
          expectedRevision: 2,
          playlist,
        }),
        { shareId: child.shareId },
      )

    // Removed.
    const removed = await replace(makePlaylist({ title: "remix-immutable-child" }))
    expect(removed.status).toBe(422)
    expect((await errorOf(removed)).details).toEqual(["playlist.derivedFrom"])
    // Rewritten to another share.
    const rewritten = await replace(
      SharedPlaylistSchema.parse({
        ...makePlaylist({ title: "remix-immutable-child" }),
        derivedFrom: { shareId: other.shareId, revision: 2 },
      }),
    )
    expect(rewritten.status).toBe(422)
    expect((await errorOf(rewritten)).details).toEqual(["playlist.derivedFrom"])
    // Same link, edited content → accepted; revision advances normally.
    const kept = await replace(
      SharedPlaylistSchema.parse({ ...childPlaylist, title: "remix-immutable-child-v2" }),
    )
    expect(kept.status).toBe(200)

    // A plain share cannot GAIN a link via update — covers self-reference
    // and cycle attempts alike (any change is rejected).
    const plain = await publishPlaylist(makePlaylist({ title: "remix-immutable-plain" }))
    const gainSelf = await call(
      patchRoute,
      patchShare(plain.shareId, plain.manageSecret, crypto.randomUUID(), {
        operation: "replace",
        expectedRevision: 2,
        playlist: SharedPlaylistSchema.parse({
          ...makePlaylist({ title: "remix-immutable-plain" }),
          derivedFrom: { shareId: plain.shareId, revision: 2 },
        }),
      }),
      { shareId: plain.shareId },
    )
    expect(gainSelf.status).toBe(422)
    expect((await errorOf(gainSelf)).details).toEqual(["playlist.derivedFrom"])

    const gainChild = await call(
      patchRoute,
      patchShare(plain.shareId, plain.manageSecret, crypto.randomUUID(), {
        operation: "replace",
        expectedRevision: 2,
        playlist: SharedPlaylistSchema.parse({
          ...makePlaylist({ title: "remix-immutable-plain" }),
          derivedFrom: { shareId: child.shareId, revision: 3 },
        }),
      }),
      { shareId: plain.shareId },
    )
    expect(gainChild.status).toBe(422)
  })

  it("delete still works on a linked child — provenance never locks management", async () => {
    const parent = await publishPlaylist(makePlaylist({ title: "remix-del-parent" }))
    const child = await publishPlaylist(
      remixPlaylist({ shareId: parent.shareId, revision: 2 }, "remix-del-child"),
    )
    const res = await call(
      deleteRoute,
      deleteShare(child.shareId, child.manageSecret, crypto.randomUUID(), 2),
      { shareId: child.shareId },
    )
    expect(res.status).toBe(204)
  })
})
