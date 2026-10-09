import { env } from "cloudflare:workers"
import type { D1Database } from "@cloudflare/workers-types"
import { z } from "zod"
import {
  issuePaths,
  normalizeWorkTitleKey,
  suggestPlaylistTags,
  TAG_WORK_META_TTL_MS,
  TagSuggestionRequestSchema,
  type TagSuggestionResponse,
  type TagSuggestionWork,
  type WorkTagMeta,
  workTagSet,
} from "../../../../../packages/shared/src/index"
import { requireDb } from "../env"
import { readTagWorkMeta, type TagWorkMetaRow, upsertTagWorkMeta } from "../repositories/tag-meta"
import { readJsonBody } from "../security/http"
import { checkAdmission } from "./admission"
import { fieldPaths } from "./publication"
import { dataResponse, errorResponse, transientFailure } from "./respond"

// POST /api/v1/tag-suggestions service (tag-candidate pipeline).
//
// Intake: read admission (read-class limiter + POST origin policy) -> JSON
// body -> TagSuggestionRequestSchema. For each unique normalized title the D1
// `tag_work_meta` cache is consulted first (30-day TTL); misses resolve
// against the upstreams below, all fail-soft and Zod-parsed at the boundary.
// The shared engine (`suggestPlaylistTags`) then folds every work's metadata
// into the canonical suggestion list.
//
// Upstreams (no keys, all GET/POST with credentials:"omit", redirect:"error",
// cache:"no-store", bounded bodies, ~5 s timeouts):
//   a. AniList GraphQL — title/synonym equality match; seasonYear, animation
//      studios only (isAnimationStudio filters out TV stations/labels),
//      genres, source.
//   b. しょぼいカレンダー TitleSearch — normalized match on
//      Title/ShortTitle/TitleYomi/TitleEN preferring Cat 10 (anime);
//      FirstCh raw broadcasters + FirstYear (wins over AniList seasonYear).
//   c. Jikan — best-effort demographics, and when AniList says the source is
//      MANGA, the adaptation's serialization (掲載誌). Globally rate-limited;
//      any failure silently skips the axis, it never fails the request.

const UPSTREAM_TIMEOUT_MS = 5000
const UPSTREAM_RESPONSE_MAX_BYTES = 1048576
const RESOLVE_CONCURRENCY = 4
const JIKAN_MAX_CALLS_PER_WORK = 2

/** Injectable fetch seam: tests substitute stub upstreams (never real origins). */
export type UpstreamFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export type TagSuggestDeps = {
  readonly fetchImpl?: UpstreamFetch | undefined
  readonly now?: Date | undefined
}

export async function suggestTags(
  request: Request,
  requestId: string,
  deps: TagSuggestDeps = {},
): Promise<Response> {
  try {
    // A POST route takes the mutation origin policy (foreign browser origins
    // are rejected) but the read-class rate limit — it mutates nothing.
    const denied = await checkAdmission({ env, request, requestId, cls: "read", mutation: true })
    if (denied !== null) return denied
    const body = await readJsonBody(request)
    if (!body.ok) return errorResponse({ ...body.failure, requestId })
    const parsed = TagSuggestionRequestSchema.safeParse(body.value)
    if (!parsed.success) {
      return errorResponse({
        status: 400,
        code: "BAD_REQUEST",
        message: "request body does not match the tag suggestion schema",
        requestId,
        details: fieldPaths(issuePaths(parsed.error)),
      })
    }
    const db = requireDb(env)
    const now = deps.now ?? new Date()
    const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init))
    const metasByKey = await resolveMetas(db, parsed.data.works, fetchImpl, now)
    const ordered = parsed.data.works.map((work) => {
      const meta = metasByKey.get(normalizeWorkTitleKey(work.title))
      if (meta === undefined) {
        throw new Error(`unresolved work meta for title key ${normalizeWorkTitleKey(work.title)}`)
      }
      return meta
    })
    const seenUnmatched = new Set<string>()
    const response: TagSuggestionResponse = {
      tags: suggestPlaylistTags(ordered),
      unmatched: ordered
        .filter((meta) => !meta.matched)
        .map((meta) => meta.title)
        .filter((title) => {
          if (seenUnmatched.has(title)) return false
          seenUnmatched.add(title)
          return true
        }),
      perWork: parsed.data.works.map((work, index) => {
        const meta = ordered[index] as WorkTagMeta
        return {
          title: work.title,
          matched: meta.matched,
          tags: meta.matched ? workTagSet(meta) : [],
        }
      }),
    }
    return dataResponse(response, 200)
  } catch {
    return transientFailure(requestId)
  }
}

