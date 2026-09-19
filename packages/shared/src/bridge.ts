// Extension bridge and sender-surface contracts (task 3).
// Main-world traffic carries bounded player data/commands only — never
// storage or share capabilities. Extension-internal messages correlate
// commands with replies via UUID correlation ids. No DOM/Worker imports.
import { z } from "zod"
import { assertNever, MsIntSchema, PLAYBACK_URL_PATH, SUPPORTED_ORIGINS } from "./limits"

export const PAGE_MESSAGE_SOURCE = "d-op-injected" as const

// --- Main-world (page) messages ------------------------------------------------------

export const PageCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    source: z.literal(PAGE_MESSAGE_SOURCE),
    type: z.literal("SEEK"),
    timeMs: MsIntSchema,
  }),
  z.strictObject({ source: z.literal(PAGE_MESSAGE_SOURCE), type: z.literal("PLAY") }),
  z.strictObject({ source: z.literal(PAGE_MESSAGE_SOURCE), type: z.literal("PAUSE") }),
  z.strictObject({ source: z.literal(PAGE_MESSAGE_SOURCE), type: z.literal("BLOCK_AUTO_ADVANCE") }),
  z.strictObject({
    source: z.literal(PAGE_MESSAGE_SOURCE),
    type: z.literal("UNBLOCK_AUTO_ADVANCE"),
  }),
  z.strictObject({ source: z.literal(PAGE_MESSAGE_SOURCE), type: z.literal("GO_NEXT") }),
])
export type PageCommand = z.infer<typeof PageCommandSchema>

const BridgeChapterSchema = z.strictObject({
  startMs: MsIntSchema,
  endMs: MsIntSchema,
})

export const ChaptersFoundSchema = z
  .strictObject({
    source: z.literal(PAGE_MESSAGE_SOURCE),
    chapters: z.array(BridgeChapterSchema).max(500),
    durationMs: MsIntSchema,
  })
  .refine((found) => found.chapters.every((chapter) => chapter.startMs < chapter.endMs), {
    message: "chapter start must be before chapter end",
    path: ["chapters"],
  })
export type ChaptersFound = z.infer<typeof ChaptersFoundSchema>

// --- Extension-internal messages -----------------------------------------------------------

const PlayerUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (url) => {
      try {
        const parsed = new URL(url)
        return (
          SUPPORTED_ORIGINS.includes(parsed.origin as (typeof SUPPORTED_ORIGINS)[number]) &&
          parsed.pathname === PLAYBACK_URL_PATH &&
          parsed.username === "" &&
          parsed.password === "" &&
          parsed.hash === ""
        )
      } catch {
        return false
      }
    },
    {
      message: "player url must stay on a supported d-Anime origin",
    },
  )

export const PlayerCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("PLAYLIST_PREV") }),
  z.strictObject({ type: z.literal("PLAYLIST_NEXT") }),
  z.strictObject({ type: z.literal("PLAYLIST_STOP") }),
  z.strictObject({ type: z.literal("PLAYLIST_JUMP"), index: z.number().int().min(0) }),
])
export type PlayerCommand = z.infer<typeof PlayerCommandSchema>

export const BackgroundRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("REQUEST_PLAYER"), url: PlayerUrlSchema }),
  z.strictObject({ kind: z.literal("OPEN_PLAYER"), url: PlayerUrlSchema }),
  z.strictObject({ kind: z.literal("RELEASE_PLAYER") }),
  z.strictObject({
    kind: z.literal("FORWARD_TO_PLAYER"),
    command: PlayerCommandSchema,
    correlationId: z.uuid(),
  }),
])
export type BackgroundRequest = z.infer<typeof BackgroundRequestSchema>

export const ExtensionMessageSchema = z.union([BackgroundRequestSchema, PlayerCommandSchema])
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>

export const BridgeReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ correlationId: z.uuid(), ok: z.literal(true) }),
  z.strictObject({
    correlationId: z.uuid(),
    ok: z.literal(false),
    error: z.strictObject({ code: z.string().min(1), message: z.string().min(1) }),
  }),
])
export type BridgeReply = z.infer<typeof BridgeReplySchema>

/** Fresh UUID correlation id from globalThis crypto (all runtimes). */
export function newCorrelationId(): string {
  return crypto.randomUUID()
}

// --- Sender surfaces and capability confinement ---------------------------------------------

export const SENDER_SURFACES = [
  "background",
  "player-content",
  "store-content",
  "popup",
  "options",
  "page-main",
] as const
export type SenderSurface = (typeof SENDER_SURFACES)[number]

/** The only surface allowed to carry the publication vault capability. */
export const VAULT_PRIVILEGED_SURFACES = ["background"] as const

export function isPrivilegedSurface(surface: SenderSurface): boolean {
  switch (surface) {
    case "background":
      return true
    case "player-content":
    case "store-content":
    case "popup":
    case "options":
    case "page-main":
      return false
    default:
      return assertNever(surface)
  }
}

export class CapabilityLeakError extends Error {
  override readonly name = "CapabilityLeakError"
  readonly surface: SenderSurface
  readonly field: string
  constructor(surface: SenderSurface, field: string) {
    super(`capability field ${field} must never cross the ${surface} surface`)
    this.surface = surface
    this.field = field
  }
}

const CAPABILITY_FIELDS = ["manageSecret", "shareSecret", "capability"] as const
type CapabilityCarrier = {
  readonly manageSecret?: unknown
  readonly shareSecret?: unknown
  readonly capability?: unknown
}

/** Reject capability-bearing payloads bound for unprivileged surfaces. */
export function assertMessageAllowedOnSurface(message: unknown, surface: SenderSurface): void {
  if (isPrivilegedSurface(surface)) {
    return
  }
  if (typeof message !== "object" || message === null) {
    return
  }
  const carrier = message as CapabilityCarrier
  for (const field of CAPABILITY_FIELDS) {
    if (carrier[field] !== undefined) {
      throw new CapabilityLeakError(surface, field)
    }
  }
}

/** Human-readable kind label for any extension message (exhaustive). */
export function describeExtensionMessage(message: ExtensionMessage): string {
  if ("kind" in message) {
    switch (message.kind) {
      case "REQUEST_PLAYER":
        return "request-player"
      case "OPEN_PLAYER":
        return "open-player"
      case "RELEASE_PLAYER":
        return "release-player"
      case "FORWARD_TO_PLAYER":
        return "forward-to-player"
      default:
        return assertNever(message)
    }
  }
  switch (message.type) {
    case "PLAYLIST_PREV":
      return "playlist-prev"
    case "PLAYLIST_NEXT":
      return "playlist-next"
    case "PLAYLIST_STOP":
      return "playlist-stop"
    case "PLAYLIST_JUMP":
      return "playlist-jump"
    default:
      return assertNever(message)
  }
}
