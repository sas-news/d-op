import type { GetPlaylistResponse } from "../../../../packages/shared/src/api"
import type { LocalV2State } from "../../../../packages/shared/src/local-model"

export const SHARE_ID = "abcdefghijklmnopqrstuv" as const
export const OTHER_SHARE_ID = "ABCDEFGHIJKLMNOPQRSTUV" as const
export const SHARE_ORIGIN = "https://d-op.sasnews.dev" as const
export const DEV_ORIGIN = "http://localhost:4321" as const
export const ALLOWED_ORIGINS = [SHARE_ORIGIN, DEV_ORIGIN] as const
export const NOW = "2026-09-21T12:00:00.000Z" as const
export const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const

/** Task 22: canonical state carrying an explicit Share consent decision. */
export function consentState(
  choice: "granted" | "declined",
  overrides: Partial<LocalV2State> = {},
): LocalV2State {
  return {
    schemaVersion: 2,
    revision: 0,
    playlists: [],
    publications: [],
    pendingCreates: [],
    preferences: { windowMode: "tab", collapsedPlaylists: {} },
    appliedOperations: [],
    shareConsent: { choice, decidedAt: NOW },
    ...overrides,
  }
}

export function shareResponse(overrides: Partial<GetPlaylistResponse> = {}): GetPlaylistResponse {
  return {
    shareId: SHARE_ID,
    revision: 2,
    publishedAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T01:00:00.000Z",
    contentHash: HASH,
    playlist: {
      schemaVersion: 1,
      title: "共有リスト",
      description: "説明",
      author: "公開者",
      tags: ["op"],
      visibility: "public",
      items: [
        {
          partId: "part_1",
          workId: "work_1",
          title: "作品A",
          episodeTitle: "第1話",
          episodeNumber: "1",
          range: { start: 0, end: 90_000, name: "OP" },
        },
        {
          partId: "part_2",
          title: "作品B",
          episodeTitle: "第2話",
          range: { start: 5_000, end: 95_500 },
        },
      ],
    },
    itemCount: 2,
    totalDurationMs: 180_500,
    importCount: 0,
    source: null,
    ...overrides,
  }
}

let uuidCounter = 0
export function newUuid(): string {
  uuidCounter += 1
  return `11111111-2222-4333-8444-${String(uuidCounter).padStart(12, "0")}`
}
export function resetUuidCounter(): void {
  uuidCounter = 0
}

export function fetchJson(body: unknown, status = 200) {
  return async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
}
