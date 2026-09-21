import {
  collapseWhitespace,
  MIN_POSITIVE_PLAYLISTS,
  RANK_WINDOWS_DAYS,
} from "../../../../../packages/shared/src/index"

// Centralized adaptive-rank policy for Discover (task 19). Everything that
// decides WHICH ranking basis a listing uses lives here and nowhere else:
//
//   - eligibility is always active + public + not blocked (enforced in SQL);
//   - windows are UTC calendar-day buckets INCLUDING the current day: the 30d
//     window is the 30 days [today-29 .. today], 90d is [today-89 .. today],
//     lifetime is the durable playlists.import_count;
//   - a "positive score" in a window means at least one counted import
//     notification inside it;
//   - coverage counts eligible positive-score playlists GLOBALLY — search,
//     tag and page size never narrow the window decision;
//   - popular: 30d when >=5 positives, else 90d when >=5, else lifetime when
//     it has any positive; widening reports "insufficient-recent-data". When
//     lifetime has no positive score at all, the listing degrades to mode
//     "new" with window "none" and fallback "no-imports";
//   - requested sort "new" is not a fallback: it is mode "new" with window
//     "none" and NO fallbackReason (the user asked for it);
//   - there is deliberately no minimum total event count.
//
// Every constant is reversible tuning, not a user-identity threshold.

export const RANK_POLICY = {
  /** Days covered by each recent window, in widening order. */
  shortWindowDays: RANK_WINDOWS_DAYS[0],
  longWindowDays: RANK_WINDOWS_DAYS[1],
  /** Eligible positive-score playlists required to keep a recent window. */
  minimumPositivePlaylists: MIN_POSITIVE_PLAYLISTS,
} as const

export type ListSort = "new" | "popular"
export type RankMode = "popular" | "new"
export type RankWindow = "30d" | "90d" | "lifetime" | "none"
export type FallbackReason = "insufficient-recent-data" | "no-imports"

/** Global eligible positive-playlist coverage per candidate window. */
export type RankCoverage = {
  readonly positives30d: number
  readonly positives90d: number
  readonly positivesLifetime: number
}

/** The ranking basis a listing is materialized under. */
export type RankingDecision = {
  readonly mode: RankMode
  readonly effectiveWindow: RankWindow
  readonly fallbackReason: FallbackReason | undefined
}

const NEW_ORDER: RankingDecision = {
  mode: "new",
  effectiveWindow: "none",
  fallbackReason: undefined,
}

const UNCOUNTED: RankCoverage = {
  positives30d: 0,
  positives90d: 0,
  positivesLifetime: 0,
}

/**
 * Decides the listing basis for a first-page request. `coverage` must be the
 * GLOBAL eligible counts for the request instant — callers compute it once
 * per query start from UTC day buckets. Sort "new" never consults coverage.
 */
export function decideRanking(sort: ListSort, coverage: RankCoverage = UNCOUNTED): RankingDecision {
  if (sort === "new") return NEW_ORDER
  const minimum = RANK_POLICY.minimumPositivePlaylists
  if (coverage.positives30d >= minimum) {
    return { mode: "popular", effectiveWindow: "30d", fallbackReason: undefined }
  }
  if (coverage.positives90d >= minimum) {
    return {
      mode: "popular",
      effectiveWindow: "90d",
      fallbackReason: "insufficient-recent-data",
    }
  }
  if (coverage.positivesLifetime > 0) {
    return {
      mode: "popular",
      effectiveWindow: "lifetime",
      fallbackReason: "insufficient-recent-data",
    }
  }
  return { mode: "new", effectiveWindow: "none", fallbackReason: "no-imports" }
}

// --- UTC calendar-day helpers -------------------------------------------------

const DAY_MS = 86_400_000

/** YYYY-MM-DD of the instant in UTC. */
export function utcDayOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** UTC day `days` before `date`'s day (day-precision arithmetic). */
export function utcDayBefore(date: Date, days: number): string {
  return new Date(date.getTime() - days * DAY_MS).toISOString().slice(0, 10)
}

/**
 * Oldest day inside an inclusive N-calendar-day window that ends on `now`'s
 * UTC day — e.g. the 30d window at 2026-03-10 starts on 2026-02-09.
 */
export function windowStartDay(now: Date, windowDays: number): string {
  return utcDayBefore(now, windowDays - 1)
}

// --- Filter normalization ------------------------------------------------------

/**
 * Normalizes a `q` search string to match `playlists.search_text`, which is
 * built as collapseWhitespace(NFC(title + description + author)) lowercased.
 * The result is then LIKE-escaped. A whitespace-only query normalizes to "" —
 * callers must treat that as a match-nothing filter, never "match all".
 */
export function normalizeSearchQuery(q: string): string {
  return collapseWhitespace(q.normalize("NFC")).toLocaleLowerCase("en").trim()
}

/** Escapes LIKE metacharacters so `q` is a literal substring pattern. */
export function escapeLikePattern(normalized: string): string {
  return normalized.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/**
 * Canonical form of a `tag` filter — identical normalization to the publish
 * boundary (NFC, trim, whitespace-collapse, case-fold). Case folding is
 * Unicode-aware but NOT width-folding: fullwidth "ＯＰ" canonicalizes to
 * "ｏｐ" exactly like a stored tag would.
 */
export function canonicalizeTagQuery(tag: string): string {
  return collapseWhitespace(tag.normalize("NFC").trim()).toLocaleLowerCase("en")
}
