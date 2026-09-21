import { beforeAll, describe, expect, it } from "vitest"
import { SharedPlaylistSchema } from "../../../../packages/shared/src/index"
import {
  call,
  dataOf,
  db,
  deleteRoute,
  deleteShare,
  getRoute,
  getShare,
  listItems,
  makePlaylist,
  migratedDb,
  page,
  patchRoute,
  patchShare,
  publishPlaylist,
  remixPlaylist,
} from "./helpers.js"

// Post-hoc redaction (task 20): when a formerly public parent becomes
// unlisted, blocked or deleted, EVERY public surface — single GET, collection
// list, /p/ HTML view-model and its OGP strings, and the parent's own
// direct-children list — stops exposing the relationship at read time. The
// child stays readable, its stored canonical contentHash is untouched, and
// no parent id/title leaks anywhere.

beforeAll(async () => {
  await migratedDb()
})

type GetData = {
  readonly shareId: string
  readonly contentHash: string
  readonly playlist: Record<string, unknown>
  readonly source: unknown
}

async function getData(shareId: string): Promise<GetData> {
  const res = await call(getRoute, getShare(shareId), { shareId })
  return (await dataOf(res)) as GetData
}

/** Every redaction invariant for a hidden/deleted parent, in one place. */
async function expectRedactedEverywhere(
  childShareId: string,
  parentShareId: string,
  query: string,
): Promise<void> {
  // Single GET — source null, derivedFrom key absent, hash unchanged.
  const get = await getData(childShareId)
  expect(get.source).toBeNull()
  expect("derivedFrom" in get.playlist).toBe(false)
  expect(JSON.stringify(get)).not.toContain(parentShareId)

  // Collection list — same projection on the item payload.
  const items = await listItems(`&q=${query}`)
  const item = items.find((entry) => entry["shareId"] === childShareId)
  if (item === undefined) throw new Error(`child ${childShareId} missing from public list`)
  expect(item["source"]).toBeNull()
  expect("derivedFrom" in (item["playlist"] as Record<string, unknown>)).toBe(false)
  expect(JSON.stringify(item)).not.toContain(parentShareId)

  // Page view-model — no source link, no OGP Remix marker, no parent trace.
  const view = await page(childShareId)
  expect(view.kind).toBe("ready")
  if (view.kind !== "ready") return
  expect(view.view.sourceUrl).toBeNull()
  expect(view.view.ogDescription).not.toContain("Remix")
  expect(JSON.stringify(view.view)).not.toContain(parentShareId)
}

describe("post-hoc parent redaction", () => {
  it("parent replaced to unlisted → child redacts on GET, list and page", async () => {
    const parent = await publishPlaylist(makePlaylist({ title: "remix-flip-parent" }))
    const childPlaylist = remixPlaylist(
      { shareId: parent.shareId, revision: 2 },
      "remix-flip-child",
    )
    const child = await publishPlaylist(childPlaylist)
    const before = await getData(child.shareId)
    expect(before.source).not.toBeNull()

    // The owner flips the parent to unlisted through the real replace path.
    const flip = await call(
      patchRoute,
      patchShare(parent.shareId, parent.manageSecret, crypto.randomUUID(), {
        operation: "replace",
        expectedRevision: 2,
        playlist: SharedPlaylistSchema.parse({
          ...makePlaylist({ title: "remix-flip-parent" }),
          visibility: "unlisted",
        }),
      }),
      { shareId: parent.shareId },
    )
    expect(flip.status).toBe(200)

    await expectRedactedEverywhere(child.shareId, parent.shareId, "remix-flip-child")

    // The canonical hash still refers to the stored snapshot — redaction is
    // a PROJECTION, not a rewrite.
    const after = await getData(child.shareId)
    expect(after.contentHash).toBe(before.contentHash)

    // The unlisted parent page stays readable and still lists its public
    // children — the child's own link to it is what gets redacted.
    const parentView = await page(parent.shareId)
    expect(parentView.kind).toBe("ready")
    if (parentView.kind === "ready") {
      expect(parentView.view.remix.total).toBe(1)
      expect(parentView.view.remix.items[0]?.url).toBe(`/p/${child.shareId}`)
    }
  })

  it("blocked parent → identical redaction", async () => {
    const parent = await publishPlaylist(makePlaylist({ title: "remix-block-parent" }))
    const child = await publishPlaylist(
      remixPlaylist({ shareId: parent.shareId, revision: 2 }, "remix-block-child"),
    )
    await db()
      .prepare("UPDATE playlists SET blocked = 1 WHERE share_id = ?1")
      .bind(parent.shareId)
      .run()
    await expectRedactedEverywhere(child.shareId, parent.shareId, "remix-block-child")
    // The blocked parent itself collapses to the same nonrevealing notfound.
    const parentView = await page(parent.shareId)
    expect(parentView.kind).toBe("notfound")
  })

  it("deleted parent → identical redaction, child keeps working", async () => {
    const parent = await publishPlaylist(makePlaylist({ title: "remix-del2-parent" }))
    const child = await publishPlaylist(
      remixPlaylist({ shareId: parent.shareId, revision: 2 }, "remix-del2-child"),
    )
    const del = await call(
      deleteRoute,
      deleteShare(parent.shareId, parent.manageSecret, crypto.randomUUID(), 2),
      { shareId: parent.shareId },
    )
    expect(del.status).toBe(204)
    await expectRedactedEverywhere(child.shareId, parent.shareId, "remix-del2-child")
    // The parent itself is now absent everywhere.
    const parentGet = await call(getRoute, getShare(parent.shareId), { shareId: parent.shareId })
    expect(parentGet.status).toBe(404)
    expect((await page(parent.shareId)).kind).toBe("notfound")
  })

  it("a child's own derivedFrom never exposes a parent's title — only the id, and only while public", async () => {
    const parent = await publishPlaylist(makePlaylist({ title: "remix-secret-parent-name" }))
    const child = await publishPlaylist(
      remixPlaylist({ shareId: parent.shareId, revision: 2 }, "remix-secret-child"),
    )
    const linked = await getData(child.shareId)
    // Even while linked, the public surface carries ONLY the opaque id —
    // never the parent's title, author or snapshot fields.
    expect(JSON.stringify(linked)).not.toContain("remix-secret-parent-name")
    await db()
      .prepare("UPDATE playlists SET blocked = 1 WHERE share_id = ?1")
      .bind(parent.shareId)
      .run()
    const redacted = await getData(child.shareId)
    expect(JSON.stringify(redacted)).not.toContain(parent.shareId)
    expect(JSON.stringify(redacted)).not.toContain("remix-secret-parent-name")
  })
})
