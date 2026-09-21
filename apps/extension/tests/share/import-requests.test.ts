import { describe, expect, it } from "vitest"
import { createImportRequestBook } from "../../src/share/import-requests"
import { newUuid, OTHER_SHARE_ID, resetUuidCounter, SHARE_ID, shareResponse } from "./fixtures"

function book(nowRef: { value: number }) {
  resetUuidCounter()
  return createImportRequestBook({
    now: () => nowRef.value,
    newToken: newUuid,
    throttleMs: 1_500,
    ttlMs: 60_000,
    maxPending: 3,
  })
}

const rid = (n: number) => `11111111-2222-4333-8444-${String(n).padStart(12, "0")}`

describe("import request book", () => {
  it("admits a fresh request and replays the same requestId as duplicate", () => {
    const now = { value: 1_000 }
    const requests = book(now)
    const first = requests.admit({ shareId: SHARE_ID, requestId: rid(1), tabId: 7 })
    expect(first.kind).toBe("accepted")
    expect(requests.admit({ shareId: SHARE_ID, requestId: rid(1), tabId: 7 })).toEqual({
      kind: "duplicate",
    })
    // The original token stays live for the confirmation page.
    expect(requests.get(first.kind === "accepted" ? first.token : "")).toMatchObject({
      shareId: SHARE_ID,
      requestId: rid(1),
      tabId: 7,
      state: "awaiting-confirm",
    })
  })

  it("throttles a different requestId for the same shareId inside the window", () => {
    const now = { value: 1_000 }
    const requests = book(now)
    requests.admit({ shareId: SHARE_ID, requestId: rid(1) })
    expect(requests.admit({ shareId: SHARE_ID, requestId: rid(2) })).toEqual({
      kind: "throttled",
    })
    // A different shareId is unaffected by the throttle.
    expect(requests.admit({ shareId: OTHER_SHARE_ID, requestId: rid(3) }).kind).toBe("accepted")
    // After the window the same shareId is admitted again.
    now.value += 1_600
    expect(requests.admit({ shareId: SHARE_ID, requestId: rid(4) }).kind).toBe("accepted")
  })

  it("caps live pending entries", () => {
    const now = { value: 1_000 }
    const requests = book(now)
    for (const [i, id] of [SHARE_ID, OTHER_SHARE_ID, SHARE_ID].entries()) {
      now.value += 2_000
      expect(requests.admit({ shareId: id, requestId: rid(10 + i) }).kind).toBe("accepted")
    }
    now.value += 2_000
    expect(requests.admit({ shareId: OTHER_SHARE_ID, requestId: rid(99) })).toEqual({
      kind: "full",
    })
  })

  it("expires pending entries after the TTL", () => {
    const now = { value: 1_000 }
    const requests = book(now)
    const admitted = requests.admit({ shareId: SHARE_ID, requestId: rid(1) })
    const token = admitted.kind === "accepted" ? admitted.token : ""
    now.value += 61_000
    expect(requests.get(token)).toBeUndefined()
    // Expired entries free capacity again.
    now.value += 2_000
    expect(requests.admit({ shareId: SHARE_ID, requestId: rid(2) }).kind).toBe("accepted")
  })

  it("attaches a preview once, settles, and rejects further transitions", () => {
    const now = { value: 1_000 }
    const requests = book(now)
    const admitted = requests.admit({ shareId: SHARE_ID, requestId: rid(1) })
    const token = admitted.kind === "accepted" ? admitted.token : ""
    const response = shareResponse()
    expect(requests.attachPreview(token, response)).toBe(true)
    expect(requests.get(token)?.response?.shareId).toBe(SHARE_ID)
    expect(requests.settle(token, "committed")).toBe(true)
    // A settled request cannot be re-previewed or flipped to cancelled —
    // a late CANCEL must not un-commit a completed save.
    expect(requests.attachPreview(token, response)).toBe(false)
    expect(requests.get(token)?.state).toBe("committed")
    expect(requests.settle(token, "cancelled")).toBe(false)
    expect(requests.get(token)?.state).toBe("committed")
  })
})
