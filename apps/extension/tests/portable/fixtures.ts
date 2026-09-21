// Shared fixtures for task-11 portable import/export + detach tests.
// Synthetic data only — no real d-Anime payloads, no real secrets.
import type {
  LocalV2State,
  PublicationRecord,
  TransientState,
} from "../../../../packages/shared/src/local-model"
import { playlist } from "../domain/fixtures"

export const NOW_ISO = "2026-09-20T00:00:00.000Z"
export const OWNER_TOKEN = "11111111-2222-4333-8444-555555555555"
export const SHARE_ID = "abcdefghijklmnopqrstuv" // exactly 22 opaque chars
export const MANAGE_SECRET = "m".repeat(43)

export function publicationRecord(overrides: Partial<PublicationRecord> = {}): PublicationRecord {
  return {
    shareId: SHARE_ID,
    localPlaylistId: "p1",
    manageSecret: MANAGE_SECRET,
    revision: 2,
    contentHash: "a".repeat(64),
    sentSnapshot: '{"sent":true}',
    acknowledgedHash: "b".repeat(64),
    visibility: "public",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    state: "active",
    ...overrides,
  }
}

export function v2State(overrides: Partial<LocalV2State> = {}): LocalV2State {
  return {
    schemaVersion: 2,
    revision: 0,
    playlists: [playlist("p1"), playlist("p2", ["x"])],
    publications: [],
    pendingCreates: [],
    preferences: { windowMode: "window", collapsedPlaylists: {} },
    appliedOperations: [],
    ...overrides,
  }
}

export function transientWithPlayback(playlistId: string, index = 0): TransientState {
  return {
    schemaVersion: 1,
    generation: 0,
    playback: {
      playlistId,
      index,
      updatedAt: 1_700_000_000_000,
      ownerToken: OWNER_TOKEN,
      ownerGeneration: 1,
    },
    opedMode: { active: true, updatedAt: 1_700_000_000_000 },
  }
}
