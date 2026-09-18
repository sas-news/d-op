// Extension bridge and sender-surface contracts (task 3).
import {
  assertMessageAllowedOnSurface,
  BackgroundRequestSchema,
  BridgeReplySchema,
  CapabilityLeakError,
  ChaptersFoundSchema,
  ExtensionMessageSchema,
  isPrivilegedSurface,
  newCorrelationId,
  PageCommandSchema,
  PlayerCommandSchema,
  VAULT_PRIVILEGED_SURFACES,
} from "@d-op/shared"
import { describe, expect, it } from "vitest"

describe("page bridge messages", () => {
  it("accepts bounded player commands and chapters", () => {
    // Given: SEEK with ms time and a small chapter list.
    // When: parsed.
    // Then: payloads survive with sources pinned.
    expect(
      PageCommandSchema.parse({ source: "d-op-injected", type: "SEEK", timeMs: 90000 }).type,
    ).toBe("SEEK")
    const chapters = ChaptersFoundSchema.parse({
      source: "d-op-injected",
      chapters: [{ startMs: 0, endMs: 90000 }],
      durationMs: 1410000,
    })
    expect(chapters.chapters).toHaveLength(1)
  })

  it("rejects wrong-origin sources, huge payloads and unknown keys", () => {
    // Given: forged source, oversized chapter array, extra keys.
    // When: parsed.
    // Then: all fail closed.
    expect(PageCommandSchema.safeParse({ source: "evil", type: "PLAY" }).success).toBe(false)
    expect(
      ChaptersFoundSchema.safeParse({
        source: "d-op-injected",
        chapters: Array.from({ length: 501 }, () => ({ startMs: 0, endMs: 1 })),
        durationMs: 1000,
      }).success,
    ).toBe(false)
    expect(
      PageCommandSchema.safeParse({ source: "d-op-injected", type: "PLAY", manageSecret: "x" })
        .success,
    ).toBe(false)
  })
})

describe("background routing and correlation", () => {
  it("parses typed background requests with correlation", () => {
    // Given: a forward-to-player request.
    // When: parsed as an extension message.
    // Then: command and correlation id survive; reply echoes the id.
    const request = BackgroundRequestSchema.parse({
      kind: "FORWARD_TO_PLAYER",
      command: { type: "PLAYLIST_JUMP", index: 2 },
      correlationId: newCorrelationId(),
    })
    expect(request.kind).toBe("FORWARD_TO_PLAYER")
    if (request.kind !== "FORWARD_TO_PLAYER") {
      throw new Error("unreachable")
    }
    const reply = BridgeReplySchema.parse({ correlationId: request.correlationId, ok: true })
    expect(reply.correlationId).toBe(request.correlationId)
  })

  it("keeps legacy REQUEST_PLAYER and OPEN_PLAYER kinds distinct", () => {
    // Given: both legacy aliases.
    // When: parsed.
    // Then: kinds preserved (retire-or-keep is task 9's call, not ours).
    const playerUrl = "https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=pt_x"
    expect(BackgroundRequestSchema.parse({ kind: "REQUEST_PLAYER", url: playerUrl }).kind).toBe(
      "REQUEST_PLAYER",
    )
    expect(BackgroundRequestSchema.parse({ kind: "OPEN_PLAYER", url: playerUrl }).kind).toBe(
      "OPEN_PLAYER",
    )
    expect(
      BackgroundRequestSchema.safeParse({ kind: "REQUEST_PLAYER", url: "https://evil.example/" })
        .success,
    ).toBe(false)
  })

  it("correlates player commands through the extension union", () => {
    // Given: every player command kind.
    // When: parsed through the extension union.
    // Then: each narrows; unknown kinds fail.
    expect(PlayerCommandSchema.parse({ type: "PLAYLIST_STOP" }).type).toBe("PLAYLIST_STOP")
    expect(ExtensionMessageSchema.safeParse({ type: "PLAYLIST_UNKNOWN" }).success).toBe(false)
  })
})

describe("capability confinement", () => {
  it("restricts the publication vault to the background surface", () => {
    // Given: all sender surfaces.
    // When: privilege is checked.
    // Then: only background is privileged; the allowlist is exact.
    expect(isPrivilegedSurface("background")).toBe(true)
    expect(isPrivilegedSurface("player-content")).toBe(false)
    expect(isPrivilegedSurface("store-content")).toBe(false)
    expect(isPrivilegedSurface("page-main")).toBe(false)
    expect([...VAULT_PRIVILEGED_SURFACES]).toEqual(["background"])
  })

  it("throws a typed leak error when capabilities approach unprivileged surfaces", () => {
    // Given: a message carrying a manageSecret bound for a content script.
    // When: authorized for that surface.
    // Then: CapabilityLeakError names the surface and field; clean
    // background delivery passes.
    const carrier = { manageSecret: "y".repeat(43) }
    expect(() => assertMessageAllowedOnSurface(carrier, "store-content")).toThrowError(
      CapabilityLeakError,
    )
    try {
      assertMessageAllowedOnSurface(carrier, "store-content")
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityLeakError)
      if (error instanceof CapabilityLeakError) {
        expect(error.surface).toBe("store-content")
        expect(error.field).toBe("manageSecret")
      }
    }
    expect(() => assertMessageAllowedOnSurface(carrier, "background")).not.toThrow()
    expect(() =>
      assertMessageAllowedOnSurface({ type: "PLAYLIST_STOP" }, "store-content"),
    ).not.toThrow()
  })
})
