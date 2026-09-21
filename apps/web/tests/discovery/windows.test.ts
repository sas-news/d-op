import { beforeAll, describe, expect, it } from "vitest"
import { utcDayBefore, utcDayOf } from "../../src/server/discovery/policy.js"
import { collectRankCoverage } from "../../src/server/discovery/queries.js"
import {
  dayBefore,
  db,
  listAt,
  listData,
  listRequest,
  migratedDb,
  seedImport,
  seedPlaylist,
} from "./helpers.js"

// Adaptive ranking window matrix (task 19). This file owns a dedicated
// Miniflare D1, and the phases are deliberately CUMULATIVE: the window
// decision counts eligible positive-score playlists globally, so each phase
// only ever adds coverage and the ladder widens then narrows deterministically.
//
//   phase A: 0 events              -> popular degrades to new/none/no-imports
//   phase B: 3 positives (today-2) -> lifetime + insufficient-recent-data
//   phase C: +2 positives (day-45) -> 90d (30d still only has 3)
//   phase D: +2 positives (today)  -> 30d, no fallback
//   phase E: exact boundary counts via collectRankCoverage under a clock
//            where only deliberately placed buckets are inside the window.

const NOW = new Date("2026-03-10T12:00:00.000Z")
const ISO = (day: number) => `2026-03-${String(day).padStart(2, "0")}T00:00:00.000Z`
const FUTURE = new Date("2026-09-26T12:00:00.000Z")

const mains: string[] = [] // five mains, oldest -> newest
let zeroTail = ""

beforeAll(async () => {
  await migratedDb()
  // Phase A fixtures: five mains (mains[0]/mains[3] also carry wm-rare) and
  // one zero-score playlist — all public, active, unblocked.
  for (let i = 0; i < 5; i += 1) {
    mains.push(
      await seedPlaylist(db(), {
        firstPublishedAt: ISO(1 + i),
        tags: i === 0 || i === 3 ? ["wm", "wm-rare"] : ["wm"],
      }),
    )
  }
  zeroTail = await seedPlaylist(db(), { firstPublishedAt: ISO(8), tags: ["wm"] })
})

async function popular(params: Record<string, string> = {}, now = NOW) {
  return listData(await listAt(listRequest({ sort: "popular", ...params }), now))
}

describe("window ladder", () => {
  it("phase A: zero events degrades popular to new/none/no-imports; zero tail listed", async () => {
    const data = await popular({ tag: "wm" })
    expect(data.ranking).toMatchObject({
      mode: "new",
      effectiveWindow: "none",
      fallbackReason: "no-imports",
    })
    // Degraded basis still lists everything eligible, newest first.
    expect(data.items).toHaveLength(6)
    expect(data.items[0]?.shareId).toBe(zeroTail)

    const fresh = await listData(await listAt(listRequest({ sort: "new", tag: "wm" }), NOW))
    expect(fresh.ranking.fallbackReason).toBeUndefined() // requested, not a fallback
  })

  it("phase B: three positives -> lifetime with insufficient-recent-data", async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedImport(db(), mains[i] ?? "", dayBefore(NOW, 2), i + 1)
    }
    const data = await popular({ tag: "wm" })
    expect(data.ranking.effectiveWindow).toBe("lifetime")
    expect(data.ranking.fallbackReason).toBe("insufficient-recent-data")
    // Score desc over lifetime counters (3,2,1) then zero tail by first-pub desc.
    const ids = data.items.map((item) => item.shareId)
    expect(ids.slice(0, 3)).toEqual([mains[2], mains[1], mains[0]])
    expect(ids.slice(3)).toEqual([zeroTail, mains[4], mains[3]])
  })

  it("phase C: five positives only inside 90d -> 90d + insufficient-recent-data", async () => {
    for (const i of [3, 4]) {
      await seedImport(db(), mains[i] ?? "", dayBefore(NOW, 45))
    }
    const data = await popular({ tag: "wm" })
    expect(data.ranking.effectiveWindow).toBe("90d")
    expect(data.ranking.fallbackReason).toBe("insufficient-recent-data")
  })

  it("phase D: five positives inside 30d -> 30d, no fallback, score-ordered", async () => {
    for (const i of [3, 4]) {
      await seedImport(db(), mains[i] ?? "", dayBefore(NOW, 0), i + 1)
    }
    const data = await popular({ tag: "wm" })
    expect(data.ranking.effectiveWindow).toBe("30d")
    expect(data.ranking.fallbackReason).toBeUndefined()
    // 30d scores: main4=5, main3=4, main2=3, main1=2, main0=1, zero=0.
    expect(data.items.map((item) => item.shareId)).toEqual([
      mains[4],
      mains[3],
      mains[2],
      mains[1],
      mains[0],
      zeroTail,
    ])
  })

  it("phase D: a tag-narrowed subset still reports the GLOBAL 30d basis", async () => {
    // Only mains[0] and mains[3] carry wm-rare — two positives, under the
    // five-playlist threshold — yet the window must stay 30d because the
    // decision is global, independent of search/tag/page narrowing.
    const data = await popular({ tag: "wm-rare" })
    expect(data.ranking.effectiveWindow).toBe("30d")
    expect(data.ranking.fallbackReason).toBeUndefined()
    expect(data.items.map((item) => item.shareId).sort()).toEqual([mains[0], mains[3]].sort())
    // Same for a search-narrowed subset.
    const searched = await popular({ q: "共有リスト" })
    expect(searched.ranking.effectiveWindow).toBe("30d")
  })
})

describe("coverage counting boundaries", () => {
  it("the window includes its oldest day and the current day, and nothing older", async () => {
    // Under the FUTURE clock every earlier bucket is >90d old, so only the
    // three deliberately placed buckets count.
    const inBoundary = await seedPlaylist(db(), { firstPublishedAt: ISO(9) })
    const outBoundary = await seedPlaylist(db(), { firstPublishedAt: ISO(9) })
    const todayBoundary = await seedPlaylist(db(), { firstPublishedAt: ISO(9) })
    await seedImport(db(), inBoundary, utcDayBefore(FUTURE, 29)) // oldest 30d day
    await seedImport(db(), outBoundary, utcDayBefore(FUTURE, 30)) // just outside 30d
    await seedImport(db(), todayBoundary, utcDayOf(FUTURE)) // the current day

    const coverage = await collectRankCoverage(db(), FUTURE)
    expect(coverage.positives30d).toBe(2) // inBoundary + todayBoundary
    expect(coverage.positives90d).toBe(3) // + outBoundary
    // Lifetime counts every eligible playlist with a positive counter.
    expect(coverage.positivesLifetime).toBe(5 + 3)

    // Through the listing: 30d and 90d both lack coverage -> lifetime.
    const data = await popular({}, FUTURE)
    expect(data.ranking.effectiveWindow).toBe("lifetime")
    expect(data.ranking.fallbackReason).toBe("insufficient-recent-data")
  })
})
