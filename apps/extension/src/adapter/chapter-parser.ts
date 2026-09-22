const MAX_DOCUMENT_BYTES = 1_000_000
const MAX_CHAPTERS = 500

export type ChapterParseResult =
  | {
      readonly kind: "ok"
      readonly chapters: readonly Chapter[]
      readonly durationMs: number | undefined
    }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "oversized"; readonly reason: string }

export type Chapter = {
  readonly startMs: number
  readonly endMs: number
  // d-Anime chapter type ("none" = skippable section; "avant"/"mainStory"/… are
  // story segments). Carried through so consumers can apply the legacy
  // type==='none' filter — v1 never treated non-none chapters as skip ranges.
  readonly type?: string | undefined
}

function balancedJsonEnd(source: string, start: number): number | undefined {
  const opening = source[start]
  if (opening !== "{" && opening !== "[") return undefined
  const stack: string[] = [opening === "{" ? "}" : "]"]
  let quoted = false
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') {
      quoted = true
      continue
    }
    if (character === "{" || character === "[") stack.push(character === "{" ? "}" : "]")
    else if (character === "}" || character === "]") {
      if (stack.pop() !== character) return undefined
      if (stack.length === 0) return index + 1
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readDocument(value: unknown): ChapterParseResult {
  if (!isRecord(value) || !Array.isArray(value["chapters"])) {
    return { kind: "malformed", reason: "chapters are required" }
  }
  const duration = value["duration"]
  // ws010105Data.duration is absent on the live site — optional like v1's
  // `durMatch ? parseInt : null`, never a hard requirement.
  if (
    value["chapters"].length > MAX_CHAPTERS ||
    (duration !== undefined &&
      (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 0))
  ) {
    return { kind: "malformed", reason: "chapter bounds exceed contract" }
  }
  const chapters: Chapter[] = []
  for (const item of value["chapters"]) {
    if (!isRecord(item)) return { kind: "malformed", reason: "invalid chapter" }
    const start = item["start"]
    const end = item["end"]
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start
    ) {
      return { kind: "malformed", reason: "invalid chapter" }
    }
    const type = item["type"]
    chapters.push({
      startMs: start,
      endMs: end,
      type: typeof type === "string" ? type : undefined,
    })
  }
  return {
    kind: "ok",
    chapters,
    durationMs: typeof duration === "number" ? duration : undefined,
  }
}

export function parseChapterDocument(html: string): ChapterParseResult {
  if (html.length > MAX_DOCUMENT_BYTES)
    return { kind: "oversized", reason: "document exceeds 1 MB" }
  const marker = '"chapters"'
  let cursor = 0
  while (cursor < html.length) {
    const markerIndex = html.indexOf(marker, cursor)
    if (markerIndex < 0) return { kind: "malformed", reason: "chapters marker missing" }
    let start = markerIndex
    while (start >= 0 && html[start] !== "{") start -= 1
    if (start >= 0) {
      const end = balancedJsonEnd(html, start)
      if (end !== undefined) {
        try {
          const parsed: unknown = JSON.parse(html.slice(start, end))
          const result = readDocument(parsed)
          if (result.kind === "ok") return result
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
        }
      }
    }
    cursor = markerIndex + marker.length
  }
  return { kind: "malformed", reason: "chapter JSON is malformed or nested in unsupported data" }
}
