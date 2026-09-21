import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import {
  type ListResponse,
  ListResponseSchema,
  SharedPlaylistSchema,
} from "../../../../packages/shared/src/index"
import { GET as listRoute } from "../../src/pages/api/v1/playlists/index.js"
import { GET as tagsRoute } from "../../src/pages/api/v1/playlists/tags.js"
import { snapshotFields } from "../../src/server/repositories/snapshots/internal.js"
import { generateShareId } from "../../src/server/security/capability.js"
import { listCollection } from "../../src/server/services/discover.js"
import { call, db, makePlaylist, migratedDb } from "../publication-api/helpers.js"

// Shared fixtures for the discovery suite (task 19). Rows are seeded DIRECTLY
// into the per-file Miniflare D1 — importing through POST+PATCH would pin
// first_published_at to wall time and entangle the create rate class; direct
// seeds give exact timestamps, scores and states, which is what the window
// matrix needs. All reads still go through the real route/service engine.

export { call, db, makePlaylist, migratedDb }

export const API = "https://d-op.sasnews.dev/api/v1/playlists"

export type SeedPlaylistOptions = {
  readonly title?: string
  readonly description?: string
  readonly author?: string
  readonly tags?: readonly string[]
  readonly visibility?: "public" | "unlisted"
  readonly blocked?: boolean
  readonly pending?: boolean
  readonly firstPublishedAt?: string | null
  readonly importCount?: number
  readonly derivedFrom?: { readonly shareId: string; readonly revision: number }
}

/** Inserts a playlists row + canonical tag links, mirroring the write path. */
export async function seedPlaylist(
  database: D1Database,
  options: SeedPlaylistOptions = {},
): Promise<string> {
  const shareId = generateShareId()
  const playlist = SharedPlaylistSchema.parse({
    ...makePlaylist({
      ...(options.title === undefined ? {} : { title: options.title }),
      tags: options.tags ?? [],
      visibility: options.visibility ?? "public",
    }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.author === undefined ? {} : { author: options.author }),
    ...(options.derivedFrom === undefined ? {} : { derivedFrom: options.derivedFrom }),
  })
  const fields = snapshotFields(playlist)
  const now = new Date().toISOString()
  const pending = options.pending === true
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO playlists (
           share_id, revision, state, secret_hash, snapshot_json, content_hash, title,
           description, author, search_text, visibility, tags_json, item_count,
           total_duration_ms, import_count, derived_from_share_id, derived_from_revision,
           blocked, created_at, first_published_at, updated_at, activation_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        shareId,
        pending ? 1 : 2,
        pending ? "pending" : "active",
        "0".repeat(64),
        JSON.stringify(playlist),
        "1".repeat(64),
        fields.title,
        fields.description,
        fields.author,
        fields.searchText,
        fields.visibility,
        fields.tagsJson,
        fields.itemCount,
        fields.totalDurationMs,
        options.importCount ?? 0,
        fields.derivedFromShareId,
        fields.derivedFromRevision,
        options.blocked === true ? 1 : 0,
        now,
        pending ? null : (options.firstPublishedAt ?? now),
        now,
        pending ? new Date(Date.now() + 3_600_000).toISOString() : null,
      ),
  ]
  for (const tag of playlist.tags) {
    statements.push(
      database.prepare("INSERT INTO tags (tag) VALUES (?) ON CONFLICT (tag) DO NOTHING").bind(tag),
      database
        .prepare(
          `INSERT INTO playlist_tags (share_id, tag_id)
           SELECT ?, tag_id FROM tags WHERE tag = ?`,
        )
        .bind(shareId, tag),
    )
  }
  await database.batch(statements)
  return shareId
}

/**
 * Bulk-seeds `count` minimal public active playlists (no tags) in chunked
 * batches — for the >1000-candidate truncation path where per-row round
 * trips would be too slow. Returns the generated shareIds in insert order.
 */
