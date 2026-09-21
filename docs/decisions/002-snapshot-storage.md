# ADR 002 — Canonical snapshot JSON instead of a `playlist_items` table (task 12)

Status: accepted and shipped (migrations `0002_playlists.sql` onward).

## Context

The plan's D1 reference design listed a `playlist_items` table as an
example. The actual contract requires something stronger than the example
schema implies: a published playlist is an **immutable, ordered snapshot**
replaced atomically on every update (`replace` is full-snapshot, never a
partial item merge), and its `contentHash` is computed over the canonical
serialization of the whole snapshot.

A normalized `playlist_items` table would make every replace a
delete-and-reinsert of up to 200 rows inside the guarded batch — more
statements, more bind variables (D1 limits), and a window where a partial
item list could be observed or left behind on failure.

## Decision

Store the canonical snapshot as **one bounded JSON column**
(`playlists.snapshot_json`) alongside denormalized metadata columns
(title/description/author/search text, visibility, counts, hashes) used
for listing/ranking. Tags stay relational (`tags`, `playlist_tags`) and
are refreshed inside the same guarded batch as the snapshot write.

There is no `playlist_items` table.

## Consequences

- Atomicity: a publication mutation is a single-row `UPDATE` gated by the
  operation-guard pattern (`repositories/guard.ts` + per-request attempt
  nonce), so a failed CAS changes nothing — no half-swapped item lists.
- Correctness: item order and unknown fields are preserved verbatim by
  the strict-schema'd snapshot; reads project the stored snapshot
  directly.
- Bind-count safety: one JSON parameter instead of hundreds of item
  statements stays well inside D1 variable/statement limits.
- Trade-off accepted: items are not independently queryable in SQL.
  Listing, ranking, and tag queries use only the denormalized columns —
  all proven against real Miniflare D1 (`apps/web/tests/repository/`).

## Verification

`apps/web/tests/repository/` (7 files) — migrations on fresh+upgraded D1,
exact item order round-trip, guarded concurrent CAS (two writers, one
mutation), receipt dedup, plan/limit inspection. Task-12 evidence.
