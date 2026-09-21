# Testing

Bun is the task runner. Install once with `bun install --frozen-lockfile`
from the repo root (the lockfile is committed).

## Suites

| Command | What it runs |
|---|---|
| `bun run test:unit` | Vitest unit suite (`vitest.unit.config.ts`): extension `src/` + `packages/shared`. |
| `bun run test:worker` | Vitest Miniflare/D1 suite (`apps/web/vitest.worker.config.ts`): repositories, services, security, API routes. |
| `bun run test:e2e` | Playwright (`playwright.config.ts`). Spins up the fixture server (`tests/e2e/serve-fixture.mjs` on :8123), builds the extension (chrome+firefox mv3), and builds+previews the web app on :4321 (`DOP_WEB_PORT` overrides). |
| `bun run typecheck` | Root tsc → `wxt prepare` + extension tsc → `astro check` + `wrangler types`. |
| `bun run lint` | Biome check over the repo. |
| `bun run check:test-origins` | Fails if tests/fixtures reference real origins or secrets. |

`bun run test` runs unit + worker + e2e sequentially.

Release/artifact commands (see `docs/release.md`):

- `bun run build` — WXT production builds + `d-op-<v>-chrome.zip`, `d-op-<v>-firefox.zip`, `d-op-<v>-sources.zip` under `apps/extension/.output/`.
- `bun run verify:artifacts` — unpacks the zips and asserts manifest identity, permissions, required resources, and absence of fixture/secret/remote-code content; `--self-test` proves every gate can fail, `--release-tag v<x.y.z>` adds the immutable-tag refusal.
- `bun run pack:sources` / `bun run pack:crx` / `bun run rehearse:source-build` — AMO source archive, optional CRX signing, and the clean-build rehearsal.

Deployment/upgrade gates (runbooks in `docs/staging.md` / `docs/cutover.md`):

- `bun run verify:upgrade -- --browser=chromium|firefox` — installed-profile v1→v2 rehearsal (below).
- `bun run verify:staging -- --base-url=<staging-origin>` — disposable-resource API flow against a deployed staging Worker; remote run is BLOCKED until Cloudflare auth exists.
- `bun run verify:cutover -- --base-url=https://d-op.sasnews.dev` — non-mutating production gate; correctly fails while the domain still serves GitHub Pages.

Playwright projects:

- `web-chromium` / `web-firefox` — synthetic harness + Astro SSR pages (landing, explore, share page, CSP).
- `extension-chromium` — loads the real unpacked `apps/extension/.output/chrome-mv3` via `launchPersistentContext`. Every `extension-*.spec.ts` runs here.

## Supported browser matrix (native proof, task 23/26)

Support policy: **desktop Chrome stable + previous major** and
**Firefox current stable + ESR**. Only these recorded versions are
evidenced — do not claim others:

| Browser | Version tested | Harness | Result |
|---|---|---|---|
| Chrome stable (Chrome for Testing) | 153.0.8010.52 | `bun run test:browser:chrome -- --channel=stable` (`tests/browser/chrome-harness.mjs` → real CfT binary + `extension-chromium` specs) | 31/31 PASS |
| Chrome previous major (CfT) | 152.0.7977.82 | `bun run test:browser:chrome -- --channel=previous` | 31/31 PASS |
| Firefox stable | 153.0.1 | `bun run test:browser:firefox -- --channel=stable` (`tests/browser/firefox-harness.mjs` → geckodriver 0.37.1 `/moz/addon/install`) | 36/36 PASS |
| Firefox ESR | 140.16.0esr | `bun run test:browser:firefox -- --channel=esr` | 35/35 PASS |

Playwright's bundled Chromium and page-only Firefox are the `test:e2e`
defaults only — they never satisfy this matrix. Evidence:
`.omo/evidence/task-23-d-op-v2-share/native-*.json`. The harnesses resolve
real binaries from `tools/browser-cache/` (or the installed Firefox); a
missing binary is an explicit launch failure (exit 3), never a skip.

## E2E conventions