export async function seedMany(
  database: D1Database,
  count: number,
  firstPublishedAt = "2026-01-01T00:00:00.000Z",
): Promise<string[]> {
  const shareIds: string[] = []
  let pending: D1PreparedStatement[] = []
  const flush = async () => {
    if (pending.length > 0) {
      await database.batch(pending)
      pending = []
    }
  }
  for (let i = 0; i < count; i += 1) {
    const shareId = generateShareId()
    shareIds.push(shareId)
    const playlist = makePlaylist({ title: `bulk ${i}`, tags: [] })
    const fields = snapshotFields(playlist)
    pending.push(
      database
        .prepare(
          `INSERT INTO playlists (
             share_id, revision, state, secret_hash, snapshot_json, content_hash, title,
             description, author, search_text, visibility, tags_json, item_count,
             total_duration_ms, import_count, derived_from_share_id, derived_from_revision,
             blocked, created_at, first_published_at, updated_at, activation_expires_at)
           VALUES (?, 2, 'active', ?, ?, ?, ?, ?, ?, ?, 'public', '[]', ?, ?, 0, NULL, NULL, 0, ?, ?, ?, NULL)`,
        )
        .bind(
          shareId,
          "0".repeat(64),
          JSON.stringify(playlist),
          "1".repeat(64),
          fields.title,
          fields.description,
          fields.author,
          fields.searchText,
          fields.itemCount,
          fields.totalDurationMs,
          firstPublishedAt,
          firstPublishedAt,
          firstPublishedAt,
        ),
    )
    if (pending.length >= 200) await flush()
  }
  await flush()
  return shareIds
}

/**
 * Mirrors the real accounting pair: a UTC-day bucket row AND the lifetime
 * counter on the playlist row move together, exactly like the guarded import
 * batch. Tests place `day` freely to position an event inside/outside a
 * window relative to the injected clock.
 */
export async function seedImport(
  database: D1Database,
  shareId: string,
  day: string,
  count = 1,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `INSERT INTO import_daily (share_id, day, count) VALUES (?, ?, ?)
         ON CONFLICT (share_id, day) DO UPDATE SET count = import_daily.count + excluded.count`,
      )
      .bind(shareId, day, count),
    database
      .prepare("UPDATE playlists SET import_count = import_count + ? WHERE share_id = ?")
      .bind(count, shareId),
  ])
}

/** UTC YYYY-MM-DD `days` before `base`'s day. */
export function dayBefore(base: Date, days: number): string {
  return new Date(base.getTime() - days * 86_400_000).toISOString().slice(0, 10)
}

export function listRequest(params: Record<string, string> = {}): Request {
  const query = new URLSearchParams(params).toString()
  return new Request(`${API}${query === "" ? "" : `?${query}`}`, { method: "GET" })
}

/** Collection through the real Astro GET route (wall clock). */
export function listViaRoute(request: Request): Promise<Response> {
  return call(listRoute, request)
}

/** Collection through the service with an injected clock — deterministic. */
export function listAt(request: Request, now: Date): Promise<Response> {
  return listCollection(request, crypto.randomUUID(), { now })
}

export function tagsViaRoute(): Promise<Response> {
  return call(tagsRoute, new Request(`${API}/tags`, { method: "GET" }))
}

/** Parses {data} AND re-validates the payload against the shared contract. */
export async function listData(res: Response): Promise<ListResponse> {
  const body = (await res.json()) as { data?: unknown; error?: unknown }
  if (body.data === undefined) {
    throw new Error(`expected data envelope, got ${JSON.stringify(body.error ?? body)}`)
  }
  return ListResponseSchema.parse(body.data)
}

/** Reads the unsigned payload half of an opaque cursor (test introspection). */
export function cursorPayload(cursor: string): { s: string; o: number; f: string } {
  const body = cursor.split(".")[0] ?? ""
  const base64 = body.replaceAll("-", "+").replaceAll("_", "/")
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as { s: string; o: number; f: string }
}

export async function snapshotCount(database: D1Database): Promise<number> {
  const row = await database
    .prepare("SELECT COUNT(*) AS n FROM discovery_snapshots")
    .first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Forces a snapshot row past its continuation window relative to the clock
 * the engine will use (`before`) — NOT wall time, so injected-clock tests
 * observe the expiry deterministically.
 */
export async function expireSnapshot(
  database: D1Database,
  snapshotId: string,
  before: Date,
): Promise<void> {
  await database
    .prepare("UPDATE discovery_snapshots SET expires_at = ? WHERE snapshot_id = ?")
    .bind(new Date(before.getTime() - 60_000).toISOString(), snapshotId)
    .run()
}
