import { describe, expect, it } from "vitest"
import {
  formatTotalMs,
  readImportToken,
  requestImportCancel,
  requestImportConfirm,
  requestImportDetails,
} from "../../src/share/import-page"
import { SHARE_ID } from "./fixtures"

const TOKEN = "11111111-2222-4333-8444-555555555501"

describe("import page client", () => {
  it("parses a uuid token from the query string only", () => {
    expect(readImportToken(`?t=${TOKEN}`)).toBe(TOKEN)
    expect(readImportToken("?t=not-a-uuid")).toBeUndefined()
    expect(readImportToken("?other=1")).toBeUndefined()
    expect(readImportToken("")).toBeUndefined()
  })

  it("returns the preview for a well-formed details reply", async () => {
    const result = await requestImportDetails(
      async () => ({
        kind: "share-import-preview",
        preview: {
          shareId: SHARE_ID,
          title: "T",
          author: "A",
          itemCount: 2,
          totalDurationMs: 90_000,
          revision: 1,
        },
      }),
      TOKEN,
    )
    expect(result).toMatchObject({ kind: "preview", preview: { title: "T" } })
  })

  it("maps malformed/unavailable replies to bounded errors", async () => {
    for (const reply of [undefined, null, {}, { kind: "share-import-preview", preview: {} }]) {
      expect(await requestImportDetails(async () => reply, TOKEN)).toEqual({
        kind: "error",
        reason: "unavailable",
      })
    }
    expect(
      await requestImportDetails(
        async () => ({ kind: "share-import-error", reason: "not-found" }),
        TOKEN,
      ),
    ).toEqual({ kind: "error", reason: "not-found" })
  })

  it("maps confirm replies and never trusts extra fields", async () => {
    const committed = await requestImportConfirm(
      async () => ({
        kind: "share-import-result",
        status: "committed",
        playlistId: "pl",
        title: "T",
      }),
      TOKEN,
    )
    expect(committed).toEqual({ status: "committed", playlistId: "pl", title: "T" })
    const failed = await requestImportConfirm(async () => "junk", TOKEN)
    expect(failed).toEqual({ status: "failed", reason: "unavailable" })
    const cancelled = await requestImportCancel(
      async () => ({
        kind: "share-import-result",
        status: "cancelled",
      }),
      TOKEN,
    )
    expect(cancelled).toEqual({ status: "cancelled" })
  })

  it("formats durations for display", () => {
    expect(formatTotalMs(0)).toBe("0:00")
    expect(formatTotalMs(90_500)).toBe("1:30")
    expect(formatTotalMs(180_500)).toBe("3:00")
    expect(formatTotalMs(3_723_000)).toBe("1:02:03")
  })
})
