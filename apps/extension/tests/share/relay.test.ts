import { describe, expect, it } from "vitest"
import {
  SHARE_EXTENSION_MESSAGE_SOURCE,
  SHARE_PAGE_MESSAGE_SOURCE,
  type ShareImportAck,
  type SharePageImportRequest,
} from "../../src/share/protocol"
import {
  installShareRelay,
  type ShareRelayMessageEvent,
  type ShareRelayWindow,
} from "../../src/share/relay"
import { SHARE_ID, SHARE_ORIGIN } from "./fixtures"

class FakeWindow implements ShareRelayWindow {
  readonly location = { origin: SHARE_ORIGIN }
  readonly posted: { message: ShareImportAck; origin: string }[] = []
  #listener: ((event: ShareRelayMessageEvent) => void) | null = null
  addEventListener(_type: "message", listener: (event: ShareRelayMessageEvent) => void): void {
    this.#listener = listener
  }
  removeEventListener(): void {
    this.#listener = null
  }
  postMessage(message: ShareImportAck, targetOrigin: string): void {
    this.posted.push({ message, origin: targetOrigin })
  }
  emit(event: ShareRelayMessageEvent): void {
    this.#listener?.(event)
  }
}

function request(requestId = "11111111-2222-4333-8444-555555555501"): SharePageImportRequest {
  return {
    source: SHARE_PAGE_MESSAGE_SOURCE,
    type: "DOP_SHARE_IMPORT_REQUEST",
    version: 1,
    shareId: SHARE_ID,
    requestId,
  }
}

function openRelay(forward: (request: SharePageImportRequest) => Promise<unknown>) {
  const win = new FakeWindow()
  const forwarded: SharePageImportRequest[] = []
  installShareRelay(win, {
    forward: async (req) => {
      forwarded.push(req)
      return forward(req)
    },
  })
  return { win, forwarded }
}

const OPENED = { kind: "share-import-begin", status: "opened" }

describe("share-site relay", () => {
  it("forwards a valid request and echoes the background status bound to requestId", async () => {
    const { win, forwarded } = openRelay(async () => OPENED)
    win.emit({ source: win, origin: SHARE_ORIGIN, data: request() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(forwarded).toHaveLength(1)
    expect(win.posted).toEqual([
      {
        message: {
          source: SHARE_EXTENSION_MESSAGE_SOURCE,
          type: "DOP_SHARE_IMPORT_ACK",
          version: 1,
          requestId: "11111111-2222-4333-8444-555555555501",
          status: "opened",
        },
        origin: SHARE_ORIGIN,
      },
    ])
  })

  it("rejects messages from a foreign window source", async () => {
    const { win, forwarded } = openRelay(async () => OPENED)
    win.emit({ source: { iframe: true }, origin: SHARE_ORIGIN, data: request() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(forwarded).toHaveLength(0)
    expect(win.posted).toHaveLength(0)
  })

  it("rejects messages from a different origin even with a valid payload", async () => {
    const { win, forwarded } = openRelay(async () => OPENED)
    for (const origin of [
      "https://evil.example",
      "https://d-op.sasnews.dev.evil.example",
      "null",
    ]) {
      win.emit({ source: win, origin, data: request() })
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(forwarded).toHaveLength(0)
    expect(win.posted).toHaveLength(0)
  })

  it("ignores malformed payloads without erroring or replying", async () => {
    const { win, forwarded } = openRelay(async () => OPENED)
    const junk = [
      null,
      "string",
      { source: SHARE_PAGE_MESSAGE_SOURCE }, // missing fields
      { ...request(), shareId: "not-a-share-id" },
      { ...request(), requestId: "not-a-uuid" },
      { ...request(), playlist: { items: [] } }, // playlist JSON never accepted
      { ...request(), source: SHARE_EXTENSION_MESSAGE_SOURCE }, // our own ack shape
      { ...request(), version: 2 },
      { ...request(), extra: 1 }, // strict object
    ]
    for (const data of junk) {
      win.emit({ source: win, origin: SHARE_ORIGIN, data })
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(forwarded).toHaveLength(0)
    expect(win.posted).toHaveLength(0)
  })

  it("maps a malformed background reply to unavailable", async () => {
    const { win } = openRelay(async () => ({ unexpected: true }))
    win.emit({ source: win, origin: SHARE_ORIGIN, data: request() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(win.posted[0]?.message.status).toBe("unavailable")
  })

  it("posts unavailable when forwarding throws", async () => {
    const { win } = openRelay(async () => {
      throw new Error("sw gone")
    })
    win.emit({ source: win, origin: SHARE_ORIGIN, data: request() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(win.posted[0]?.message.status).toBe("unavailable")
  })

  it("correlates parallel requests by requestId", async () => {
    const { win, forwarded } = openRelay(async (req) => ({
      kind: "share-import-begin",
      status: req.requestId.endsWith("02") ? "duplicate" : "opened",
    }))
    win.emit({
      source: win,
      origin: SHARE_ORIGIN,
      data: request("11111111-2222-4333-8444-555555555501"),
    })
    win.emit({
      source: win,
      origin: SHARE_ORIGIN,
      data: request("11111111-2222-4333-8444-555555555502"),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(forwarded).toHaveLength(2)
    expect(win.posted.map((p) => [p.message.requestId, p.message.status])).toEqual([
      ["11111111-2222-4333-8444-555555555501", "opened"],
      ["11111111-2222-4333-8444-555555555502", "duplicate"],
    ])
  })
})
