import type { UpstreamFetch } from "../../src/server/services/tag-suggest.js"

// Tag-suggestions suite helpers: stub upstream plans (AniList / しょぼカル /
// Jikan) injected through the service's fetch seam, so worker tests never
// touch a real origin, plus request builders for the route. Everything the
// service can call is answered deterministically from the plan; an unplanned
// upstream answers 500 (fail-soft target) and an unexpected URL throws.

export {
  call,
  dataOf,
  db,
  envelopeOf,
  errorOf,
  migratedDb,
} from "../publication-api/helpers.js"
export { fakeLimiter, overrideEnv, withLimiters } from "../security/helpers.js"

export const TAG_SUGGESTIONS_URL = "https://d-op.sasnews.dev/api/v1/tag-suggestions"

export type UpstreamPlan = {
  readonly anilist?: (title: string) => unknown
  readonly syoboi?: (title: string) => unknown
  readonly jikanAnime?: (title: string) => unknown
  readonly jikanManga?: Readonly<Record<number, unknown>>
}

export type FetchStub = {
  readonly fetchImpl: UpstreamFetch
  /** URLs the stub served, in call order. */
  readonly calls: string[]
}

export function stubUpstreams(plan: UpstreamPlan): FetchStub {
  const calls: string[] = []
  const fetchImpl: UpstreamFetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    const respond = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    const down = () => new Response("upstream down", { status: 500 })
    if (url.startsWith("https://graphql.anilist.co")) {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        variables?: { s?: string }
      }
      return plan.anilist !== undefined ? respond(plan.anilist(body.variables?.s ?? "")) : down()
    }
    if (url.startsWith("https://cal.syoboi.jp")) {
      const title = new URL(url).searchParams.get("Search") ?? ""
      return plan.syoboi !== undefined ? respond(plan.syoboi(title)) : down()
    }
    if (url.startsWith("https://api.jikan.moe/v4/manga/")) {
      const id = Number(url.split("/").at(-1))
      const payload = plan.jikanManga?.[id]
      return payload !== undefined ? respond(payload) : down()
    }
    if (url.startsWith("https://api.jikan.moe/v4/anime")) {
      const title = new URL(url).searchParams.get("q") ?? ""
      return plan.jikanAnime !== undefined ? respond(plan.jikanAnime(title)) : down()
    }
    throw new Error(`unexpected upstream URL in test: ${url}`)
  }
  return { fetchImpl, calls }
}

// --- upstream fixture payloads ------------------------------------------------

export function anilistPage(media: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { data: { Media: { media: [...media] } } }
}

export function anilistMedia(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    title: { native: "w", romaji: "w", english: "w" },
    synonyms: [],
    seasonYear: 2000,
    studios: { nodes: [] },
    genres: [],
    source: "ORIGINAL",
    ...overrides,
  }
}

export function syoboiTitles(
  entries: Readonly<Record<string, Record<string, unknown>>>,
): Record<string, unknown> {
  return { Titles: { ...entries } }
}

export function jikanAnimeList(
  entries: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return { data: [...entries] }
}

export function jikanManga(serialization: string): Record<string, unknown> {
  return { data: { serializations: [{ name: serialization }] } }
}

// --- request builders -----------------------------------------------------------

export type TagRequestInit = {
  readonly method?: string | undefined
  readonly body?: unknown
  readonly contentType?: string | null | undefined
  readonly ip?: string | undefined
  readonly origin?: string | undefined
}

export function tagRequest(init: TagRequestInit = {}): Request {
  const headers = new Headers()
  if (init.contentType !== null) headers.set("content-type", init.contentType ?? "application/json")
  if (init.ip !== undefined) headers.set("cf-connecting-ip", init.ip)
  if (init.origin !== undefined) headers.set("origin", init.origin)
  return new Request(TAG_SUGGESTIONS_URL, {
    method: init.method ?? "POST",
    headers,
    body:
      init.body === undefined || init.body === null
        ? null
        : typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body),
  })
}
