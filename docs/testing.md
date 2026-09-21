# Testing

Bun is the task runner. Install once with `bun install` from the repo root.

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

Playwright projects:

- `web-chromium` / `web-firefox` — synthetic harness + Astro SSR pages (landing, explore, share page, CSP).
- `extension-chromium` — loads the real unpacked `apps/extension/.output/chrome-mv3` via `launchPersistentContext`. Every `extension-*.spec.ts` runs here.

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

`bun run test:browser:firefox` is owned by tasks 5/23 and is currently a stub that exits non-zero. When implemented it must load the real Firefox build and exercise the `data_collection_permissions` path. Do not substitute Playwright's page-only Firefox.
