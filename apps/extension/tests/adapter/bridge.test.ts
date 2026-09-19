import { describe, expect, it } from "vitest"
import { PAGE_ENVELOPE_VERSION, parsePageEnvelope } from "../../src/adapter/bridge"

describe("page bridge envelope", () => {
  it("accepts an exact-origin same-window ready envelope", () => {
    const windowObject = {}
    const result = parsePageEnvelope(
      {
        source: "d-op-injected",
        version: PAGE_ENVELOPE_VERSION,
        type: "READY",
      },
      { origin: "https://animestore.docomo.ne.jp", source: windowObject },
      "https://animestore.docomo.ne.jp",
      windowObject,
    )
    expect(result).toEqual({ kind: "ready" })
  })

  it("rejects wrong origin, source, version, payload and unsupported commands", () => {
    const windowObject = {}
    const base = { source: "d-op-injected", version: PAGE_ENVELOPE_VERSION, type: "PLAY" }
    expect(
      parsePageEnvelope(
        base,
        { origin: "https://evil.example", source: windowObject },
        "https://animestore.docomo.ne.jp",
        windowObject,
      ),
    ).toEqual({ kind: "rejected" })
    expect(
      parsePageEnvelope(
        base,
        { origin: "https://animestore.docomo.ne.jp", source: {} },
        "https://animestore.docomo.ne.jp",
        windowObject,
      ),
    ).toEqual({ kind: "rejected" })
    expect(
      parsePageEnvelope(
        { ...base, version: 99 },
        { origin: "https://animestore.docomo.ne.jp", source: windowObject },
        "https://animestore.docomo.ne.jp",
        windowObject,
      ),
    ).toEqual({ kind: "rejected" })
    expect(
      parsePageEnvelope(
        { ...base, type: "NOPE" },
        { origin: "https://animestore.docomo.ne.jp", source: windowObject },
        "https://animestore.docomo.ne.jp",
        windowObject,
      ),
    ).toEqual({ kind: "rejected" })
    expect(
      parsePageEnvelope(
        { ...base, payload: "x".repeat(100_001) },
        { origin: "https://animestore.docomo.ne.jp", source: windowObject },
        "https://animestore.docomo.ne.jp",
        windowObject,
      ),
    ).toEqual({ kind: "rejected" })
  })
})
