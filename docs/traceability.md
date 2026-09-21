# Traceability — requirements → tasks → code → tests → evidence

Final reconciliation pass (plan task 30). Ground truth:

- `.omo/plans/d-op-v2-share.md` — the approved plan (scope, contracts, 30
  tasks, F1–F4 verifiers).
- `git log fc9d7fd..HEAD` — one coherent commit per task plus supporting
  commits; v1 baseline is tag `v1.0.0` (`fc9d7fd`).
- `.omo/evidence/task-N-d-op-v2-share/` — per-task DoneClaims and raw
  logs/JSON/screenshots.
- This tree's test suites (`apps/extension/tests`, `apps/web/tests`,
  `packages/shared/tests`, `tests/e2e`, `tests/browser`).

Status legend: **DONE** = implemented + tested + evidenced.
**PARTIAL** = the local/code half is proven and the remote/credential half
is BLOCKED on a named prerequisite (never silently waived). **NOT RUN** =
explicitly not executed; the reason is recorded.

## 1. Task ledger (30 tasks)

| # | Task | Commit(s) | Primary tests / gates | Evidence dir | Status |
|---|------|-----------|----------------------|--------------|--------|
| 1 | Freeze behavior inventory + safety baseline | `280cab4` | Source inventory review; `docs/current-extension-behavior.md`, `docs/danime-player-contract.md` | `task-1` | DONE |
| 2 | Bun workspace + released tooling | `c6666d0` | `bun install --frozen-lockfile`, `typecheck`, `lint`, `build`; both MV3 manifests; workerd exec; zero-test-selection fails | `task-2` | DONE |
| 3 | Shared schemas + legacy fixtures | `85ee5d8` | `packages/shared/tests/*` (api, share, local, bridge, canonical-vectors, legacy-characterization, exports) | `task-3` | DONE |
| 4 | Web shell + design tokens | `68de996`, `a90110f`, `33882d6`, `0492c60`, `2b06a21`, `83ee0d4`, `bfec313`, `ed61f4b`, `a5fe370`, `a0aa148`, `911911d` | `tests/e2e/web-shell.spec.ts` (web-chromium); 320/768/1440 screenshots | `task-4` | DONE |
| 5 | Test infrastructure + safe CI | `d458858` | `tests/e2e/harness.spec.ts`; unit/workerd pools; `.github/workflows/ci*.yml`; frozen destructive release step | `task-5` | DONE |
| 6 | Playlist/range/shuffle domain | `13d615f` | `apps/extension/tests/domain/*` (playlist, range, shuffle-navigation) | `task-6` | DONE |
| 7 | Single-writer storage + migration | `27290a4` | `apps/extension/tests/storage/*` (migration, repository, messages, authorization, transient); real Chromium storage | `task-7` | DONE |
| 8 | d-Anime adapter + main-world bridge | `9b8f5f4` | `apps/extension/tests/adapter/*`; `tests/e2e/adapter-bridge.spec.ts` (web-chromium + web-firefox) | **none — see §4** | DONE (evidence gap noted) |
| 9 | Player orchestration + windows | `b96f69b` | `apps/extension/tests/player/*`; `extension-player-state.spec.ts` | `task-9` | DONE |
| 10 | Extension + embedded UI parity | `d191666` (+ spec registration `aa46984`) | `apps/extension/tests/ui/*`; `extension-parity.spec.ts` | `task-10` | DONE |
| 11 | Safe portable import/export + detached management | `90492c8` | `apps/extension/tests/portable/*`; `extension-portable.spec.ts` | `task-11` | DONE |
| 12 | D1 schema + guarded repository | `3828703` (+ `689fc62`, `0a6b135`) | `apps/web/tests/repository/*` on real Miniflare D1; concurrent CAS proof | `task-12` | DONE |
| 13 | Capability API + provisional delivery | `e46262c` | `apps/web/tests/publication-api/*`: lifecycle, idempotency, provisional-expiry, secret-storage, validation, methods | `task-13` | DONE |
| 14 | Request/transport/privacy boundaries | `8538c5d` (+ `aa46984`) | `apps/web/tests/security/*`; `tests/e2e/csp.spec.ts` | `task-14` | DONE |
| 15 | Publication management + dirty state | `4332299` | `apps/extension/tests/share-management/*`; `extension-share-management.spec.ts` | `task-15` | DONE |
| 16 | Public snapshot page + OGP | `8c8c2ab` (+ `eb455c3`) | `tests/e2e/share-page.spec.ts` (web-chromium + web-firefox); `apps/web/tests/share-page/` | `task-16` | DONE |
| 17 | Web→Extension independent import | `8066e0d` | `tests/e2e/extension-web-import.spec.ts`; `apps/extension/tests/share/{import-handler,import-commit,import-page,relay}.test.ts` | `task-17` | DONE |
| 18 | Import aggregate accounting | `3d15bce` | `apps/web/tests/import-counts/*`; `apps/extension/tests/import-notification/*` | `task-18` | DONE |
| 19 | Adaptive popular/new/search/tags | `77148c6` (+ `9f31056`, `9eb52d2`) | `apps/web/tests/discovery/*`; `tests/e2e/discover.spec.ts` | `task-19` | DONE |
| 20 | Remix provenance + source relationships | `f266921` | `apps/web/tests/remix/*`; `tests/e2e/extension-remix.spec.ts`; `apps/extension/tests/share-management/remix-provenance.test.ts`, `apps/extension/tests/share/provenance.test.ts` | `task-20` | DONE |
| 21 | Legacy site port + public navigation | `e70fb15` (+ `9f31056`) | `tests/e2e/landing.spec.ts` (web-chromium + web-firefox); `/PRIVACY.md` 301 | `task-21` | DONE |
| 22 | Privacy, consent, listings, guidance | `95a4668` | `extension-privacy-consent.spec.ts` (5/5); `apps/extension/tests/share/consent.test.ts`; disclosure audit vs code | `task-22` | DONE |
| 23 | Browser + synthetic E2E parity | `fb2b5cd` | `test:browser:firefox` stable+ESR; `test:browser:chrome` stable+previous; `bun run test` (unit+worker+3 Playwright projects) | `task-23` | DONE (limits in §4) |
| 24 | Accessibility, visual, performance | `77749c6` | `extension-ui-quality.spec.ts`, `accessibility.spec.ts` (axe); zoom/mutation-storm bounds | `task-24` | DONE |
| 25 | Reproducible packaging + source archives | `6c233a5` | `bun run build`, `verify:artifacts` (+`--self-test` 19 refusal paths), source-archive byte-identical rebuild | `task-25` | DONE |
| 26 | Installed-profile upgrade/rollback rehearsal | `a398e1b` | `verify:upgrade --browser=chromium` 65/65, `--browser=firefox` 59+1NR; `apps/extension/tests/storage/upgrade-rehearsal.test.ts` | `task-26` | DONE (limits in §4) |
| 27 | Security + failure scenarios end-to-end | `047475d` | `apps/web/tests/adversarial/*`; `extension-share-failures.spec.ts` | `task-27` | DONE |
| 28 | Staging deploy + operational readiness | `36e6316` | `verify:staging` implemented + local workerd/D1 rehearsal PASS (19 steps); remote deploy **BLOCKED** (no CF auth) | `task-28` | PARTIAL |
| 29 | Canonical cutover + legacy retirement | `7b58b62` | `verify:cutover` implemented; local PASS 13/4-skip; real pre-cutover run correctly FAILS; local archive tags created+verified | `task-29` | PARTIAL |
| 30 | Docs, traceability, release handoff | *(this task — docs only)* | doc-vs-code review, API example schema check, gates rerun | `task-30` | DONE |

