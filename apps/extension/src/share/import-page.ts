// Client side of the extension-owned import confirmation page (task 17).
// Browser-free: the entrypoint supplies the send function and the DOM; this
// module owns token parsing, request shapes and reply validation.
import type { ShareImportDetailsReply, ShareImportPreview } from "./protocol"

export type ImportPageSend = (message: unknown) => Promise<unknown>

export function readImportToken(search: string): string | undefined {
  const token = new URLSearchParams(search).get("t")
  return token !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
    ? token
    : undefined
}

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

function isPreview(input: unknown): input is ShareImportPreview {
  return (
    isRecord(input) &&
    typeof input["shareId"] === "string" &&
    typeof input["title"] === "string" &&
    typeof input["author"] === "string" &&
    typeof input["itemCount"] === "number" &&
    typeof input["totalDurationMs"] === "number" &&
    typeof input["revision"] === "number"
  )
}

export type DetailsResult =
  | { readonly kind: "preview"; readonly preview: ShareImportPreview }
  | { readonly kind: "error"; readonly reason: string }

export async function requestImportDetails(
  send: ImportPageSend,
  token: string,
): Promise<DetailsResult> {
  const reply: ShareImportDetailsReply | unknown = await send({
    kind: "share-import-details",
    token,
  })
  if (isRecord(reply) && reply["kind"] === "share-import-preview" && isPreview(reply["preview"])) {
    return { kind: "preview", preview: reply["preview"] }
  }
  if (
    isRecord(reply) &&
    reply["kind"] === "share-import-error" &&
    typeof reply["reason"] === "string"
  ) {
    return { kind: "error", reason: reply["reason"] }
  }
  return { kind: "error", reason: "unavailable" }
}

export type ConfirmResult =
  | { readonly status: "committed"; readonly playlistId: string; readonly title: string }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly reason: string }

function toConfirmResult(reply: unknown): ConfirmResult {
  if (!isRecord(reply) || reply["kind"] !== "share-import-result") {
    return { status: "failed", reason: "unavailable" }
  }
  if (
    reply["status"] === "committed" &&
    typeof reply["playlistId"] === "string" &&
    typeof reply["title"] === "string"
  ) {
    return { status: "committed", playlistId: reply["playlistId"], title: reply["title"] }
  }
  if (reply["status"] === "cancelled") return { status: "cancelled" }
  return {
    status: "failed",
    reason: typeof reply["reason"] === "string" ? reply["reason"] : "unavailable",
  }
}

export async function requestImportConfirm(
  send: ImportPageSend,
  token: string,
): Promise<ConfirmResult> {
  return toConfirmResult(await send({ kind: "share-import-confirm", token }))
}

export async function requestImportCancel(
  send: ImportPageSend,
  token: string,
): Promise<ConfirmResult> {
  return toConfirmResult(await send({ kind: "share-import-cancel", token }))
}

/** `180_500` → `"3:00"`; ≥1h → `"1:02:03"`. Display only, never for data. */
export function formatTotalMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mmss = `${minutes}:${String(seconds).padStart(2, "0")}`
  return hours === 0
    ? mmss
    : `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}