// --- metadata resolution -----------------------------------------------------

type CachePayload = Omit<WorkTagMeta, "title">

const CachePayloadSchema = z.object({
  matched: z.boolean(),
  workId: z.string().optional(),
  year: z.number().int().optional(),
  broadcasters: z.array(z.string()),
  demographics: z.array(z.string()),
  studios: z.array(z.string()),
  source: z.string().optional(),
  magazine: z.string().optional(),
  genres: z.array(z.string()),
})

async function resolveMetas(
  db: D1Database,
  works: readonly TagSuggestionWork[],
  fetchImpl: UpstreamFetch,
  now: Date,
): Promise<ReadonlyMap<string, WorkTagMeta>> {
  const unique = new Map<string, TagSuggestionWork>()
  for (const work of works) {
    const key = normalizeWorkTitleKey(work.title)
    if (!unique.has(key)) unique.set(key, work)
  }
  const metas = new Map<string, WorkTagMeta>()
  const misses: { readonly key: string; readonly work: TagSuggestionWork }[] = []
  await Promise.all(
    [...unique.entries()].map(async ([key, work]) => {
      const cached = await readFreshCachedMeta(db, key, work.title, now)
      if (cached !== null) metas.set(key, cached)
      else misses.push({ key, work })
    }),
  )
  // One work's resolution must never sink the whole request: an unexpected
  // throw degrades that title to an uncached unmatched meta.
  const resolved = await mapWithConcurrency(misses, RESOLVE_CONCURRENCY, ({ work }) =>
    resolveWorkMeta(work, fetchImpl).catch(
      (): ResolvedWorkMeta => ({ meta: emptyMeta(work), cacheable: false }),
    ),
  )
  await Promise.all(
    misses.map(async ({ key }, index) => {
      const outcome = resolved[index]
      if (outcome === undefined) return
      metas.set(key, outcome.meta)
      if (!outcome.cacheable) return
      await upsertTagWorkMeta(db, {
        titleKey: key,
        workId: outcome.upstreamWorkId ?? outcome.meta.workId ?? null,
        payloadJson: JSON.stringify(cachePayloadOf(outcome.meta)),
        now,
      }).catch(() => undefined)
    }),
  )
  return metas
}

function cachePayloadOf(meta: WorkTagMeta): CachePayload {
  return {
    matched: meta.matched,
    ...(meta.workId !== undefined ? { workId: meta.workId } : {}),
    ...(meta.year !== undefined ? { year: meta.year } : {}),
    broadcasters: [...meta.broadcasters],
    demographics: [...meta.demographics],
    studios: [...meta.studios],
    ...(meta.source !== undefined ? { source: meta.source } : {}),
    ...(meta.magazine !== undefined ? { magazine: meta.magazine } : {}),
    genres: [...meta.genres],
  }
}

/** Cache read: fresh (TTL) and well-formed payload, else null. Cache-layer
 *  failures degrade to a miss — the cache must never break the endpoint. */
async function readFreshCachedMeta(
  db: D1Database,
  titleKey: string,
  title: string,
  now: Date,
): Promise<WorkTagMeta | null> {
  let row: TagWorkMetaRow | null
  try {
    row = await readTagWorkMeta(db, titleKey)
  } catch {
    return null
  }
  if (row === null) return null
  const fetchedAt = Date.parse(row.fetchedAt)
  if (!Number.isFinite(fetchedAt) || now.getTime() - fetchedAt > TAG_WORK_META_TTL_MS) return null
  let payload: CachePayload
  try {
    payload = CachePayloadSchema.parse(JSON.parse(row.payloadJson))
  } catch {
    return null
  }
  return { title, ...payload }
}