Every plan task maps to ≥1 commit + ≥1 gate/test + an evidence record.
Tasks 28–29 are the only PARTIAL rows; their unchecked halves are the
operational prerequisites in §5 — they cannot yield "release complete".

## 2. Requirement sections → implementation

The plan's contract sections and where each landed:

| Plan section | Implementation | Tests / proof |
|---|---|---|
| Must-have: one Bun workspace, WXT ext, Astro+CF Worker/D1, shared Zod, no ORM | `apps/extension`, `apps/web`, `packages/shared`; D1 prepared SQL only (`apps/web/src/server/repositories/`) | `build`, `typecheck`, worker suite |
| Must-have: preserve CWS id `mcjkaoagedekadnimbcbkhdkgpbnnodc`, Firefox `d-op@sasnews.dev`, both d-Anime hosts, v2.0.0 | `wxt.config.ts` (gecko id, hosts); store identity documented in `docs/release.md` | `verify:artifacts` manifest assertions |
| Must-have: browser support Chrome stable+previous, Firefox stable+ESR | `tests/browser/{chrome,firefox}-harness.mjs` | task-23 native matrix (§3) |
| Local data 1: all legacy keys readable; `dop_v2_state` envelope; typed transient | `apps/extension/src/storage/` (driver, repository); `LEGACY_STORAGE_KEYS` | storage tests; upgrade rehearsal |
| Local data 2: background single writer, operationId+revision commands, 256-receipt ledger, replay | `apps/extension/src/storage/{repository,messages}.ts`, `runMutation` | `apps/extension/tests/storage/repository.test.ts`, `apps/extension/tests/storage/messages.test.ts`, concurrent-client tests |
| Local data 3: non-destructive migration, frozen old keys, fail-closed, no early flag | `apps/extension/src/storage/migration.ts` | `apps/extension/tests/storage/migration.test.ts`, `apps/extension/tests/storage/upgrade-rehearsal.test.ts`, browser legs |
| Local data 4: order/names/episodeNumber/both hosts/custom ranges; deterministic id repair; quarantine | `packages/shared/src/local-*`; migration | `apps/extension/tests/storage/migration.test.ts`, upgrade rehearsal fixtures |
| Local data 5: integer ms everywhere; null-range full-episode local, unpublishable | domain + `ShareRangeSchema`/`UnpublishablePlaylistError` | domain + publication validation tests |
| Local data 6: `{schemaVersion:2,playlists}` whitelist export; import accepts legacy array + envelope; conflict choices | `local-export.ts`, `local-import.ts`, `apps/extension/src/ui/{options-io,import-merge}.ts` | `apps/extension/tests/portable/*`, `extension-portable.spec.ts` |
| Local data 7: detached publication vault; local-only delete; destroy-warning; no key export | `publications` in state; `apps/extension/src/ui/management.ts` | `apps/extension/tests/portable/{detach,management-ui}.test.ts`, upgrade leg 5 |
| Share schema: `SharedPlaylist` v1 bounds, NFC, canonical tags, item whitelist, opaque ids, ms ranges | `packages/shared/src/share-model.ts`, `limits.ts` | `packages/shared/tests/share.test.ts`, boundary tests |
| 256 KiB streaming cap; 10 MiB/10,000-item local import cap | `apps/web/src/server/security/http.ts`; `LOCAL_IMPORT_*` | `apps/web/tests/security/body-limits.test.ts`, portable tests |
| Canonical serialization + `contentHash`; redacted-GET hash semantics; dirty vs acknowledged hash | `share-canonical.ts`, `share-projection.ts`; `apps/extension/src/share/dirty-state.ts` | `packages/shared/tests/canonical-vectors.test.ts` + workerd parity leg, `apps/extension/tests/share-management/dirty-state.test.ts` |
| Local publish metadata; explicit first visibility; immutable sent snapshot | `PublishMetadataSchema`; share dialog | `apps/extension/tests/share-management/share-dialog.test.ts`, `share-management` specs |
| API table: all 7 routes, envelopes, status map | `apps/web/src/pages/api/v1/playlists/*`, `packages/shared/src/api.ts` | `publication-api/*`, `docs/api.md` (this doc's examples schema-validated) |
| Delivery protocol: pending→activate, key persistence before activate, lost-POST → `CREATE_RECEIPT_UNAVAILABLE`, pending expiry | `apps/web/src/server/services/{publication,mutations}.ts`; `apps/extension/src/share/publish-flow.ts`, `pendingCreates` | `publication-api/lifecycle|idempotency|provisional-expiry`, `share-management` fault tests; ADR-003 |
| Mutations/conflicts: 24 h receipts bind method+resource+hash+op; 409 paths; no background sync; remote-delete-then-local ordering | `publication_operations` + guarded batches; management handler | `idempotency.test.ts`, `concurrency.test.ts`, `share-failures` spec |
| D1 schema set + guarded CAS (attempt-nonce), indexes, bounded LIKE search | `apps/web/migrations/0001–0008`; `apps/web/src/server/repositories/*` | `repository/*` incl. `guard-atomicity`, `plans-limits` |
| Rate limits + fail-closed limiter; HMAC'd IP digests confined to limiter | `apps/web/src/server/security/rate-limit.ts`, `wrangler.jsonc` bindings, `DOP_RATE_LIMIT_REQUIRED` | `apps/web/tests/security/rate-limit.test.ts`, admission tests |
| Extension transport: fixed origin, `credentials:"omit"`, `redirect:"error"`, bounded reads, sender checks | `apps/extension/src/share/{api-client,management-client,origins}.ts` | `apps/extension/tests/share/*`, consent spec |
| Security headers/CSP; metadata as text; no remote code | `apps/web/src/server/security/headers.ts`, Astro inline-script policy, WXT bundles | `apps/web/tests/security/headers.test.ts`, `csp.spec.ts`, `verify:artifacts` remote-code scan |
| Secrets never in DOM/messages/URLs/logs/traces | vault projection; `apps/web/src/server/services/request-log.ts` redaction; sender authorization | `apps/web/tests/adversarial/capability-redaction.test.ts`, `apps/web/tests/security/logging.test.ts`, consent spec audit |
| Log fields template/status/duration/requestId only; retention windows; hard delete; takedown CLI | `apps/web/src/server/services/request-log.ts`; `apps/web/src/server/services/maintenance.ts`; `apps/web/src/server/repositories/takedown.ts` + `bun run takedown` | `apps/web/tests/security/logging.test.ts`, `apps/web/tests/security/takedown.test.ts`, `import-counts/atomicity-pruning` |
| Abuse contact `contact@sasnews.dev`; terms; operator-only takedown | `terms.astro`, `privacy.astro`, takedown repo+CLI | e2e footer/terms presence; takedown tests |
| Import: fresh local ids, post-commit `{eventId}`, one retry, receipt-guard exactly-once daily+lifetime | `apps/extension/src/share/import-notify.ts`; `apps/web/src/server/{services,repositories}/imports.ts` | `import-counts/*`, `import-notification/*` |
| Eligibility active+public+unblocked; unlisted never listed/ranked/suggested | `apps/web/src/server/discovery/queries.ts`, read projections | `discovery/*`, `remix/redaction.test.ts` |
| Rank policy 30→90→lifetime→new, `MIN_POSITIVE_PLAYLISTS=5`, zero-score tail, global-then-filter | `apps/web/src/server/discovery/{policy,engine}.ts` | `discovery/{policy,windows,collection}.test.ts`, `discover.spec.ts` matrix |
| 15-min ranking snapshots, 60 s first-page reuse, HMAC cursors, 410 expiry, 1,000 cap + `truncated`, live visibility recheck | `apps/web/src/server/discovery/{snapshots,cursor}.ts` | `discovery/*`, adversarial `ranking-churn` |
| `derivedFrom` first-publish-only, public-parent projection/redaction, bounded direct remix view, no cycles | `DerivedFromSchema`; `apps/web/src/server/services/publication.ts` admission; `remix` repos/services | `remix/*`, `extension-remix.spec.ts`, provenance unit tests |
| Architecture boundaries: entrypoints, `src/{adapter,domain,player,storage,share,ui}`, web `server/{repositories,services,security,discovery}`, vanilla DOM | `apps/extension/**`, `apps/web/**` | structure review; module-size convention |
| Verification strategy: TDD evidence per task, real runtimes, root commands, e2e origins synthetic | `.omo/evidence/*`, harnesses, `check:test-origins` | every row above |
| Store listings/consent/privacy parity | `STORE_LISTING.md`, `PRIVACY.md`, consent gate, `data_collection_permissions` | task-22 audit + consent spec |
| Release packaging: immutable tags, AMO source archive, least permissions, no auto-publish | `scripts/{verify-artifacts,pack-sources,pack-crx}.mjs`, `release.yml` | task-25 gates + self-test refusals |
| Upgrade/rollback rehearsal; signed-store identity distinction | `tests/browser/upgrade/*` | task-26 both legs |
| Staging/cutover runbooks + verify gates | `docs/staging.md`, `docs/cutover.md`, `scripts/verify-{staging,cutover}.mjs` | local rehearsals; remote halves PARTIAL |
| Traceability + release handoff | this file; `docs/release.md` status ledger | task-30 |

## 3. Approved amendments → where they landed

| Amendment | Landed in | Proof |
|---|---|---|
| Explicit `public`/`unlisted` choice on first publish (no default) | `visibility` required in `PublishMetadataSchema`; share-dialog consent+visibility step | `apps/extension/tests/share-management/share-dialog.test.ts`, management spec |
| Chrome current + previous major; Firefox stable + ESR | `tests/browser/*-harness.mjs`; matrix below | task-23 `native-*.json` |
| Import-completion notification as the popularity signal (no tracking) | `POST /:shareId/import` `{eventId}`; daily+lifetime counters | `import-counts/*` |
| Adaptive popular 30d→90d→lifetime→new; initial threshold 5 positive public playlists; zero-score stays listed | `apps/web/src/server/discovery/policy.ts` (`RANK_WINDOWS_DAYS`, `MIN_POSITIVE_PLAYLISTS`) | `discovery/*` matrices |
| Snapshot JSON instead of `playlist_items` table | `playlists.snapshot_json` canonical JSON | `repository/*`; ADR-002 |
| Provisional create + authenticated activate (lost-response protocol) | pending state + `CREATE_RECEIPT_UNAVAILABLE` | `publication-api/*`; ADR-003 |
| Capability vault separated from portable export | `publications` vault fields excluded from export schema | `apps/extension/tests/portable/export.test.ts` |

### Supported browser matrix (actually tested — task 23/26)

| Browser | Version | Binary | Coverage |
|---|---|---|---|
| Chrome stable (Chrome for Testing) | 153.0.8010.52 | `tools/browser-cache/chrome-153` | 31/31 extension specs + upgrade leg 65/65 |
| Chrome previous major (CfT) | 152.0.7977.82 | `tools/browser-cache/chrome-152` | 31/31 extension specs |
| Firefox stable | 153.0.1 | installed `firefox.exe` + geckodriver 0.37.1 | 36/36 checks + upgrade leg 59 |
| Firefox ESR | 140.16.0esr | `tools/browser-cache/firefox-esr` + geckodriver | 35/35 checks |
| Playwright bundled Chromium/Firefox | pinned by `@playwright/test` 1.61 | e2e default | `bun run test:e2e` suites only — NOT counted toward the native matrix |

Support policy: desktop Chrome **stable and previous major**; Firefox
**current stable and ESR** — matching the approved amendment. Versions
outside this matrix (mobile, other channels, older majors) are
unsupported/untouched claims — do not cite them.

## 4. Evidence gaps and honest limitations (the NOT RUN register)

| Limitation | Status | Where recorded |
|---|---|---|
| Remote staging deploy + `verify:staging` against a live workers.dev origin | **BLOCKED — NOT RUN** (no Cloudflare auth) | task-28 DoneClaim; `docs/staging.md` |
| Production deploy, DNS cutover, `verify:cutover` green run, Pages disable, `gh-pages`/`dev` retirement | **BLOCKED — NOT RUN** (CF auth + owner authorization + DNS) | task-29 DoneClaim; `docs/cutover.md`; `.omo/evidence/task-29-d-op-v2-share/release-checklist.md` |
| Archive-tag push to origin | **NOT RUN** — local tags `archive/{gh-pages,dev}-pre-cutover` created+verified; push is the documented operator step | task-29 `archive-legacy-site.log` |
| Real logged-in d-Anime smoke (Chrome + Firefox) | **NOT RUN — release-blocking** (2FA; no static accounts) | `docs/cutover.md` §9; task-23/26 claims |
| Signed-store update continuity (store-key identities vs unpacked-path ids) | **NOT RUN** — rehearsal proves unpacked-path identity only | task-26 DoneClaim; `docs/testing.md` |
| Store submissions (CWS + AMO) | **NOT RUN** — manual draft/review gate by design | `docs/release.md` |
| Production CRX signing | **NOT RUN** — no release key exists here (by design; `--self-test` proves the path) | task-25; `docs/release.md` |
| `scheduled()` cron export → `triggers.crons` TTL pruning | **not wired** — `runScheduledCleanup` exists; lazy per-request expiry covers pending provisionals meanwhile | `docs/staging.md` §9 |
| `RATE_LIMIT_HMAC_KEY` provisioning | **pending at deploy** — dev fallback (SHA-256) exists; staging/prod must `wrangler secret put` | `docs/staging.md` §2 |
| Firefox browser-level `storage.local` quota injection | **NOT RUN on Firefox** (~18.8 MB never rejected); fail-closed proven via Vitest fault leg + Chromium leg | task-26 `upgrade-firefox.json` |
| Firefox native data-collection doorhanger | **NOT RUN** — unanswerable headless; in-extension consent gate proven instead | task-22/23 |
| Chrome real `uninstall` orphan check | **NOT RUN** — no supported unpacked-API; proven on Firefox + DOM assertions | task-23 |
| Task-8 evidence directory | **absent** — coverage lives in `apps/extension/tests/adapter/`, `adapter-bridge.spec.ts`, commit `9b8f5f4`, and `.omo/notepads/d-op-v2-share/learnings.md` task-8 entries | this file §1 row 8 |
| Real-site DOM/timing for d-Anime (R3/R5/R6 rows) | **[UNVERIFIED]** — bounded by contract fixtures + synthetic harness | `docs/current-extension-behavior.md`, `docs/danime-player-contract.md` |
| Landing JSON-LD `softwareVersion` | intentionally `1.0.0` — tracks the *published* store version; bump to `2.0.0` (+ `landing.spec.ts`) when v2 is submitted | `docs/release.md` handoff notes |

## 5. Release handoff (what "done" still needs)

Release-complete requires, in order: Cloudflare auth → staging deploy +
`verify:staging` green (docs/staging.md) → production deploy + domain
attach + `verify:cutover` green (docs/cutover.md) → archive-tag push +
health window + rollback rehearsal → Pages/branch retirement → store
draft uploads + review → real logged-in d-Anime smoke (production
Extension release blocker). Until those receipts exist, overall release
status is **incomplete** — exactly as the plan's success criteria
require; nothing here is waived.
