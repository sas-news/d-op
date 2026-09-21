# Share subsystem

d-OP v2 adds an **optional** sharing service. Ordinary playlist/playback use is local-only; Share exists only when the user explicitly consents and then performs explicit operations. This document is the single reference for what moves where.

## Origins and routes

| Purpose | Value |
|---|---|
| Share/web origin | `https://d-op.sasnews.dev` |
| Share page | `GET /p/<shareId>` |
| Privacy / terms | `/privacy`, `/terms` |
| API base | `/api/v1/playlists` |

API surface (`apps/extension/src/share/` clients → `apps/web/src/pages/api/v1/playlists/`).
The full wire contract — envelopes, exact payloads, status map, and
schema-validated examples — is `docs/api.md`; the normative source is
`packages/shared/src/api.ts`.

| Extension call | Route | Body | Auth |
|---|---|---|---|
| `createPublication` | `POST /api/v1/playlists` | `SharedPlaylist` projection | none (returns `shareId` + `manageSecret`) |
| `patchPublication` | `PATCH /api/v1/playlists/<shareId>` | `{operation:"activate",expectedRevision:1}` or `{operation:"replace",expectedRevision,playlist}` | `Bearer <manageSecret>` |
| `deletePublication` | `DELETE /api/v1/playlists/<shareId>` | `{expectedRevision}` | `Bearer <manageSecret>` |
| `fetchSharedPlaylist` | `GET /api/v1/playlists/<shareId>` | — | none |
| `notifyImport` | `POST /api/v1/playlists/<shareId>/import` | `{eventId}` (random UUID) | none |

Read-only collection routes `GET /api/v1/playlists` (list/search/ranking) and `GET /api/v1/playlists/tags` exist server-side for the web Explore page; the extension does not call them.

Publication is **two-step**: `POST` creates an invisible `pending`
snapshot (1 h expiry) and returns the one-time `manageSecret`; the
extension persists it locally, then `PATCH …activate` makes the snapshot
public at revision 2. A lost create ack cannot strand a public orphan or
re-issue a secret — retries see `409 CREATE_RECEIPT_UNAVAILABLE`. See
`docs/decisions/003-provisional-publication.md`.

All extension fetches use `credentials: "omit"`, `redirect: "error"`, `cache: "no-store"`, a timeout, and bounded response reads with strict schema validation. Mutations carry a caller-minted `Idempotency-Key` UUID. The manage secret never appears in URLs or request bodies — only the `Authorization` header of the operation it authorizes.

## Consent model

`packages/shared/src/local-model.ts` adds `shareConsent?: { choice: "granted"|"declined"; decidedAt }` to canonical state and a `set-share-consent` command. Absence means undecided.

`apps/extension/src/share/consent.ts` is the single gate:

- `effectiveShareConsent(repository, dataPermissions)` → `"granted" | "declined" | "undecided"`. Declined and undecided both block.
- Firefox ≥140 native consent: when `browser.permissions.getAll()` returns a `data_collection` key, every declared optional category must still be granted; otherwise the effective state degrades to `undecided`. Read failures fail closed.
- `requestShareDataPermissions` runs the native prompt on grant when the API exists.
- `writeShareConsent` persists through `runMutation`/`set-share-consent` — the revision-checked single writer.

Every Share network path re-checks the gate immediately before fetching:

- `management-handler.ts` — publish/activate/update/delete/inspect/source all return `"consent-required"` when the gate is not granted. Non-options senders get `"forbidden"` **before** the consent check, so foreign surfaces are rejected regardless of consent.
- `import-handler.ts` — begin/details/confirm are gated (`consent-required`/`consent-declined` replies); the web→ext relay opens the import window without prefetching.
- `import-notify.ts` — re-checks consent right before POSTing `{eventId}`; fire-and-forget, retried once.

UI surfaces:

- Options page `#shareConsentBox` (`src/ui/consent-section.ts`): current state, 有効にする / 利用しない / 無効にする, privacy link.
- Share dialog (`src/ui/share-dialog.ts`): consent panel replaces all publication controls until granted.
- Import confirmation (`entrypoints/import/`): consent prompt before any preview fetch; 利用しない produces zero traffic.
- Popup/options/import footers link the privacy page.

Revocation sets `choice:"declined"`: future traffic is blocked, but remote publications and local vault records are **not** auto-deleted. Remote deletion is an explicit operation that itself requires consent.

## Local persistence (`browser.storage.local`)

| Key | Contents |
|---|---|
| `dop_v2_state` | `playlists`, `publications` (incl. vault-only `manageSecret`, `sentSnapshot`, `acknowledgedHash`), `pendingCreates`, `preferences`, `shareConsent?`, `appliedOperations`, `migrationRecovery`, `revision` |
| `dop_v2_transient` | playback pointer, OP/ED mode flag, player-window ownership/generation |

Vault-only fields are never rendered, logged, or exported. Legacy v1 keys are read once for migration, not part of ordinary v2 writes.

## Server persistence (Cloudflare D1, `apps/web/migrations/`)

| Table | Contents | Lifetime |
|---|---|---|
| `playlists` | published snapshot JSON + denormalized metadata (title/author/tags/visibility/counts/`secret_hash`/`content_hash`); `pending → active`, hard delete | until deleted |
| `tags`, `playlist_tags` | canonical tag dictionary + join | with playlist |
| `publication_operations` | idempotency receipts: `operation_key`, `request_hash`, `secret_hash`, nonce, outcome — never raw secrets | ~24 h (`expires_at`) |
| `import_receipts` | SHA-256 `event_hash` + nonce | ~48 h |
| `import_daily` | per-day import counts | ~90 days |
| `discovery_snapshots` | ranked `[shareId, score]` pages + per-snapshot HMAC `cursor_key` | ~15 min |
| `operator_takedowns` | actor label, shareId, reason, removed flag — operator-only, no public endpoint | durable audit |
| `write_asserts` | assertion sink; must stay empty (trigger aborts) | — |
| `schema_migrations` | wrangler bookkeeping of applied migration ids | durable |

Operational logging: `request-log.ts` emits only `{event, requestId, route-template, status, durationMs}` — no URLs, IPs, bodies, or headers. Rate limiting (`security/rate-limit.ts`) uses daily-rotating HMAC'd IP digests that live only inside the limiter. Deletes are hard deletes; operator takedown is a deployment-credential CLI (`bun run takedown`), never a public endpoint.

## Whitelist summary (what may leave the browser)

1. `SharedPlaylist` projection: `schemaVersion`, `title`, `description`, `author`, `tags`, `visibility`, `derivedFrom?`, `items[]` where each item is `{partId, workId?, title, episodeTitle, episodeNumber?, range{start,end,name?}}`.
2. Operation envelopes: `{operation, expectedRevision, playlist?}` and `{expectedRevision}`.
3. `Authorization: Bearer <manageSecret>` + `Idempotency-Key` headers on mutations.
4. `{eventId}` import notification.

Everything else — local playlist/item ids, page URLs, cookies, credentials, browsing history, install/device identifiers — must never appear in a Share request.