type ResolvedWorkMeta = {
  readonly meta: WorkTagMeta
  /** Both primary upstreams answered definitively — only then is the
   *  outcome worth persisting for the TTL window. */
  readonly cacheable: boolean
  readonly upstreamWorkId?: string | undefined
}

async function resolveWorkMeta(
  work: TagSuggestionWork,
  fetchImpl: UpstreamFetch,
): Promise<ResolvedWorkMeta> {
  const [anilist, syoboi] = await Promise.all([
    resolveAniList(work.title, fetchImpl),
    resolveSyoboi(work.title, fetchImpl),
  ])
  // Cache only when BOTH primary upstreams answered definitively — a hit or
  // miss from a flaky/absent peer would otherwise freeze partial metadata
  // (e.g. missing broadcasters) into the 30-day cache. Jikan is best-effort
  // by design and never gates cacheability.
  const complete = anilist.responded && syoboi.responded
  const matched = anilist.hit !== null || syoboi.hit !== null
  if (!matched) {
    return {
      meta: emptyMeta(work),
      cacheable: complete,
    }
  }
  const jikan = await resolveJikan(work.title, fetchImpl, anilist.hit?.source)
  return {
    meta: {
      title: work.title,
      matched: true,
      ...(work.workId !== undefined ? { workId: work.workId } : {}),
      // しょぼカル FirstYear wins over AniList seasonYear (first-broadcast year).
      ...(syoboi.hit?.firstYear !== undefined || anilist.hit?.seasonYear !== undefined
        ? { year: syoboi.hit?.firstYear ?? anilist.hit?.seasonYear }
        : {}),
      broadcasters: syoboi.hit?.broadcasters ?? [],
      demographics: jikan?.demographics ?? [],
      studios: anilist.hit?.studios ?? [],
      ...(anilist.hit?.source !== undefined ? { source: anilist.hit.source } : {}),
      ...(jikan?.magazine !== undefined ? { magazine: jikan.magazine } : {}),
      genres: anilist.hit?.genres ?? [],
    },
    cacheable: complete,
    upstreamWorkId: anilist.hit?.id !== undefined ? String(anilist.hit.id) : undefined,
  }
}

function emptyMeta(work: TagSuggestionWork): WorkTagMeta {
  return {
    title: work.title,
    ...(work.workId !== undefined ? { workId: work.workId } : {}),
    matched: false,
    broadcasters: [],
    demographics: [],
    studios: [],
    genres: [],
  }
}

// --- upstream plumbing -------------------------------------------------------

/** Fixed fetch policy + bounded body + JSON parse. Any failure -> null. */
async function fetchUpstreamJson(
  fetchImpl: UpstreamFetch,
  url: string,
  init?: RequestInit,
): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url, {
      ...init,
      credentials: "omit",
      // workerd does not implement redirect:"error" (it throws TypeError):
      // "manual" plus the !response.ok gate below refuses redirects instead.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    const text = await readBoundedText(response, UPSTREAM_RESPONSE_MAX_BYTES)
    if (!response.ok || text === null) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      return null
    }
  } catch {
    return null
  }
}

