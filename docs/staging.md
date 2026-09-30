# Staging runbook (task 28)

Operational runbook for the **isolated staging deployment** of the Share
service. Staging is a separate Worker + D1 database + rate-limit namespaces +
secrets from production (`wrangler.jsonc`); its config is
`apps/web/wrangler.staging.jsonc`. Only synthetic data ever lives here — the
`verify:staging` gate creates and deletes disposable playlists, and the
`DOP_DEPLOYMENT_LABEL=staging` var marks every dashboard/deployment view.

> **Do not improvise identifiers.** The committed config ships an all-zero
> `database_id` placeholder (same convention as production, ADR-001). Real
> database ids come only from the `wrangler d1 create` output in step 2 —
> never guessed, never committed from memory. Secret **values** are never
> typed into chat, docs, or the repo: they go through `wrangler secret put`
> prompts only.

## 0. Prerequisites

- Cloudflare account with **Workers + D1 on the account's actual plan**. D1
  and the Workers rate-limiting binding are available on the Free and Paid
  Workers plans; the operator must confirm the account in use has D1 enabled
  (dashboard → Workers & Pages → D1). Cron triggers — when wired, see
  "Scheduled pruning" — need no paid feature.
- Authenticated wrangler: `bunx wrangler whoami` must show the target
  account, or non-interactive shells need `CLOUDFLARE_ACCOUNT_ID` +
  `CLOUDFLARE_API_TOKEN` (token scope: Workers Scripts Edit, D1 Edit,
  Workers Observability Read for tails). Missing authorization BLOCKS this
  runbook — do not continue to production tasks without it.
- Repo state: `bun install` once; build before deploy.

## 1. Provision staging resources

```sh
cd apps/web

# D1 (records the real database_id — the only authorized source of it)
bunx wrangler d1 create dop_share_staging
```

Paste the printed UUID into `d1_databases[0].database_id` in
`wrangler.staging.jsonc`, replacing the all-zero placeholder. Committing the
real **staging** id is acceptable (ids are not secrets), but never backfill
it into `wrangler.jsonc` — that file keeps its own placeholder until the
production task provisions the production database.

The rate-limit bindings require no provisioning: `namespace_id` values are
numeric identifiers the API creates implicitly on deploy. Staging uses the
`21xx` range and production the `11xx` range, so staging traffic can never
consume production budgets. (Older free-form string ids are rejected by the
API with code 10021.)

## 2. Secrets

Exactly one secret exists: `RATE_LIMIT_HMAC_KEY` — keys the daily-rotating
HMAC that turns `cf-connecting-ip` into non-reversible rate-limit actor keys
(`server/security/rate-limit.ts`). Generate it locally, never print it:

```sh
# generate a random value, then paste at the hidden prompt
bunx wrangler secret put RATE_LIMIT_HMAC_KEY --config wrangler.staging.jsonc
```

The staging value MUST differ from any future production value. If the
secret is absent the limiter still works (SHA-256 fallback), but production
and staging should both provision it — document in the deploy log when it
was set (date, not value).

## 3. Migrations

```sh
bunx wrangler d1 migrations apply dop_share_staging --remote \
  --config wrangler.staging.jsonc
```

Migrations are forward-only `CREATE TABLE`/`ALTER`-style files
(`apps/web/migrations/0001..0008`); `d1_migrations` tracks applied ids, so
re-running is a safe no-op. Local rehearsal uses `--local --persist-to <dir>`
against a throwaway state dir instead.

## 4. Deploy

```sh
cd apps/web
bunx astro build                       # regenerates dist/server/entry.mjs + dist/client
bunx wrangler deploy --config wrangler.staging.jsonc
```

This deploys the **generated current Astro worker** (`main` points at
`dist/server/entry.mjs`, the same bundle `dist/server/wrangler.json` would
use) plus `dist/client` assets on worker `d-op-share-staging`. The staging
origin is `https://d-op-share-staging.<account-subdomain>.workers.dev`
(`workers_dev` default true). Record it as the non-secret
`DOP_STAGING_ORIGIN` in your shell/CI env — the verify script reads it.

## 5. Smoke / acceptance

```sh
bun run verify:staging -- --base-url="$DOP_STAGING_ORIGIN"
```

The script (exit 0 = pass): creates two disposable synthetic profiles
(public + unlisted), activates, reads, CAS-replaces, proves a stale
`expectedRevision` → 409 `REVISION_CONFLICT`, notifies an import
(`importCount` 0→1), checks discover visibility (public listed under its
tag, unlisted absent from collection and tag counts), deletes both, verifies
404s, and audits every response for capability leakage — the plaintext
`manageSecret` may appear in exactly one place (its own create ack).
Loopback requires explicit `--allow-local` (rehearsal only, NOT remote
proof); `d-op.sasnews.dev` is always refused.

Expected remote evidence: `wrangler tail` during the run shows one
`api_request` record per call; D1 shows zero `playlists`/`playlist_tags`
rows afterwards (idempotency receipt rows in `publication_operations`
remain by design until the 24 h TTL prune).

## 6. Monitoring without identity logging

Observability flags in `wrangler.staging.jsonc` are the privacy contract —
they mirror production and must not be "loosened for debugging":

