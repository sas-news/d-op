# Automated deploys (deploy.yml)

Routine deploys are automated by `.github/workflows/deploy.yml` on every
push to `main`. The manual runbooks (`cutover.md`, `staging.md`,
`release.md`) remain the reference for provisioning, incident recovery,
and store submission — this page is the operator's cheat sheet for the
automation itself.

## What runs when

The `changes` job diffs the pushed commits and fans out:

| Changed paths | Job | Effect |
|---|---|---|
| `apps/web/`, `packages/shared/`, `scripts/`, `package.json`, `bun.lock` | `deploy-web` | `astro build` → D1 migrate → `wrangler deploy` of `d-op-share` → read-only `verify:cutover` smoke on `d-op.sasnews.dev` |
| `apps/extension/`, `packages/shared/`, `scripts/`, `package.json`, `bun.lock` | `package-extension` | `bun run build` + `bun run verify:artifacts`, release zips uploaded as a run artifact |
| anything else (`docs/`, `tests/`, `.github/`, …) | — | nothing deploys |

Extension pushes rebuild and re-verify release artifacts only — Chrome Web
Store / AMO submission is a manual human step by design (`release.yml`,
`docs/release.md`).

Manual redeploy: Actions → "Deploy (main)" → Run workflow, with `target`
`production` (default) or `staging` (deploys `d-op-share-staging` via
`wrangler.staging.jsonc` + `dop_share_staging`, runs the `verify:staging`
disposable-resource flow, and skips the version bump).

## Version bumps

The site badge (`apps/web/src/site-version.ts`) reads
`apps/web/package.json`, and `verify-artifacts` requires the workspace
versions equal — so every production deploy runs
`scripts/bump-version.mjs`, which patch-bumps **all four** workspace
package.jsons together, syncs `bun.lock`, and pushes a
`chore(release): vX.Y.Z` commit to main. The badge on the deployed site
always reflects the running release.

If `main` is protected and the bump push is rejected, the deploy still
proceeds — the bumped version is replayed inside the job so the deployed
site shows it — and the run emits a warning. The repository records the
version on the next deploy where pushing is allowed.

## Required GitHub secrets

Set in repo secrets, or in the `production` / `staging` environments for
scoping (and required reviewers, if desired):

| Secret | Scope (docs/staging.md §0) |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | the account id shown by `wrangler whoami` |
| `CLOUDFLARE_API_TOKEN` | Account Workers Scripts Edit + D1 Edit + Workers Observability Read; Zone Workers Routes Edit on `sasnews.dev` for the `d-op.sasnews.dev` custom domain |

`RATE_LIMIT_HMAC_KEY` stays a Worker-side secret managed by
`wrangler secret put` — it must not live in GitHub secrets.
