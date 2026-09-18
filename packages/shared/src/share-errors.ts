export class OversizePayloadError extends Error {
  readonly name = "OversizePayloadError"
  constructor(
    readonly kind: "share-body" | "local-import",
    readonly amount: number,
    readonly limit: number,
    readonly unit: "bytes" | "items",
  ) {
    super(`${kind} of ${amount} ${unit} exceeds the ${limit}-${unit} cap`)
  }
}
export class InvalidPartIdError extends Error {
  readonly name = "InvalidPartIdError"
  constructor(readonly partId: string) {
    super(`invalid part id: ${partId}`)
  }
}
export class InvalidCanonicalValueError extends Error {
  readonly name = "InvalidCanonicalValueError"
  constructor(readonly valueType: string) {
    super(`cannot canonicalize value of type ${valueType}`)
  }
}
