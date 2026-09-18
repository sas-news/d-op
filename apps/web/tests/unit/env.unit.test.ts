import { describe, expect, it } from "vitest"
import { DOP_MISSING_D1_BINDING, DOpConfigurationError, requireDb } from "../../src/server/env.js"

// Given: a Worker environment record with no D1 binding.
// When: server code requests the database handle.
// Then: a named configuration error is thrown; silent in-memory fallback is forbidden.
describe("requireDb without a D1 binding", () => {
  it("throws a named configuration error", () => {
    let caught: unknown
    try {
      requireDb({})
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DOpConfigurationError)
    if (caught instanceof DOpConfigurationError) {
      expect(caught.code).toBe(DOP_MISSING_D1_BINDING)
      expect(caught.binding).toBe("DB")
      expect(caught.message).toContain("DB")
    } else {
      throw new Error("expected DOpConfigurationError")
    }
  })
})
