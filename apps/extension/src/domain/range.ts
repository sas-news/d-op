import { type LocalRange, LocalRangeSchema } from "../../../../packages/shared/src/local-model"

export type RangeParseResult =
  | { readonly kind: "valid"; readonly range: LocalRange | null }
  | { readonly kind: "invalid-range"; readonly issues: readonly string[] }

export function parseRange(input: unknown): RangeParseResult {
  if (input === null) return { kind: "valid", range: null }
  const parsed = LocalRangeSchema.safeParse(input)
  if (parsed.success) return { kind: "valid", range: parsed.data }
  return {
    kind: "invalid-range",
    issues: parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
  }
}

type GuessRangeNameInput = {
  readonly range: Pick<LocalRange, "start" | "end">
  readonly index: number
  readonly total: number
  readonly durationMs: number
}

export function guessRangeName(input: GuessRangeNameInput): string {
  const lengthMs = input.range.end - input.range.start
  const nearStart = input.range.start < 180_000
  const veryStart = input.range.start < 15_000
  const nearEnd = input.durationMs - input.range.end < 300_000
  const opEdDuration = lengthMs >= 75_000 && lengthMs <= 105_000
  const introDuration = lengthMs < 15_000

  if (input.total === 1) {
    if (opEdDuration && nearStart) return "OP"
    if (introDuration && veryStart) return "イントロ"
    return "パート1"
  }
  if (input.total === 2) {
    if (input.index === 0) {
      if (opEdDuration && nearStart) return "OP"
      if (introDuration && veryStart) return "イントロ"
      return "パート1"
    }
    if (opEdDuration && nearEnd) return "ED"
    if (introDuration && veryStart) return "イントロ"
    return "パート2"
  }
  if (input.index === 0 && introDuration && veryStart) return "イントロ"
  if (input.index === input.total - 1 && opEdDuration && nearEnd) return "ED"
  if (input.index > 0 && input.index < input.total - 1 && opEdDuration && nearStart) return "OP"
  return `パート${input.index + 1}`
}
