import { beforeAll, describe, expect, it } from "vitest"
import {
  ALL as importAll,
  POST as importRoute,
} from "../../src/pages/api/v1/playlists/[shareId]/import.js"
import { GET as getRoute, ALL as shareAll } from "../../src/pages/api/v1/playlists/[shareId].js"
import { ALL as collectionAll } from "../../src/pages/api/v1/playlists/index.js"
import {
  apiRequest,
  call,
  errorOf,
  getShare,
  makePlaylist,
  migratedDb,
  publishPlaylist,
} from "./helpers.js"

// Wrong methods get a fixed 405 METHOD_NOT_ALLOWED envelope plus an Allow
// header naming the route's real surface. GET on the collection is deferred
// to task 19 (adaptive discovery owns ranking snapshots/cursors, and the
// task-12 repository ships no public listing read), so it is a 405 too —
// never a fake empty listing.

describe("method handling", () => {
  beforeAll(async () => {
    await migratedDb()
  })

  it("returns 405 + Allow: POST for non-POST methods on the collection", async () => {
    // This includes the contract's deferred GET collection route.
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await call(collectionAll, apiRequest({ method, path: "" }))
      expect(res.status).toBe(405)
      expect(res.headers.get("allow")).toBe("POST")
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect((await errorOf(res)).code).toBe("METHOD_NOT_ALLOWED")
    }
  })

  it("returns 405 + Allow: GET, PATCH, DELETE for POST on a member", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const res = await call(
      shareAll,
      apiRequest({ method: "POST", path: `/${published.shareId}` }),
      { shareId: published.shareId },
    )
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("GET, PATCH, DELETE")
  })

  it("returns 405 + Allow: POST for GET on the import route", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const res = await call(
      importAll,
      apiRequest({ method: "GET", path: `/${published.shareId}/import` }),
      { shareId: published.shareId },
    )
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("POST")
  })

  it("serves GET on a member and POST on import as the contract allows", async () => {
    const published = await publishPlaylist(makePlaylist({}))
    const got = await call(getRoute, getShare(published.shareId), { shareId: published.shareId })
    expect(got.status).toBe(200)
    const notified = await call(
      importRoute,
      apiRequest({
        method: "POST",
        path: `/${published.shareId}/import`,
        body: { eventId: crypto.randomUUID() },
      }),
      { shareId: published.shareId },
    )
    expect(notified.status).toBe(204)
  })
})
