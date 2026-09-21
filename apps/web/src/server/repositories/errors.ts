// Repository-layer failures. Expected guard outcomes (receipt replay, revision or
// capability conflicts) are returned as values, not thrown; this error is only for
// storage-layer surprises: transient D1 failures after bounded retries, a fired
// write assertion, or a persisted row that no longer matches its schema.
export type RepositoryErrorCode = "TRANSIENT_FAILURE" | "ASSERTION_FAILED" | "CORRUPT_ROW"

export class SnapshotRepositoryError extends Error {
  override readonly name = "SnapshotRepositoryError"
  readonly code: RepositoryErrorCode

  constructor(code: RepositoryErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}
