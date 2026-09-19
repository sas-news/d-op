import { expect, test } from "@playwright/test"

const FIXTURE_ORIGIN = "http://127.0.0.1:8123"
type FixtureWindow = Window & {
  readonly __adapterFixture?: {
    readonly events: readonly string[]
    readonly jumps: readonly number[]
  }
}

test("adapter fixture delivers READY before CHAPTERS and rejects forged messages", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/adapter-bridge.html`)
  await expect(page.locator("[data-testid='adapter-title']")).toHaveText("adapter bridge fixture")
  await expect
    .poll(() => page.evaluate(() => (window as FixtureWindow).__adapterFixture?.events))
    .toEqual(["ready", "chapters"])

  await page.evaluate(() => {
    window.postMessage({ source: "evil", version: 1, type: "READY" }, window.location.origin)
    window.postMessage(
      {
        source: "d-op-injected",
        version: 1,
        type: "CHAPTERS",
        payload: {
          chapters: Array.from({ length: 501 }, () => ({ startMs: 0, endMs: 1 })),
          durationMs: 1,
        },
      },
      window.location.origin,
    )
    const iframe = document.createElement("iframe")
    iframe.srcdoc =
      `<script>parent.postMessage({source:'d-op-injected',version:1,type:'READY'}, '*')</scr` +
      `ipt>`
    document.body.append(iframe)
    window.postMessage(
      {
        source: "d-op-injected",
        version: 1,
        type: "COMMAND",
        payload: { source: "d-op-injected", type: "SEEK", timeMs: 1000 },
      },
      window.location.origin,
    )
  })
  await expect
    .poll(() => page.evaluate(() => (window as FixtureWindow).__adapterFixture?.jumps))
    .toEqual([1])
  await expect
    .poll(() => page.evaluate(() => (window as FixtureWindow).__adapterFixture?.events))
    .toEqual(["ready", "chapters"])

  await page.evaluate(() => {
    const script = document.createElement("script")
    script.src = "/danime-main.js"
    document.body.append(script)
  })
  await expect
    .poll(() => page.evaluate(() => (window as FixtureWindow).__adapterFixture?.events))
    .toEqual(["ready", "chapters", "ready", "chapters"])
})
