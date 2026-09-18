import { describe, expect, it } from "vitest"
import {
  canonicalString,
  contentHashOf,
  SharedPlaylistSchema,
} from "../../../../packages/shared/src/index"
import vectors from "../../../../packages/shared/tests/vectors.json"

const EXPECTED_MINIMAL_DIGEST = "ed5737aa3494f3f0a1ca26c2b4256a787bef32946278048c3fc5813752bfe854"

describe("cross-runtime canonical vector", () => {
  it("reproduces the pinned canonical bytes and digest in workerd", async () => {
    const parsed = SharedPlaylistSchema.parse({
      schemaVersion: 1,
      title: "共有リスト",
      description: "",
      author: "",
      tags: [],
      visibility: "public",
      items: [
        {
          partId: "pt_base",
          title: "作品A",
          episodeTitle: "第1話",
          range: { start: 0, end: 90000, name: "OP" },
        },
      ],
    })
    expect(canonicalString(parsed)).toBe(vectors.minimalCanonical)
    expect(await contentHashOf(parsed)).toBe(EXPECTED_MINIMAL_DIGEST)
  })
})
