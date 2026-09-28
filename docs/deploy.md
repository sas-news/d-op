# Automated deploys (deploy.yml)

Routine deploys are automated by `.github/workflows/deploy.yml`. The
manual runbooks (`cutover.md`, `staging.md`, `release.md`) remain the
reference for provisioning, incident recovery, and store submission —
this page is the operator's cheat sheet for the automation itself.

## Trigger

The workflow fires on `workflow_run`: when the **CI (Linux full matrix)**
workflow completes on `main` with `conclusion == success`. A commit that
failed CI never reaches production. (The Windows CI workflow does not
gate deploys — it adds platform coverage for the extension, not the
worker.)

Manual redeploy: Actions → "Deploy (main)" → Run workflow, with `target`
`production` (default) or `staging` (deploys `d-op-share-staging` via
`wrangler.staging.jsonc` + `dop_share_staging`, runs the `verify:staging`
disposable-resource flow, and skips the version bump). Dispatch always
deploys the `main` head.

## What runs when

The `changes` job diffs the verified commit against its first parent —
squash-merged and merge-commit PRs are seen in full — and fans out:

| Changed paths | Job | Effect |
|---|---|---|
| `apps/web/`, `packages/shared/`, `scripts/`, `package.json`, `bun.lock` | `deploy-web` | `astro build` → D1 migrate → `wrangler deploy` of `d-op-share` → read-only `verify:cutover` smoke on `d-op.sasnews.dev` |
| `apps/extension/`, `packages/shared/`, `scripts/`, `package.json`, `bun.lock` | `package-extension` | `bun run build` + `bun run verify:artifacts`, release zips uploaded as a run artifact |
| anything else (`docs/`, `tests/`, `.github/`, …) | — | nothing deploys |

Extension pushes rebuild and re-verify release artifacts only — Chrome Web
Store / AMO submission is a manual human step by design (`release.yml`,
`docs/release.md`).

## Version bumps

The site badge (`apps/web/src/site-version.ts`) reads
`apps/web/package.json`, and `verify-artifacts` requires the workspace
versions equal — so `scripts/bump-version.mjs` patch-bumps **all four**
workspace package.jsons together (plus `bun.lock`). The `version` job only
computes the next version; the deploy/package jobs apply it locally so the
shipped artifact carries it, and push the `chore(release): vX.Y.Z` commit
to main **after** the deploy/verify succeeds — a failed run never records
a version it did not ship. When both jobs ship the same version, the
second push observes it already landed.

If `main` is protected and the record push is rejected, the deploy still
succeeded — the repository simply catches up on the next deploy (a
warning is emitted either way it resolves).

## Required GitHub secrets

Set in repo secrets, or in the `production` / `staging` environments for
scoping (and required reviewers, if desired):

| Secret | Scope (docs/staging.md §0) |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | the account id shown by `wrangler whoami` |
| `CLOUDFLARE_API_TOKEN` | Account Workers Scripts Edit + D1 Edit + Workers Observability Read; Zone Workers Routes Edit on `sasnews.dev` for the `d-op.sasnews.dev` custom domain |

`RATE_LIMIT_HMAC_KEY` stays a Worker-side secret managed by
`wrangler secret put` — it must not live in GitHub secrets.
