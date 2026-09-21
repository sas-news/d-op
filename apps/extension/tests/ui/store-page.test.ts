// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import { createStorePage, fetchChapterDocument, type StorePageDeps } from "../../src/ui/store-page"

const WORK_HTML = `
  <h1>My Work</h1>
  <div class="itemModule">
    <a href="/animestore/sc_d_pc?partId=p1">ep1</a>
    <h3>第1話 Title</h3>
  </div>
`

type Harness = {
  deps: StorePageDeps
  requested: string[]
  fetchImpl: (partId: string) => ReturnType<StorePageDeps["fetchChapters"]>
  timers: { callback: () => void; ms: number }[]
  flushTimers: () => void
  setFetch: (impl: Harness["fetchImpl"]) => void
}

function makeDeps(): Harness {
  const requested: string[] = []
  const timers: { callback: () => void; ms: number }[] = []
  let impl: Harness["fetchImpl"] = async () => null
  const harness: Harness = {
    deps: {
      fetchChapters: (partId) => impl(partId),
      requestPlayer: async (url) => {
        requested.push(url)
      },
      origin: () => "https://animestore.docomo.ne.jp",
      schedule: (callback, ms) => {
        const timer = { callback, ms }
        timers.push(timer)
        return timer
      },
      cancelTimer: (timer) => {
        const index = timers.indexOf(timer as { callback: () => void; ms: number })
        if (index >= 0) timers.splice(index, 1)
      },
      debounceMs: 100,
    },
    requested,
    fetchImpl: (partId) => impl(partId),
    timers,
    flushTimers: () => {
      const pending = [...timers]
      timers.length = 0
      for (const timer of pending) timer.callback()
    },
    setFetch: (next) => {
      impl = next
    },
  }
  return harness
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("ui/store-page (content-store.js parity)", () => {
  beforeEach(() => {
    document.body.innerHTML = WORK_HTML
  })

  it("decorates each .itemModule once with an OP/ED button", () => {
    const { deps } = makeDeps()
    const page = createStorePage(document, deps)
    page.start()
    const buttons = document.querySelectorAll(".d-op-store-btn")
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.textContent).toBe("OP/ED")
    // decorate is idempotent — start again must not double-decorate.
    page.dispose()
    expect(document.querySelectorAll(".d-op-store-btn")).toHaveLength(0)
    expect(document.querySelector(".itemModule")?.hasAttribute("data-dop-decorated")).toBe(false)
  })

  it("click opens the range menu of type==='none' chapters and requests the player", async () => {
    const { deps, requested, setFetch } = makeDeps()
    setFetch(async () => ({
      durationMs: 1_420_000,
      chapters: [
        { start: 0, end: 90_000, type: "none" },
        { start: 100_000, end: 200_000, type: "main" }, // filtered out
        { start: 1_300_000, end: 1_390_000, type: "none" },
      ],
    }))
    const page = createStorePage(document, deps)
    page.start()
    ;(document.querySelector(".d-op-store-btn") as HTMLElement).click()
    await settle()

    const rows = document.querySelectorAll(".d-op-store-range-item")
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain("OP")
    expect(rows[1]?.textContent).toContain("ED")

    ;(rows[1] as HTMLElement).click()
    await settle()
    expect(requested).toHaveLength(1)
    const url = new URL(requested[0] ?? "")
    expect(url.pathname).toBe("/animestore/sc_d_pc")
    expect(url.searchParams.get("partId")).toBe("p1")
    expect(url.searchParams.get("dopRangeIndex")).toBe("1")
    expect(url.searchParams.get("dopTitle")).toBe("My Work")
    expect(url.searchParams.get("dopEpisodeTitle")).toBe("第1話 Title")
    // Menu closed after selection.
    expect(document.getElementById("d-op-store-range-menu")).toBeNull()
    page.dispose()
  })

  it("first-range fallback: chapter fetch failure opens dopRangeIndex=0", async () => {
    const { deps, requested, setFetch } = makeDeps()
    setFetch(async () => null)
    const page = createStorePage(document, deps)
    page.start()
    ;(document.querySelector(".d-op-store-btn") as HTMLElement).click()
    await settle()
    expect(requested).toHaveLength(1)
    expect(new URL(requested[0] ?? "").searchParams.get("dopRangeIndex")).toBe("0")
    page.dispose()
  })

  it("no-type-none chapters shows the empty-range row instead of crashing", async () => {
    const { deps, setFetch } = makeDeps()
    setFetch(async () => ({
      durationMs: 1_000,
      chapters: [{ start: 0, end: 500, type: "main" }],
    }))
    const page = createStorePage(document, deps)
    page.start()
    ;(document.querySelector(".d-op-store-btn") as HTMLElement).click()
    await settle()
    const disabled = document.querySelector(".d-op-store-range-disabled")
    expect(disabled?.textContent).toBe("スキップ区間なし")
    page.dispose()
  })

  it("mutation-decorated items are debounced, not rebuilt per tick", async () => {
    const { deps, timers, flushTimers } = makeDeps()
    const page = createStorePage(document, deps)
    page.start()
    // Simulate a burst of DOM mutations — jsdom MutationObserver is async.
    for (let i = 0; i < 20; i += 1) {
      document.body.appendChild(document.createElement("span"))
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Pending decorate coalesced to a single timer.
    expect(timers.length).toBe(1)
    flushTimers()
    // A newly-added itemModule is decorated; existing untouched.
    const item = document.createElement("div")
    item.className = "itemModule"
    item.innerHTML = '<a href="/animestore/sc_d_pc?partId=p2">ep2</a><h3>第2話</h3>'
    document.body.appendChild(item)
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushTimers()
    expect(document.querySelectorAll(".d-op-store-btn")).toHaveLength(2)
    page.dispose()
  })

  it("dispose removes the open menu and its document click listener", async () => {
    const { deps, setFetch } = makeDeps()
    setFetch(async () => ({
      durationMs: 1_000,
      chapters: [{ start: 0, end: 90_000, type: "none" }],
    }))
    const page = createStorePage(document, deps)
    page.start()
    ;(document.querySelector(".d-op-store-btn") as HTMLElement).click()
    await settle()
    expect(document.getElementById("d-op-store-range-menu")).not.toBeNull()
    page.dispose()
    expect(document.getElementById("d-op-store-range-menu")).toBeNull()
  })
})

describe("ui/store-page fetchChapterDocument", () => {
  it("regexes the embedded chapters array + duration", async () => {
    const html = `<html>window.vc={"chapters":[{"start":0,"end":90000,"type":"none"}],"duration":1420000}</html>`
    const result = await fetchChapterDocument({
      url: "https://example",
      fetchImpl: async () => new Response(html, { status: 200 }),
    })
    expect(result?.chapters).toEqual([{ start: 0, end: 90_000, type: "none" }])
    expect(result?.durationMs).toBe(1_420_000)
  })

  it("returns null on http error / missing chapters / malformed json", async () => {
    expect(
      await fetchChapterDocument({
        url: "x",
        fetchImpl: async () => new Response("", { status: 500 }),
      }),
    ).toBeNull()
    expect(
      await fetchChapterDocument({
        url: "x",
        fetchImpl: async () => new Response("<html>none</html>", { status: 200 }),
      }),
    ).toBeNull()
    expect(
      await fetchChapterDocument({
        url: "x",
        fetchImpl: async () => {
          throw new Error("network")
        },
      }),
    ).toBeNull()
  })
})
