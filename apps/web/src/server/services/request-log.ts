import { newRequestId, transientFailure } from "./respond"

// Redacted structured request logging for /api/v1/* (task 14).
//
// The record shape is the privacy boundary: ONLY {event, requestId, route,
// status, durationMs} exist. `route` is a route TEMPLATE with the concrete
// method ("PATCH /api/v1/playlists/:shareId") — never a concrete URL, so
// unlisted shareIds, query strings, Authorization headers, bodies, IPs and
// SQL can never reach Workers Logs, whatever a caller sends. Anything thrown
// past a service's own error mapping is logged as a bare 503 (the error
// object may contain SQL text and is deliberately not inspected here).
export type ApiLogRecord = {
  readonly event: "api_request"
  readonly requestId: string
  readonly route: string
  readonly status: number
  readonly durationMs: number
}

export function writeApiLog(record: ApiLogRecord): void {
  console.log(JSON.stringify(record))
}

/**
 * Wraps a route handler: generates the requestId the service echoes into its
 * error envelopes, times the call, logs the redacted record, and converts a
 * thrown escape into the fixed 503 contract (defense in depth — services
 * already map their own failures).
 */
export async function loggedApiRequest(
  request: Request,
  routeTemplate: string,
  handle: (requestId: string) => Response | Promise<Response>,
): Promise<Response> {
  const requestId = newRequestId()
  const route = `${request.method} ${routeTemplate}`
  const started = Date.now()
  try {
    const response = await handle(requestId)
    writeApiLog({
      event: "api_request",
      requestId,
      route,
      status: response.status,
      durationMs: Date.now() - started,
    })
    return response
  } catch {
    writeApiLog({
      event: "api_request",
      requestId,
      route,
      status: 503,
      durationMs: Date.now() - started,
    })
    return transientFailure(requestId)
  }
}
