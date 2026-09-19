import type { ChaptersFound, PageCommand } from "../../../../packages/shared/src/index"
import {
  ChaptersFoundSchema,
  PAGE_MESSAGE_SOURCE,
  PageCommandSchema,
} from "../../../../packages/shared/src/index"

export const PAGE_ENVELOPE_VERSION = 1 as const
export const MAX_PAGE_PAYLOAD_BYTES = 100_000 as const

type PageEnvelope =
  | { readonly source: typeof PAGE_MESSAGE_SOURCE; readonly version: 1; readonly type: "READY" }
  | {
      readonly source: typeof PAGE_MESSAGE_SOURCE
      readonly version: 1
      readonly type: "CHAPTERS"
      readonly payload: ChaptersFound
    }
  | {
      readonly source: typeof PAGE_MESSAGE_SOURCE
      readonly version: 1
      readonly type: "COMMAND"
      readonly payload: PageCommand
    }

export type ParsedPageEnvelope =
  | { readonly kind: "ready" }
  | { readonly kind: "chapters"; readonly payload: ChaptersFound }
  | { readonly kind: "command"; readonly payload: PageCommand }
  | { readonly kind: "rejected" }

function bounded(value: unknown): boolean {
  try {
    return JSON.stringify(value).length <= MAX_PAGE_PAYLOAD_BYTES
  } catch (error) {
    if (error instanceof TypeError) return false
    throw error
  }
}

export function parsePageEnvelope(
  value: unknown,
  event: { readonly origin: string; readonly source: unknown },
  origin: string,
  pageWindow: unknown,
): ParsedPageEnvelope {
  if (
    event.origin !== origin ||
    event.source !== pageWindow ||
    !bounded(value) ||
    typeof value !== "object" ||
    value === null
  )
    return { kind: "rejected" }
  const record = value as Record<string, unknown>
  if (
    record["source"] !== PAGE_MESSAGE_SOURCE ||
    record["version"] !== PAGE_ENVELOPE_VERSION ||
    typeof record["type"] !== "string"
  )
    return { kind: "rejected" }
  if (record["type"] === "READY")
    return Object.keys(record).length === 3 ? { kind: "ready" } : { kind: "rejected" }
  if (record["type"] === "CHAPTERS") {
    const parsed = ChaptersFoundSchema.safeParse(record["payload"])
    return parsed.success ? { kind: "chapters", payload: parsed.data } : { kind: "rejected" }
  }
  if (record["type"] === "COMMAND") {
    const parsed = PageCommandSchema.safeParse(record["payload"])
    return parsed.success ? { kind: "command", payload: parsed.data } : { kind: "rejected" }
  }
  return { kind: "rejected" }
}

export function readyEnvelope(): PageEnvelope {
  return { source: PAGE_MESSAGE_SOURCE, version: PAGE_ENVELOPE_VERSION, type: "READY" }
}

export function chaptersEnvelope(payload: ChaptersFound): PageEnvelope {
  return { source: PAGE_MESSAGE_SOURCE, version: PAGE_ENVELOPE_VERSION, type: "CHAPTERS", payload }
}
