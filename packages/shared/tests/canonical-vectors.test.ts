// Shared limits and hand-authored canonical vectors (task 3).
// The canonical strings below are written by hand from the spec (fixed key
// order, normalized values, absent optionals omitted, tags sorted, item order
// kept). Hashes are pinned only after Node + workerd + browser agreement;
// until then the agreement assertions carry the proof.
import {
  canonicalString,
  contentHashOf,
  LOCAL_IMPORT_FILE_MAX_BYTES,
  LOCAL_IMPORT_MAX_ITEMS,
  SHARE_ITEMS_MAX,
  SHARE_REQUEST_BODY_MAX_BYTES,
  SHARE_SCHEMA_VERSION,
  SUPPORTED_ORIGINS,
} from "@d-op/shared"
import { describe, expect, it } from "vitest"
import vectors from "./vectors.json"

export const HAND_CANONICAL_MINIMAL: string = vectors.minimalCanonical

// Pinned only after Node + workerd + browser agreement (evidence
// task-3-d-op-v2-share/{node,workerd,browser}-vector.log). Changing the
// canonical spec must update this digest in all three runtime logs.
export const EXPECTED_MINIMAL_DIGEST =
  "ed5737aa3494f3f0a1ca26c2b4256a787bef32946278048c3fc5813752bfe854"

describe("limits match the plan", () => {
  it("pins share/local budget constants", () => {
    // Given: the contract constants.
    // When: read.
    // Then: 256 KiB share body, 10 MiB / 10 000-item local import, 200 items.
    expect(SHARE_REQUEST_BODY_MAX_BYTES).toBe(262144)
    expect(LOCAL_IMPORT_FILE_MAX_BYTES).toBe(10485760)
    expect(LOCAL_IMPORT_MAX_ITEMS).toBe(10000)
    expect(SHARE_ITEMS_MAX).toBe(200)
    expect(SHARE_SCHEMA_VERSION).toBe(1)
    expect([...SUPPORTED_ORIGINS]).toEqual([
      "https://animestore.docomo.ne.jp",
      "https://anime.dmkt-sp.jp",
    ])
  })
})

describe("hand-authored canonical vectors", () => {
  it("matches the hand-written minimal canonical string", async () => {
    // Given: the parsed minimal share playlist (see share.test.ts base).
    // When: canonicalized.
    // Then: byte-identical to the hand-authored string from the spec.
    const { SharedPlaylistSchema } = await import("@d-op/shared")
    const { makeShareBase } = await import("./fixtures")
    const parsed = SharedPlaylistSchema.parse(makeShareBase())
    expect(canonicalString(parsed)).toBe(HAND_CANONICAL_MINIMAL)
  })

  it("hashes the hand-written string identically to the parsed playlist", async () => {
    // Given: the hand-authored canonical string (independent of the
    // serializer) and the parsed playlist.
    // When: both are hashed through the shared SHA-256 path.
    // Then: digests agree — the vector is anchored to the string, not to
    // the implementation that produced it.
    const { sha256HexBytes, canonicalBytes } = await import("@d-op/shared")
    const { SharedPlaylistSchema } = await import("@d-op/shared")
    const { makeShareBase } = await import("./fixtures")
    const parsed = SharedPlaylistSchema.parse(makeShareBase())
    const fromString = await sha256HexBytes(canonicalBytes(HAND_CANONICAL_MINIMAL))
    expect(await contentHashOf(parsed)).toBe(fromString)
    expect(fromString).toBe(EXPECTED_MINIMAL_DIGEST)
  })
})