- **No real origins in tests.** `check:test-origins` enforces it. Extension specs intercept `https://d-op.sasnews.dev` routes with Playwright route handlers and abort every other external request — nothing real leaves the box.
- Seeds write `dop_v2_state` directly through `chrome.storage.local` inside the service worker (see `extension-privacy-consent.spec.ts::launchExtension`).
- Synthetic secrets only: shareIds like `e2eConsentShareId00001`, secrets like `e2e…{"0".repeat(34)}`, hashes as repeated hex chars. Never real credentials.
- Missing browser binaries are explicit launch failures, never skips.

## Consent coverage (task 22)

`tests/e2e/extension-privacy-consent.spec.ts` is the acceptance spec:

```text
bun run test:e2e -- --project=extension-chromium privacy-consent.spec.ts
```

It proves: zero Share API traffic before a choice; declined consent keeps local features with zero traffic; granted publish/import send only whitelisted payloads (POST body is the `SharedPlaylist`, PATCH is the operation envelope, notify is `{eventId}`, secret only in `Authorization`); revocation blocks future traffic without deleting remote/local records; foreign (non-options) senders get `forbidden` regardless of consent.

Share-aware specs (`extension-share-management`, `extension-remix`, `extension-web-import`) seed `shareConsent: granted` because they intentionally exercise Share; local-only specs leave it absent.

Unit-side, `apps/extension/tests/share/consent.test.ts` covers the gate semantics (undecided/declined/granted, Firefox `data_collection` interplay, fail-closed reads) and `tests/share-management/` + `tests/import-notification/` cover handler gating.

## Firefox native consent smoke

`bun run test:browser:firefox` (`tests/browser/firefox-harness.mjs`, task 23)
loads the real `firefox-mv3` build into stable/ESR Firefox via geckodriver
`/moz/addon/install` — never Playwright's page-only Firefox. The native
`data_collection_permissions` doorhanger is unanswerable under headless
geckodriver, so the harness sets
`extensions.dataCollectionPermissions.enabled=false` and exercises the
in-extension consent gate (the same path Chrome and Firefox <140 use);
the native-layer prompt itself is recorded NOT RUN in the leg JSONs.

## Installed-profile upgrade rehearsal (task 26)

```text
bun run verify:upgrade -- --browser=chromium
bun run verify:upgrade -- --browser=firefox
```

`tests/browser/upgrade/` rehearse the real v1.0.0 → v2 migration on disposable profiles only (`tools/browser-cache/upgrade/<browser>/`, never a real user profile). Each leg extracts the tagged v1 extension from git, seeds all legacy keys through v1's own write helpers, swaps the extension files in place under the same unpacked-path identity, verifies the full migration (playlist/order/name/clip preservation, typed-range fan-out, duplicate/missing id repair, preferences, quarantine with original bytes, byte-identical legacy snapshot), restarts the browser, exercises detached Share management keys across a replace import, safe-export/wipe/re-import round-trip, quota/future-schema/interrupted-persistence fault legs, and rollback to v1.

Machine-readable results land in `.omo/evidence/task-26-d-op-v2-share/upgrade-<browser>.json` plus before/after storage snapshots and the two safe-export files.

Browser-specific notes:

- Chromium uses Chrome for Testing (`tools/browser-cache/chrome-153`) via Playwright; the unpacked id (`kopmhdpbgncfmjjbocejkenkkbkiefnb`) derives from the extension path, not the Web Store listing.
- Firefox uses the installed Firefox binary + geckodriver (`WebDriverClient`, never Playwright's Firefox); identity is the gecko id `d-op@sasnews.dev` with a pinned `extensions.webextensions.uuids` entry so `storage.local` survives restarts. The Firefox leg records `quota/browser-level quota injection` as NOT RUN: its storage.local did not reject after 3400 items / ~18.8 MB, so fail-closed quota coverage comes from the Vitest fault leg plus the chromium browser leg.
- Neither leg exercises signed/store update continuity — the store-signed identities (Chrome `mcjkaoagedekadnimbcbkhdkgpbnnodc`, Firefox `d-op@sasnews.dev`) are distinct from unpacked-path installs, and signing credentials are not part of the rehearsal.