/** Same stream-bounded read as request intake: the byte cap is enforced while
 *  reading, never trusted to Content-Length alone. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = response.headers.get("content-length")
  if (declared !== null) {
    const parsed = Number(declared)
    if (Number.isFinite(parsed) && parsed > maxBytes) return null
  }
  const stream = response.body
  if (stream === null) return ""
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      const item = items[index]
      if (item !== undefined) results[index] = await fn(item)
    }
  })
  await Promise.all(runners)
  return results
}

// --- AniList ------------------------------------------------------------------
// Upstream payloads carry fields beyond what the service consumes, so these
// schemas are intentionally non-strict (unknown keys are stripped, not
// rejected) — unlike the fixed request/response contract in shared/api.ts.

const ANILIST_ENDPOINT = "https://graphql.anilist.co"
const ANILIST_QUERY = `query($s: String) {
  Media: Page(perPage: 6) {
    media(search: $s, type: ANIME, isAdult: false) {
      id
      title { native romaji english }
      synonyms
      seasonYear
      studios { nodes { name isAnimationStudio } }
      genres
      source
    }
  }
}`

const AniListMediaSchema = z.object({
  id: z.number().int().optional(),
  title: z
    .object({
      native: z.string().nullable().optional(),
      romaji: z.string().nullable().optional(),
      english: z.string().nullable().optional(),
    })
    .optional(),
  synonyms: z.array(z.string()).optional(),
  seasonYear: z.number().int().nullable().optional(),
  studios: z
    .object({
      nodes: z.array(z.object({ name: z.string(), isAnimationStudio: z.boolean().optional() })),
    })
    .optional(),
  genres: z.array(z.string()).optional(),
  source: z.string().nullable().optional(),
})
const AniListResponseSchema = z.object({
  data: z
    .object({
      Media: z
        .object({ media: z.array(AniListMediaSchema) })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
})

type AniListHit = {
  readonly id?: number | undefined
  readonly seasonYear?: number | undefined
  readonly studios: string[]
  readonly genres: string[]
  readonly source?: string | undefined
}

type UpstreamOutcome<Hit> =
  | { readonly responded: true; readonly hit: Hit | null }
  | { readonly responded: false; readonly hit: null }

async function resolveAniList(
  title: string,
  fetchImpl: UpstreamFetch,
): Promise<UpstreamOutcome<AniListHit>> {
  const json = await fetchUpstreamJson(fetchImpl, ANILIST_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { s: title } }),
  })
  if (json === null) return { responded: false, hit: null }
  const parsed = AniListResponseSchema.safeParse(json)
  if (!parsed.success) return { responded: false, hit: null }
  const key = normalizeWorkTitleKey(title)
  const media = parsed.data.data?.Media?.media ?? []
  const hit = media.find((candidate) =>
    [
      candidate.title?.native,
      candidate.title?.romaji,
      candidate.title?.english,
      ...(candidate.synonyms ?? []),
    ].some((name) => name != null && normalizeWorkTitleKey(name) === key),
  )
  if (hit === undefined) return { responded: true, hit: null }
  return {
    responded: true,
    hit: {
      ...(hit.id !== undefined ? { id: hit.id } : {}),
      ...(hit.seasonYear != null ? { seasonYear: hit.seasonYear } : {}),
      // Animation studios only — AniList also lists broadcasters/labels
      // (TV Tokyo, Dentsu…) which the flag excludes.
      studios: (hit.studios?.nodes ?? [])
        .filter((node) => node.isAnimationStudio === true)
        .map((node) => node.name),
      genres: hit.genres ?? [],
      ...(hit.source != null ? { source: hit.source } : {}),
    },
  }
}

// --- しょぼいカレンダー ---------------------------------------------------------

const SYOBOI_ENDPOINT = "https://cal.syoboi.jp/json.php"

const SyoboiTitleSchema = z.object({
  Title: z.string().optional(),
  ShortTitle: z.string().optional(),
  TitleYomi: z.string().optional(),
  TitleEN: z.string().optional(),
  FirstCh: z.string().optional(),
  FirstYear: z.union([z.string(), z.number()]).optional(),
  Cat: z.union([z.string(), z.number()]).optional(),
})
const SyoboiResponseSchema = z.object({
  Titles: z.record(z.string(), SyoboiTitleSchema).optional(),
})

type SyoboiHit = {
  readonly broadcasters: string[]
  readonly firstYear?: number | undefined
}

async function resolveSyoboi(
  title: string,
  fetchImpl: UpstreamFetch,
): Promise<UpstreamOutcome<SyoboiHit>> {
  const url = `${SYOBOI_ENDPOINT}?Req=TitleSearch&Search=${encodeURIComponent(title)}&Limit=8`
  const json = await fetchUpstreamJson(fetchImpl, url)
  if (json === null) return { responded: false, hit: null }
  const parsed = SyoboiResponseSchema.safeParse(json)
  if (!parsed.success) return { responded: false, hit: null }
  const key = normalizeWorkTitleKey(title)
  const entries = Object.values(parsed.data.Titles ?? {})
  const matches = entries.filter((entry) =>
    [entry.Title, entry.ShortTitle, entry.TitleYomi, entry.TitleEN].some(
      (name) => name !== undefined && normalizeWorkTitleKey(name) === key,
    ),
  )
  // Cat 10 marks anime entries; prefer it when several rows match.
  const hit = matches.find((entry) => String(entry.Cat ?? "") === "10") ?? matches[0]
  if (hit === undefined) return { responded: true, hit: null }
  const firstYear = Number(hit.FirstYear)
  return {
    responded: true,
    hit: {
      broadcasters: (hit.FirstCh ?? "")
        .split(/[,、]/)
        .map((channel) => channel.trim())
        .filter((channel) => channel !== ""),
      ...(Number.isFinite(firstYear) ? { firstYear } : {}),
    },
  }
}

// --- Jikan (best-effort) -------------------------------------------------------
// Globally rate-limited (~3 req/s shared); every failure degrades silently.

const JIKAN_ENDPOINT = "https://api.jikan.moe/v4"

const JikanAnimeSchema = z.object({
  title: z.string().optional(),
  title_english: z.string().nullable().optional(),
  title_japanese: z.string().nullable().optional(),
  title_synonyms: z.array(z.string()).optional(),
  demographics: z.array(z.object({ name: z.string().optional() })).optional(),
  relations: z
    .array(
      z.object({
        entry: z
          .array(z.object({ mal_id: z.number().int().optional(), type: z.string().optional() }))
          .optional(),
      }),
    )
    .optional(),
})
const JikanAnimeListSchema = z.object({ data: z.array(JikanAnimeSchema).optional() })
const JikanMangaSchema = z.object({
  data: z
    .object({ serializations: z.array(z.object({ name: z.string().optional() })).optional() })
    .nullable()
    .optional(),
})

type JikanAxes = {
  readonly demographics: string[]
  readonly magazine?: string | undefined
}

async function resolveJikan(
  title: string,
  fetchImpl: UpstreamFetch,
  anilistSource: string | undefined,
): Promise<JikanAxes | null> {
  try {
    let calls = 0
    const animeJson = await fetchUpstreamJson(
      fetchImpl,
      `${JIKAN_ENDPOINT}/anime?q=${encodeURIComponent(title)}&limit=1`,
    )
    calls += 1
    if (animeJson === null) return null
    const parsed = JikanAnimeListSchema.safeParse(animeJson)
    if (!parsed.success) return null
    const anime = parsed.data.data?.[0]
    if (anime === undefined) return null
    const key = normalizeWorkTitleKey(title)
    const titleMatches = [
      anime.title,
      anime.title_english,
      anime.title_japanese,
      ...(anime.title_synonyms ?? []),
    ].some((name) => name != null && normalizeWorkTitleKey(name) === key)
    if (!titleMatches) return null
    const demographics = (anime.demographics ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => name !== undefined)
    // 掲載誌: only when the original is a manga — follow the adaptation
    // relation and read its serialization. Second and last Jikan call.
    let magazine: string | undefined
    if (anilistSource === "MANGA" && calls < JIKAN_MAX_CALLS_PER_WORK) {
      const mangaId = (anime.relations ?? [])
        .flatMap((relation) => relation.entry ?? [])
        .find((entry) => entry.type === "manga" && entry.mal_id !== undefined)?.mal_id
      if (mangaId !== undefined) {
        const mangaJson = await fetchUpstreamJson(fetchImpl, `${JIKAN_ENDPOINT}/manga/${mangaId}`)
        if (mangaJson !== null) {
          const manga = JikanMangaSchema.safeParse(mangaJson)
          const name = manga.success ? manga.data.data?.serializations?.[0]?.name : undefined
          if (name !== undefined) magazine = name
        }
      }
    }
    return { demographics, ...(magazine !== undefined ? { magazine } : {}) }
  } catch {
    return null
  }
}
