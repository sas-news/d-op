# Release procedure (task 25)

v2 ships reproducible browser-specific MV3 artifacts built by WXT. This file
is the operator runbook; the automated gates are `bun run build`,
`bun run verify:artifacts`, and `.github/workflows/release.yml`.

## Artifacts (`apps/extension/.output/`)

| File | Purpose |
|---|---|
| `chrome-mv3/` | unpacked Chrome MV3 bundle (`background.service_worker`) |
| `firefox-mv3/` | unpacked Firefox MV3 bundle (`background.scripts`, gecko id `d-op@sasnews.dev`) |
| `d-op-<version>-chrome.zip` | Chrome Web Store upload artifact |
| `d-op-<version>-firefox.zip` | AMO upload artifact |
| `d-op-<version>-sources.zip` | AMO source archive — full buildable workspace + lockfile + `BUILD-INSTRUCTIONS.md` |
| `d-op-<version>-chrome.crx` | optional self-distribution CRX (only via `pack:crx`, never in CI) |

ZIPs are deterministic: WXT's zero-zip writer and `scripts/lib/zip.mjs` both
emit sorted entries with zeroed timestamps, so identical inputs give
byte-identical archives. To compare a rebuilt artifact against a released
one, compare the sorted `name → sha256` map (ZIP timestamps are already
zero — byte equality is expected).

## Versioning and identity

- `apps/extension/package.json` is the single version source; WXT injects it
  into both manifests. `verify:artifacts` asserts root/extension package
  versions and both manifest versions are equal.
- Chrome: store identity comes from the Web Store listing; no `key` field is
  shipped (unpacked dev ids are irrelevant).
- Firefox: `browser_specific_settings.gecko.id = "d-op@sasnews.dev"` is the
  stable AMO identity; `data_collection_permissions.required = ["none"]`
  plus the three optional categories matching `SHARE_DATA_COLLECTION_PERMISSIONS`.
- Permissions are least-privilege: `tabs`, `storage`, and host permissions
  limited to the two d-Anime hosts + the share origin. Dev-only localhost
  origins exist only in non-production manifests.

## Release flow (`.github/workflows/release.yml`)

1. Bump versions in a normal PR (`package.json`, `apps/extension/package.json`,
   `apps/web/package.json`, `packages/shared/package.json` — all four in
   lockstep; `node scripts/bump-version.mjs` + `bun install` for the lockfile),
   get it green, merge.
2. A maintainer dispatches **Release (immutable tag)** with `version` +
   `confirm: RELEASE`. The job binds to the `release` environment — configure
   required reviewers (Settings → Environments → release) so every release is
   human-approved.
3. The workflow refuses to proceed when `v<version>` already exists as a git
   tag **or** GitHub release — releases are never deleted, re-created, or
   force-pushed. A re-dispatch with the same version is a safe refusal, not
   a rebuild-and-overwrite.
4. It then installs (`--frozen-lockfile`), builds, runs
   `verify-artifacts --release-tag v<version>` (defense in depth), emits
   SHA-256 sums, and creates the GitHub release with the three archives,
   tagging the exact approved commit (`--target`).

**Not automated, by design:** store submission and production deploys. There
is no `wxt submit`, no store API call, no main-push publish anywhere.

## Manual store submission checklist

All listing copy, permission justifications and privacy declarations live in
`STORE_LISTING.md` (repo root) — review it before transcribing into the consoles.

- Chrome Web Store dashboard → upload `d-op-<version>-chrome.zip`.
- AMO → upload `d-op-<version>-firefox.zip`; attach
  `d-op-<version>-sources.zip` in the "source code" field (reviewers rebuild
  per `BUILD-INSTRUCTIONS.md` inside the archive).
- After the v2 listing is actually published, bump the landing JSON-LD
  `softwareVersion` (`apps/web/src/pages/index.astro`) — it intentionally
  tracks the *published* store version, so it stays `1.0.0` until then
  (`tests/e2e/landing.spec.ts` asserts it and must be updated together).

## Release status ledger (task 30 — honest handoff)

DONE = receipt exists in `.omo/evidence/`. BLOCKED/PENDING = named
prerequisite; nothing below is claimed or waived.

| Item | Status | Reference |
|---|---|---|
| Reproducible artifacts + gates (`build`, `verify:artifacts`, self-test, source-archive byte-identical rebuild) | DONE | task-25 |
| Unit/worker/e2e suites + native 4-browser matrix (Chrome 153/152, Firefox 153.0.1/140.16.0esr) | DONE | task-23, `docs/testing.md` |
| v1→v2 upgrade + rollback rehearsal on real binaries (unpacked-path identity) | DONE | task-26 |
| Staging deploy + `verify:staging` remote run | DONE — `d-op-share-staging.sasshinbun0655.workers.dev`, 19-step PASS on the live Worker/D1 | task-28, `docs/staging.md` |
| Production deploy + `d-op.sasnews.dev` cutover + `verify:cutover` green | DONE — `d-op-share` worker serves the canonical domain; 16-check PASS + disposable public/unlisted publish→delete QA on production D1 | task-29, `docs/cutover.md` |
| Archive-tag push, Pages disable, `gh-pages`/`dev` retirement | DONE — 5 archive tags remote, Pages disabled (GET /pages → 404), all 14 stale branches deleted; only `main` remains | task-29 checklist |
| Real logged-in d-Anime smoke | **BLOCKED — production Extension release gate** (2FA, no static accounts) | `docs/cutover.md` §9 |
| Store uploads (CWS + AMO) | **PENDING** — manual draft/review gate; never automated | this file |
| Signed-store update continuity | **PENDING** — distinct from rehearsed unpacked-path identity | task-26 |
| `RATE_LIMIT_HMAC_KEY` secret | DONE — staging and prod both provisioned via `wrangler secret put` | `docs/staging.md` §2 |
| `scheduled()` export + `triggers.crons` TTL pruning | **NOT WIRED** — `runScheduledCleanup` ready; lazy per-request expiry covers pending provisionals | `docs/staging.md` §9 |

Until the BLOCKED rows carry receipts, overall release status is
**incomplete** — the blocked prerequisites cannot yield "release
complete" and are deliberately left unchecked.

## Optional CRX signing (`bun run pack:crx`)

Only needed for self-distribution — the stores sign their own copies.

```sh
node scripts/pack-crx.mjs --key /secure/path/release.pem --expect-id <store extension id>
```

- The key file must already exist; the tool never generates a replacement
  key (a missing key is a loud refusal — a new key would mean a new
  extension identity and broken update continuity).
- `--expect-id` hard-fails when the key derives a different extension id.
- `node scripts/pack-crx.mjs --self-test` exercises the sign/parse/verify
  round-trip with an ephemeral throwaway key (clearly labeled, deleted after
  the test). Production signing was NOT RUN here — no release key is held in
  this environment.

## Source-archive clean-build rehearsal

Done once per release process change, recorded in `.omo/evidence/`:

```sh
unzip apps/extension/.output/d-op-<version>-sources.zip -d /tmp/d-op-src
cd /tmp/d-op-src
bun install --frozen-lockfile
bun run build
# compare /tmp/d-op-src/apps/extension/.output/d-op-*-{chrome,firefox}.zip
# against the repo's: logical content (name → sha256) must be identical.
```

## v1 historical source

The legacy root runtime (plain-JS v1) was removed in task 25 after parity
evidence (tasks 9/10/23). Its source stays reachable at git tag `v1.0.0`
(baseline `fc9d7fd`) — no copy is kept in the working tree.
