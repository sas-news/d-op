# Architecture

Bun monorepo, two deployables, one shared package. Final documentation pass is task 30; this page fixes the module-level picture.

## Layout

```text
apps/extension/   WXT project — Chrome + Firefox MV3 extension
apps/web/         Astro + Cloudflare Workers/D1 — d-op.sasnews.dev (pages + /api/v1/*)
packages/shared/  Zod schemas + pure logic shared by both (local model, share model, API contract)
tests/e2e/        Playwright suites + fixture harness server
docs/             This directory
```

## Boundaries

- **Storage single-writer**: canonical state lives in `dop_v2_state` (`browser.storage.local`). Only the background repository (`apps/extension/src/storage/`) writes it, via revision-checked commands dispatched over runtime messaging. UI pages use `UiStorageClient`/`runMutation`.
- **Share traffic is background-only and consent-gated**: `apps/extension/src/share/` holds the API clients, the management handler (options-only senders), the import handler, and the consent gate. See `docs/share.md` for the full route/payload/persistence disclosure.
- **d-Anime boundary**: `entrypoints/danime-main.ts` (main world) owns `window.vc`; isolated content scripts talk to it over `postMessage` via `src/adapter/`.
- **Web stack**: Astro SSR pages in `apps/web/src/pages/`; D1 repositories, services, and security (rate limit, capability hashing, redacted logging) under `apps/web/src/server/`; ordered SQL in `apps/web/migrations/`.
- **Shared schema boundary**: every external input (storage reads, runtime messages, HTTP bodies) is parsed with `packages/shared` Zod schemas at the boundary.