| Flag | Value | Why |
|---|---|---|
| `observability.enabled` / `logs.enabled` | true | captures the redacted `api_request` console records |
| `logs.invocation_logs` | **false** | automatic request logs record raw URLs → would leak unlisted shareIds |
| `redact_query_string` | true | belt-and-suspenders for any platform-side URL capture |
| `traces.enabled` | **false** | traces carry request metadata; forbidden by the privacy contract |

- `bunx wrangler tail --config wrangler.staging.jsonc` — live log stream.
  Legitimate output is ONLY `{"event":"api_request","requestId","route":
  "<METHOD> /api/v1/playlists/:shareId","status","durationMs"}`. Any raw
  URL, shareId, IP, Authorization header, body, or SQL in the stream is a
  privacy incident — capture the record and stop the deployment.
- Local caveat (rehearsal evidence): `wrangler dev` prints its own
  `[wrangler:info] GET /api/v1/playlists/<id> ...` request lines locally.
  That is the dev server, not Workers Logs — in production the equivalent
  automatic records are exactly what `invocation_logs:false` disables.
- Metrics: dashboard → Workers & Pages → `d-op-share-staging` shows
  requests/errors/duration + D1 query volume; error spikes vs `api_request`
  statuses are the health signal.

## 7. Budget alerts (manual, dashboard)

Wrangler cannot configure billing alerts; set them once in the Cloudflare
dashboard: **Notifications → Add** → "Workers" usage notifications (requests,
CPU time) and "D1" usage notifications (rows read/written, storage), routed
to the operator email/webhook. Staging should trip at modest thresholds —
the service is idle except during verification runs, so ANY sustained usage
is itself a signal. Record the notification ids in the deploy log.

## 8. Backup and retention

- **D1 point-in-time recovery**: D1 Time Travel is available on all plans —
  `bunx wrangler d1 time-travel restore dop_share_staging --bookmark <id>`
  (or `--timestamp`) restores to any point within the retention window
  (30 days on paid plans, shorter on free — record the account's actual
  window in the deploy log after `wrangler d1 info dop_share_staging`).
- **Logical backup**: `bunx wrangler d1 export dop_share_staging --remote
  --output backup.sql --config wrangler.staging.jsonc` for a portable dump;
  staging holds only disposable data, so export cadence is operator choice
  (before any destructive maintenance at minimum).
- **Row retention by design** (pruned daily by `runScheduledCleanup` via
  the worker's `scheduled` handler + `triggers.crons`, and lazily on
  every request for pending rows): `publication_operations` ~24 h,
  `import_receipts` ~48 h, `import_daily` ~90 days,
  `discovery_snapshots` ~15 min, `playlists`/`tags` until delete.

## 9. Scheduled pruning

Every API read/write already calls `expirePendingProvisionals` (lazy
expiry of pending provisionals). On top of that, the worker entry
(`src/worker.ts`) exports a `scheduled` handler wired to
`runScheduledCleanup`, and both `wrangler.jsonc` and
`wrangler.staging.jsonc` declare `triggers.crons` (`0 3 * * *`, daily
03:00 UTC) covering pending provisionals + expired mutation/import
receipts + discovery snapshots + 90-day day buckets.

## 10. Rollback runbook

Deployments are versioned; roll back BEFORE investigating forward fixes.

```sh
# list versions + current deployment
bunx wrangler versions list --config wrangler.staging.jsonc
bunx wrangler deployments list --config wrangler.staging.jsonc

# instant rollback to the previous deployed version
bunx wrangler rollback --config wrangler.staging.jsonc
# or pin a version: bunx wrangler rollback <version-id> -c wrangler.staging.jsonc
```

Then **verify schema compatibility against the migrated D1**: run
`bun run verify:staging -- --base-url="$DOP_STAGING_ORIGIN"` again on the
rolled-back version. Migrations are additive (new tables/columns only), so
an older worker runs correctly on a newer schema; if a future migration
ever drops/renames columns, the rolled-back version must be certified by
the same verify run before traffic resumes. A failed verify after rollback
means the schema is incompatible — roll forward to the last working
version instead of editing data.

If `wrangler rollback` is unavailable (very old deployment), redeploy the
prior artifact: check out the previous commit, `bunx astro build`, deploy —
recorded versions make `wrangler rollback` the preferred path.

## 11. Failure-evidence checklist (QA failure paths)

| Injected failure | Expected observable evidence |
|---|---|
| Missing `DB` binding | `DOpConfigurationError DOP_MISSING_D1_BINDING` → 503 `TRANSIENT_FAILURE` on every API route |
| Missing/!provisioned limiter with `DOP_RATE_LIMIT_REQUIRED=true` | 503 on every route (fail-closed, never silent unlimited) |
| Limiter reports limit exhausted | 429 `RATE_LIMITED` + `Retry-After: 60` |
| Denied deploy (bad token/scope) | wrangler API error, no version created; nothing partially deployed |
| SQL failure mid-mutation | 503 `TRANSIENT_FAILURE`; no partial writes (guarded batches) |
| Rollback vs migrated D1 | verify run on rolled-back version proves compat or fails explicitly |
| Production binding touched | never — staging uses `d-op-share-staging`/`dop_share_staging`/`dop-staging-*` only |
