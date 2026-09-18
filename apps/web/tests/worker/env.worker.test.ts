import { describe, expect, it } from "vitest"
import { DOP_MISSING_D1_BINDING, DOpConfigurationError, requireDb } from "../../src/server/env.js"

// Given: this suite executes inside the workerd runtime via @cloudflare/vitest-plugin.
// When: the suite runs.
// Then: the runtime is workerd, and a missing D1 binding is a named error, not a fallback.
describe("worker runtime and D1 binding guard", () => {
  it("executes inside the Cloudflare Workers runtime", () => {
    expect(navigator.userAgent).toContain("Cloudflare-Workers")
  })

  it("rejects a missing D1 binding with a named error", () => {
    expect(() => requireDb({})).toThrow(DOpConfigurationError)
    let code: string | undefined
    try {
      requireDb({})
    } catch (error: unknown) {
      if (error instanceof DOpConfigurationError) {
        code = error.code
      } else {
        throw error
      }
    }
    expect(code).toBe(DOP_MISSING_D1_BINDING)
  })
})
