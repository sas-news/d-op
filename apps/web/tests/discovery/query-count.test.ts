import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { describe, expect, it } from "vitest"
import { runCollection } from "../../src/server/discovery/engine.js"
import { listPublicTagCounts, VISIBILITY_CHUNK } from "../../src/server/discovery/queries.js"
import {
  cursorPayload,
  dayBefore,
  migratedDb,
  seedImport,
  seedMany,
  seedPlaylist,
} from "./helpers.js"

// Task 24 performance bound: prove the Discovery read path runs a FIXED
// number of prepared statements per page — independent of how many public
// playlists exist — and that a continuation is strictly cheaper than a first
// page (no re-materialization, no re-rank). An unbounded per-row or
// per-candidate query would show up here immediately. No caches are added;
// the bound comes from the design (frozen snapshot + chunked visibility
// re-check), and this test pins it.

/** Wraps the real Miniflare D1 binding and counts prepare() calls — the one
 *  funnel every read/write in the discovery engine goes through. */
function countingDb(real: D1Database): {
  readonly db: D1Database
  readonly queries: () => number
} {
  let count = 0
  const db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (query: string): D1PreparedStatement => {
          count += 1
          return target.prepare(query)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return {
    db,
    queries: () => count,
  }
}

describe("discovery query-count bounds", () => {
  it("first page (sort=new) runs a fixed 4 queries regardless of row count", async () => {
    const real = await migratedDb()
    await seedMany(real, 150)
    const { db, queries } = countingDb(real)

    const outcome = await runCollection(db, {
      sort: "new",
      q: undefined,
      tag: undefined,
      limit: 20,
      cursor: undefined,
    })

    expect(outcome.kind).toBe("ok")
    // findReusableSnapshot(1) + materializeCandidates(1) + insertSnapshot(1)
    // + fetchEligibleChunk(⌈20/64⌉ = 1) — a per-row N+1 would read ~170.
    expect(queries()).toBe(4)
  })

  it("first page (sort=popular) adds exactly one coverage query", async () => {
    const real = await migratedDb()
    const ids = await seedMany(real, 150)
    const first = ids[0]
    if (first === undefined) throw new Error("seed failed")
    await seedImport(real, first, dayBefore(new Date(), 1), 3)
    const { db, queries } = countingDb(real)

    const outcome = await runCollection(db, {
      sort: "popular",
      q: undefined,
      tag: undefined,
      limit: 20,
      cursor: undefined,
    })

    expect(outcome.kind).toBe("ok")
    // collectRankCoverage(1) + the same 4-query first-page pipeline.
    expect(queries()).toBe(5)
  })

  it("continuation is cheaper than a first page: loadSnapshot + visibility chunk only", async () => {
    const real = await migratedDb()
    await seedMany(real, 150)
    const first = await runCollection(real, {
      sort: "new",
      q: undefined,
      tag: undefined,
      limit: 20,
      cursor: undefined,
    })
    if (first.kind !== "ok" || first.nextCursor === null) throw new Error("no cursor issued")
    expect(cursorPayload(first.nextCursor).o).toBe(20)

    const { db, queries } = countingDb(real)
    const second = await runCollection(db, {
      sort: "new",
      q: undefined,
      tag: undefined,
      limit: 20,
      cursor: first.nextCursor,
    })

    expect(second.kind).toBe("ok")
    // loadSnapshot(1) + fetchEligibleChunk(1) — no coverage, no re-rank, no
    // re-materialization of the 150-row candidate list.
    expect(queries()).toBe(2)
  })

  it("page slices scale as ⌈limit/VISIBILITY_CHUNK⌉, not per candidate", async () => {
    const real = await migratedDb()
    await seedMany(real, 150)

    const wide = countingDb(real)
    const big = await runCollection(wide.db, {
      sort: "new",
      // A distinct q keeps this fingerprint off the earlier tests' snapshots
      // (the file shares one D1 binding) while still matching every "bulk N"
      // seed title, so the wide page still spans two visibility chunks.
      q: "bulk",
      tag: undefined,
      limit: VISIBILITY_CHUNK + 10,
      cursor: undefined,
    })
    expect(big.kind).toBe("ok")
    // 74 items spans two visibility chunks: 3 fixed + 2 chunk queries.
    expect(wide.queries()).toBe(5)
  })

  it("tag-chip strip adds exactly one query to an explore render", async () => {
    const real = await migratedDb()
    await seedPlaylist(real, { tags: ["op", "anime"] })
    await seedPlaylist(real, { tags: ["op"] })
    const { db, queries } = countingDb(real)

    const chips = await listPublicTagCounts(db)

    expect(queries()).toBe(1)
    expect(chips.map((row) => row.tag)).toContain("op")
  })
})
