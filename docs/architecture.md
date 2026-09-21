# Architecture

Bun monorepo, two deployables, one shared package. Final state as of the
task-30 documentation pass; requirement-to-code traceability lives in
`docs/traceability.md`.

## Layout

```text
apps/extension/   WXT project — Chrome + Firefox MV3 extension
apps/web/         Astro + Cloudflare Workers/D1 — d-op.sasnews.dev (pages + /api/v1/*)
packages/shared/  Zod schemas + pure logic shared by both (local model, share model, API contract)
tests/e2e/        Playwright suites + fixture harness server
tests/browser/    native browser harnesses (geckodriver / real CfT) + upgrade rehearsal
docs/             This directory
```

## Extension (`apps/extension/`)

Entrypoints (`entrypoints/`):

- `background.ts` — MV3 service worker (Chrome) / event page (Firefox).
  Owns the storage single-writer, the player window manager, and ALL
  Share API traffic (management + import handlers).
- `danime-player.content.ts` — isolated script on the player page
  (`sc_d_pc`): OP/ED enforcement, playlist playback, seek markers,
  control bar.
- `danime-store.content.ts` — isolated script on work/episode pages:
  per-episode OP/ED menus + same-origin chapter fetches.
- `danime-main.ts` — unlisted main-world script; the only code that may
  touch `window.vc`. `danime-isolated-runtime.ts` installs the
  isolated-side bridge (`postMessage` envelopes).
- `share-site.content.ts` — relay on `d-op.sasnews.dev/p/*` for the web
  "open in d-OP" button (no `externally_connectable`).
- `popup/`, `options/`, `import/` — toolbar popup, the privileged
  management page (playlists, share dialog, consent, import/export,
  detached management list), and the import confirmation window.

Source layout (`src/`): `adapter/` (d-Anime `window.vc` boundary +
bridge), `domain/` (pure playlist/range/shuffle/navigation rules),
`player/` (orchestrator, UI, modal host, window manager), `storage/`
(canonical repository, mutations, migrations — `dop_v2_state` +
`dop_v2_transient`), `share/` (API clients, consent gate, publish /
import / management flows), `ui/` (options/popup/store-page controllers).

## Web (`apps/web/`)

- `src/pages/` — Astro SSR: landing `index.astro`, `/privacy`,
  `/terms`, `/explore`, `/p/[shareId]`, `404`, the `/PRIVACY.md` 301
  redirect, and `pages/api/v1/playlists/*` route handlers.
- `src/server/repositories/` — D1 access only (snapshots create/read/
  activate/replace/delete, guarded operation rows, imports, takedown,
  migrations). SQL never lives in page rendering.
- `src/server/services/` — publication/mutation/read flows, discovery
  admission, import notify, redacted request logging, maintenance
  (`runScheduledCleanup` — see the cron note below).
- `src/server/security/` — capability hashing, bounded HTTP bodies,
  origin policy, security headers, rate-limit bindings.
- `src/server/discovery/` — ranking policy (30d→90d→lifetime→new),
  queries, 15-min materialized snapshots, HMAC cursors.
- `migrations/0001–0008` — ordered forward-only D1 migrations.
- `wrangler.jsonc` (production `d-op-share` / `dop_share`) and
  `wrangler.staging.jsonc` (`d-op-share-staging` / `dop_share_staging`).
  Both carry the all-zero `database_id` placeholder — real ids come only
  from `wrangler d1 create` (runbooks: `docs/staging.md`,
  `docs/cutover.md`).

## Boundaries (do not cross)

- **Storage single-writer**: canonical state lives in `dop_v2_state`
  (`browser.storage.local`). Only the background repository
  (`src/storage/`) writes it, via revision-checked commands dispatched
  over runtime messaging. UI pages use `UiStorageClient`/`runMutation`.
- **Share traffic is background-only and consent-gated**: `src/share/`
  holds the API clients, the management handler (options-only senders),
  the import handler, and the consent gate. See `docs/share.md` for the
  full route/payload/persistence disclosure and `docs/api.md` for the
  wire contract.
- **d-Anime boundary**: `danime-main.ts` (main world) owns `window.vc`;
  isolated content scripts talk to it over `postMessage` via
  `src/adapter/`. Never inject Share/storage capabilities into the page
  world. Contract: `docs/danime-player-contract.md`.
- **Shared schema boundary**: every external input (storage reads,
  runtime messages, HTTP bodies) is parsed with `packages/shared` Zod
  schemas at the boundary. `packages/shared` is browser/Node/workerd
  neutral — no app storage, secrets, or runtime imports.
- **Publication vs portable data**: the manage secret and sent/ack'd
  hashes live only in the vault projection inside `dop_v2_state`; JSON
  export uses a strict whitelist and can never carry ownership.
- **Snapshot, not rows**: published playlists are one canonical JSON
  snapshot column, replaced atomically — see
  `docs/decisions/002-snapshot-storage.md`. Publication is the two-step
  provisional create → activate flow — see
  `docs/decisions/003-provisional-publication.md`.

## Operational topology

- Worker `d-op-share` serves the canonical origin `d-op.sasnews.dev`
  (pages + API); staging is the isolated `d-op-share-staging` worker +
  `dop_share_staging` D1 + `dop-staging-*` rate-limit namespaces.
- Rate limiting uses five `ratelimits` bindings (`dop-api`, `dop-create`,
  `dop-mutation`, `dop-import`, `dop-read`) plus a daily-rotating
  `RATE_LIMIT_HMAC_KEY` secret; `DOP_RATE_LIMIT_REQUIRED=true` fails
  closed when a binding is missing.
- Observability emits only redacted `api_request` records; automatic
  invocation logs and traces are disabled (they would leak unlisted
  shareIds). See `docs/staging.md` §6.
- **Cron gap (known)**: the generated worker exports `fetch` only — there
  is no `scheduled` handler, so `triggers.crons` is not configured. TTL
  pruning currently relies on the lazy per-request sweep
  (`expirePendingProvisionals` on every API path); wiring
  `runScheduledCleanup` to a `scheduled` export is a recorded follow-up
  (`docs/staging.md` §9).
- Deployment state: remote staging/production deploys are BLOCKED on
  Cloudflare credentials — `docs/release.md` carries the honest status
  ledger; `docs/traceability.md` §5 lists the ordered release path.
