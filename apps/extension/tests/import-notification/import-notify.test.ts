import { describe, expect, it } from "vitest"
import type { FetchInit, FetchLike, FetchResponse } from "../../src/share/api-client"
import { notifyImportCommitted } from "../../src/share/import-notify"
import { SHARE_ID, SHARE_ORIGIN } from "../share/fixtures"

// Unit contract for the task-18 notification module: a single bounded POST
// carrying only {eventId}, credentials omitted, one immediate retry reusing
// the SAME minted event id, and every failure swallowed — the committed local
// playlist is never at stake.

type PostCall = { readonly url: string; readonly init: FetchInit }

function recordingFetch(respond: (callIndex: number) => FetchResponse | Promise<FetchResponse>): {
  readonly calls: PostCall[]
  readonly impl: FetchLike
} {
  const calls: PostCall[] = []
  const impl: FetchLike = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve(respond(calls.length - 1))
  }
  return { calls, impl }
}

const ok204 = () => new Response(null, { status: 204 })
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function eventIdOf(call: PostCall | undefined): string {
  if (call === undefined) throw new Error("expected a recorded POST call")
  const parsed = JSON.parse(String(call.init.body)) as { eventId?: unknown }
  return String(parsed.eventId)
}

describe("notifyImportCommitted", () => {
  it("POSTs {eventId} to the fixed import route with credentials omitted", async () => {
    const { calls, impl } = recordingFetch(() => ok204())
    await notifyImportCommitted({ apiOrigin: SHARE_ORIGIN, shareId: SHARE_ID, fetchImpl: impl })
    expect(calls).toHaveLength(1)
    const call = calls.at(0)
    if (call === undefined) throw new Error("expected one POST call")
    expect(call.url).toBe(`${SHARE_ORIGIN}/api/v1/playlists/${SHARE_ID}/import`)
    expect(call.init.method).toBe("POST")
    expect(call.init.credentials).toBe("omit")
    expect(call.init.redirect).toBe("error")
    expect(call.init.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(["eventId"])
    expect(String(body["eventId"])).toMatch(UUID_RE)
  })

  it("retries once with the SAME eventId after a network failure", async () => {
    const { calls, impl } = recordingFetch((index) =>
      index === 0 ? Promise.reject(new TypeError("offline")) : ok204(),
    )
    await notifyImportCommitted({ apiOrigin: SHARE_ORIGIN, shareId: SHARE_ID, fetchImpl: impl })
    expect(calls).toHaveLength(2)
    expect(eventIdOf(calls.at(0))).toBe(eventIdOf(calls.at(1)))
  })

  it("retries once on a non-ok status and stops after the bounded attempts", async () => {
    const { calls, impl } = recordingFetch(() => new Response(null, { status: 500 }))
    await notifyImportCommitted({ apiOrigin: SHARE_ORIGIN, shareId: SHARE_ID, fetchImpl: impl })
    expect(calls).toHaveLength(2)
    expect(eventIdOf(calls.at(0))).toBe(eventIdOf(calls.at(1)))
  })

  it("never throws when every attempt fails", async () => {
    const { calls, impl } = recordingFetch(() => Promise.reject(new TypeError("offline")))
    await expect(
      notifyImportCommitted({ apiOrigin: SHARE_ORIGIN, shareId: SHARE_ID, fetchImpl: impl }),
    ).resolves.toBeUndefined()
    expect(calls).toHaveLength(2)
  })

  it("mints a fresh eventId per confirmed flow", async () => {
    const { calls, impl } = recordingFetch(() => ok204())
    await notifyImportCommitted({ apiOrigin: SHARE_ORIGIN, shareId: SHARE_ID, fetchImpl: impl })
    await notifyImportCommitted({ apiOrigin: SHARE_ORIGIN, shareId: SHARE_ID, fetchImpl: impl })
    expect(calls).toHaveLength(2)
    expect(eventIdOf(calls.at(0))).not.toBe(eventIdOf(calls.at(1)))
  })

  it("honors an injected event id and a single-attempt override", async () => {
    const { calls, impl } = recordingFetch(() => Promise.reject(new TypeError("offline")))
    await notifyImportCommitted({
      apiOrigin: SHARE_ORIGIN,
      shareId: SHARE_ID,
      fetchImpl: impl,
      newId: () => "11111111-2222-4333-8444-555555555555",
      attempts: 1,
    })
    expect(calls).toHaveLength(1)
    expect(eventIdOf(calls.at(0))).toBe("11111111-2222-4333-8444-555555555555")
  })
})
