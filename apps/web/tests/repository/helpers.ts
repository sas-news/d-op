import { env } from "cloudflare:test"
import type { D1Database } from "@cloudflare/workers-types"
import {
  contentHashOf,
  type SharedPlaylist,
  SharedPlaylistSchema,
} from "../../../../packages/shared/src/index"
import { type DOpEnv, requireDb } from "../../src/server/env.js"
import { sha256Hex } from "../../src/server/repositories/hashing.js"
import { migrate } from "../../src/server/repositories/migrations.js"
import { activateSnapshot } from "../../src/server/repositories/snapshots/activate.js"
import { createPendingSnapshot } from "../../src/server/repositories/snapshots/create.js"

// Shared fixtures for repository acceptance tests: real workerd D1 only (per-file
// isolated Miniflare database). No fake repository or in-memory substitute.

export function db(): D1Database {
  return requireDb(env as unknown as DOpEnv)
}

export async function migratedDb(): Promise<D1Database> {
  const database = db()
  await migrate(database, new Date("2026-01-01T00:00:00.000Z"))
  return database
}

export function base64url(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  let binary = ""
  for (const byte of raw) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

export function newShareId(): string {
  return base64url(16)
}

/** Simulates the service-side domain-separated secret hash (SHA-256 hex). */
export async function newSecretHash(shareId: string): Promise<string> {
  return sha256Hex(`dop-manage:${shareId}:${crypto.randomUUID()}`)
}

export function newOperationKey(): string {
  return crypto.randomUUID()
}

export function makePlaylist(overrides: {
  readonly title?: string
  readonly tags?: readonly string[]
  readonly visibility?: "public" | "unlisted"
  readonly itemCount?: number
  readonly itemPrefix?: string
}): SharedPlaylist {
  const count = overrides.itemCount ?? 2
  const prefix = overrides.itemPrefix ?? "pt"
  const items = Array.from({ length: count }, (_, index) => ({
    partId: `${prefix}_${index}`,
    workId: `work_${index}`,
    title: `作品${index}`,
    episodeTitle: `第${index + 1}話`,
    episodeNumber: `${index + 1}`,
    range: { start: index * 1000, end: index * 1000 + 90000, name: "OP" },
  }))
  return SharedPlaylistSchema.parse({
    schemaVersion: 1,
    title: overrides.title ?? "共有リスト",
    description: "説明文",
    author: "author",
    tags: overrides.tags ?? ["tag-one", "tag-two"],
    visibility: overrides.visibility ?? "public",
    items,
  })
}

export async function hashOf(playlist: SharedPlaylist): Promise<string> {
  return contentHashOf(playlist)
}

/** Creates a pending snapshot and activates it; the playlist ends active at revision 2. */
export async function makeActive(
  shareId: string,
  secretHash: string,
  now: Date,
  tags: readonly string[] = ["seed-tag"],
): Promise<SharedPlaylist> {
  const playlist = makePlaylist({ tags })
  const created = await createPendingSnapshot(db(), {
    shareId,
    secretHash,
    operationKey: newOperationKey(),
    playlist,
    contentHash: await hashOf(playlist),
    now,
  })
  if (created.kind !== "applied") throw new Error("setup create failed")
  const activated = await activateSnapshot(db(), {
    shareId,
    secretHash,
    operationKey: newOperationKey(),
    expectedRevision: 1,
    now,
  })
  if (activated.kind !== "applied") throw new Error("setup activate failed")
  return playlist
}

/** Builds a max-size but schema-valid playlist for D1 limit coverage. */
export function makeMaxPlaylist(): SharedPlaylist {
  const items = Array.from({ length: 200 }, (_, index) => ({
    partId: `p${index}_${"x".repeat(120)}`.slice(0, 128),
    workId: `w${"y".repeat(127)}`.slice(0, 128),
    title: "t".repeat(300),
    episodeTitle: "e".repeat(300),
    episodeNumber: "n".repeat(64),
    range: { start: 0, end: 86400000, name: "r".repeat(80) },
  }))
  return SharedPlaylistSchema.parse({
    schemaVersion: 1,
    title: "x".repeat(120),
    description: "d".repeat(2000),
    author: "a".repeat(80),
    tags: Array.from({ length: 10 }, (_, index) => `t${index}${"z".repeat(20)}`.slice(0, 24)),
    visibility: "public",
    items,
  })
}
