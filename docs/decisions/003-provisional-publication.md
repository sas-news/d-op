# ADR 003 — Provisional publication: create → persist key → activate (task 13)

Status: accepted and shipped; documented for clients in `docs/share.md`
and `docs/api.md`.

## Context

`POST /api/v1/playlists` mints the `manageSecret` exactly once — the
server stores only `SHA-256(domain || shareId || secret)` and can never
reveal or reconstruct it. If the POST response is lost after the server
committed, the client has a server-side record it can no longer manage:
a permanent public orphan, or an incentive to store/recover secrets.

The initially unspecified delivery question: how does a publication
become visible when the one-time key may be lost in transit?

## Decision

Creation is **provisional**:

1. `POST` stores a `state:"pending"` snapshot that is invisible to GET,
   collection listing, tag counts, and import counting. It returns the
   one-time `manageSecret` + `activationExpiresAt` (1 h,
   `ACTIVATION_EXPIRES_AFTER_MS`).
2. The extension persists the publication record (shareId + secret +
   sent snapshot) to its local vault **first**, then sends the
   authenticated `PATCH {operation:"activate",expectedRevision:1}` which
   flips the record to `active` at revision 2.
3. Only after activation succeeds does the UI show the Share URL.

Lost-response handling:

- If the POST ack is lost, retrying with the same `Idempotency-Key`
  returns `409 CREATE_RECEIPT_UNAVAILABLE` — the server never returns a
  replacement or the original secret. The UI explains the attempt was not
  activated and the user may retry with a new operation id.
- If local persistence of the key fails, the extension does not activate;
  it attempts authenticated cleanup when possible, otherwise the pending
  record expires invisibly.
- Pending records expire after 1 h; expiry is enforced lazily on every
  API path (`expirePendingProvisionals`) and by `runScheduledCleanup`
  (cron wiring pending — `docs/staging.md` §9).

## Consequences

- No publicly visible snapshot can ever exist without a client-held key:
  pending rows are unreachable by definition, so a lost create cannot
  strand a public orphan.
- No secret recovery mechanism exists anywhere — no encrypted/plaintext
  server-side recovery store, no replay of a hash as a key.
- `activate` is idempotent for safety: replaying it on the same unchanged
  active publication returns current state rather than an error.
- Trade-off accepted: publication is a two-step flow (create+activate),
  and the extension owns the sequencing + failure states
  (`src/share/publish-flow.ts`, `pendingCreates`).

## Verification

`apps/web/tests/publication-api/` — lifecycle
(create→pending-hidden→activate→read→replace→delete), idempotency
receipts, `CREATE_RECEIPT_UNAVAILABLE`, provisional expiry, hash-only
secret storage. Extension fault legs in `tests/share-management/` +
`tests/e2e/extension-share-failures.spec.ts` cover lost responses, failed
key persistence, and expired pendings.
