// Structured player errors. Normal mode/navigation outcomes are discriminated
// results, not throws; these cover boundary failures (malformed storage
// replies, unreachable commands) where a typed error is the honest signal.
export type PlayerErrorCode =
  | "malformed-storage-reply"
  | "storage-unavailable"
  | "player-disposed"
  | "stale-generation"

export class PlayerError extends Error {
  override readonly name = "PlayerError"

  constructor(
    readonly code: PlayerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export type WindowErrorCode = "invalid-player-url" | "player-unreachable" | "window-unavailable"

export class PlayerWindowError extends Error {
  override readonly name = "PlayerWindowError"

  constructor(
    readonly code: WindowErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
