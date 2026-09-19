import { PLAYBACK_URL_PATH, SUPPORTED_ORIGINS } from "../../../../packages/shared/src/index"
import type { ChapterParseResult } from "./chapter-parser"
import { parseChapterDocument } from "./chapter-parser"

type FetchResponse = { readonly ok: boolean; readonly arrayBuffer: () => Promise<ArrayBuffer> }
type Fetcher = (input: string, init: RequestInit) => Promise<FetchResponse>
type FetchOptions = {
  readonly url: string
  readonly origin: string
  readonly fetcher?: Fetcher
  readonly maxBytes?: number
}

export type ChapterFetchResult =
  | ChapterParseResult
  | { readonly kind: "rejected-origin" }
  | { readonly kind: "fetch-failed" }

export async function fetchChapterDocument(options: FetchOptions): Promise<ChapterFetchResult> {
  let parsed: URL
  try {
    parsed = new URL(options.url)
  } catch (error) {
    if (error instanceof TypeError) return { kind: "rejected-origin" }
    throw error
  }
  if (
    parsed.origin !== options.origin ||
    !SUPPORTED_ORIGINS.includes(parsed.origin as (typeof SUPPORTED_ORIGINS)[number]) ||
    parsed.pathname !== PLAYBACK_URL_PATH
  )
    return { kind: "rejected-origin" }
  try {
    const response = await (options.fetcher ?? fetch)(parsed.href, { credentials: "same-origin" })
    if (!response.ok) return { kind: "fetch-failed" }
    const bytes = await response.arrayBuffer()
    const maxBytes = options.maxBytes ?? 1_000_000
    if (bytes.byteLength > maxBytes)
      return { kind: "oversized", reason: "response exceeds byte limit" }
    return parseChapterDocument(new TextDecoder().decode(bytes))
  } catch {
    return { kind: "fetch-failed" }
  }
}
