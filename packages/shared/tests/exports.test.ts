import * as shared from "@d-op/shared"
import { describe, expect, it } from "vitest"

// Given: task 2 reserves the @d-op/shared entrypoint without domain schemas.
// When: the workspace-linked package is imported.
// Then: it resolves to a module namespace; task 3 adds schemas and extends this file.
describe("shared package entrypoint", () => {
  it("resolves through the workspace export map", () => {
    expect(typeof shared).toBe("object")
    expect(Object.keys(shared)).toEqual([])
  })
})
