// Same-origin content-script relay for share pages (task 17). Runs in the
// extension ISOLATED world on the share site; validates every window message
// against source/origin/schema, forwards the typed request to the background
// worker, and posts back only a status ack bound to the requestId. Playlist
// JSON never crosses this boundary — the background fetches the API itself.
import {
  parseShareImportBeginReply,
  parseSharePageRequest,
  type ShareImportAck,
  type SharePageImportRequest,
  shareImportAck,
} from "./protocol"

export type ShareRelayWindow = {
  readonly location: { readonly origin: string }
  addEventListener(type: "message", listener: (event: ShareRelayMessageEvent) => void): void
  removeEventListener(type: "message", listener: (event: ShareRelayMessageEvent) => void): void
  postMessage(message: ShareImportAck, targetOrigin: string): void
}

export type ShareRelayMessageEvent = {
  readonly source: unknown
  readonly origin: string
  readonly data: unknown
}

export type ShareRelayOptions = {
  /** Forward the validated request to the extension background worker. */
  readonly forward: (request: SharePageImportRequest) => Promise<unknown>
}

/**
 * Install the relay on `win`. Validation rules (all mandatory):
 *  - `event.source === win`: the request must come from this same top window —
 *    an iframe's `parent.postMessage` carries the CHILD window as source and
 *    is rejected here (defense in depth under background's frameId check).
 *  - `event.origin === win.location.origin`: exact same-origin match; the
 *    canonical origin is enforced again by the background sender check.
 *  - payload must satisfy the strict request schema (shareId + requestId only).
 * Replies are posted to the page origin with only `{requestId, status}`.
 */
export function installShareRelay(win: ShareRelayWindow, options: ShareRelayOptions): void {
  win.addEventListener("message", (event) => {
    if (event.source !== win) return
    if (event.origin !== win.location.origin) return
    const request = parseSharePageRequest(event.data)
    if (request === undefined) return
    void options
      .forward(request)
      .then((reply) => {
        const status = parseShareImportBeginReply(reply) ?? "unavailable"
        win.postMessage(shareImportAck(request.requestId, status), win.location.origin)
      })
      .catch(() => {
        win.postMessage(shareImportAck(request.requestId, "unavailable"), win.location.origin)
      })
  })
}
