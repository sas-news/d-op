# ADR 001 — Toolchain (task 2, 2026-09-18)

Bun workspace foundation for d-OP v2. Resolved against the live npm registry on
2026-09-18 with Bun 1.3.13 / Node v24.19.0. Plan-time version guesses were NOT
copied; every pin below is a released version verified for peer compatibility.

## Locked versions (exact in manifests, pinned in bun.lock)

| Package | Version | Why this one |
| --- | --- | --- |
| wxt | 0.21.4 | latest; needs vite ^6.3.4 \|\| ^7 \|\| ^8, typescript >= 5.4 |
| vite | 7.3.6 | latest 7.x; satisfies wxt peer |
| typescript | 5.9.3 | latest 5.x; satisfies wxt >= 5.4; TS 7.0.2 exists but is unproven with astro 7 / @astrojs/check |
| astro | 7.3.3 | latest 7.x, required peer ^7.2.0 of the Cloudflare adapter |
| @astrojs/cloudflare | 14.3.2 | latest; peer astro ^7.2.0, wrangler ^4.125.0 |
| wrangler | 4.134.0 | latest 4.x; satisfies adapter peer ^4.125.0 |
| vitest | 4.1.11 | latest 4.x; satisfies @cloudflare/vitest-plugin peer ^4.1.0 (vitest 5.0.1 does NOT) |
| @cloudflare/vitest-plugin | 1.1.12 | current documented worker-test integration (`cloudflareTest`); replaces legacy @cloudflare/vitest-pool-workers per Cloudflare migration guide |
| @astrojs/check | 0.9.10 | released; powers `astro check` |
| @cloudflare/workers-types | 5.20260918.1 | D1Database typing for `requireDb` |
| @biomejs/biome | 2.5.14 | TS/JS/JSON lint+format |
| jsdom | 30.1.0 | reserved for task 5 DOM units |
| @types/node | 26.6.1 | unit-test Node globals |

Supported Node-runtime exception: none yet. Vitest/workerd run under Node as required
by supported tooling; Bun remains dependency manager and root command entrypoint.
No Bun runtime-only APIs are used in Worker/shared output (`apps/web/src/server/env.ts`
is runtime-neutral; verified by workerd execution in `test:worker`).

## Worker configuration

- `apps/web/astro.config.mjs`: `output: "server"`, adapter `imageService: "passthrough"`
  (no Images binding), `platformProxy.enabled: true`, top-level `session: false`
  (no SESSION KV provisioned, session runtime excluded).
- `apps/web/wrangler.jsonc`: `main` is the current unified
  `@astrojs/cloudflare/entrypoints/server` (serves both dev and prod; the old
  `dist/_worker.js` entrypoint was removed in adapter v13), explicit
  `d1_databases` binding `DB`, `assets` binding for `./dist`, no
  `kv_namespaces`, no `images`. `database_id` is the all-zero placeholder — real
  IDs come only from authorized provisioning (task 28); never guessed.
- `worker-configuration.d.ts` is generated via `wrangler types` during `bun run check`.

## Extension manifests

- `apps/extension/wxt.config.ts` declares name, permissions (`tabs`, `storage`),
  both d-Anime host permissions, and the Firefox gecko ID `d-op@sasnews.dev`
  (with `data_collection_permissions.required: ["none"]`, matching legacy).
  WXT emits `background.service_worker` for Chrome and `background.scripts` for
  Firefox from `entrypoints/background.ts`. Content scripts, popup/options entries,
  and icons land in tasks 8/10/21/25. Skeleton version is 0.1.0; the first
  production v2 release uses v2.0.0 (or newer if published meanwhile) per task 25.
  > Task 25 update: version moved to `apps/extension/package.json` (2.0.0) as the
  > single source WXT injects; icons shipped via `public/icons/`; the legacy root
  > runtime listed below was removed after parity evidence (history at tag v1.0.0).

## Release safety (task 2 slice, full gate in tasks 5/25)

- Legacy root runtime (`manifest.json`, `manifest.firefox.json`, `background.js`,
  `common.js`, `content*.js`, `injected.js`, `popup.*`, `options.*`) is untouched
  and still loads directly in browsers.
  > Task-25 update: those root files were removed after parity evidence; the
  > historical source stays at git tag `v1.0.0`. The destructive
  > delete/recreate release workflow was replaced by an immutable-tag,
  > human-approved `workflow_dispatch` (`docs/release.md`).
- `.github/workflows/release.yml` gains a `Block incomplete v2 auto-release` step:
  while `apps/extension/` exists without `.omo/v2-store-release-approved`, the job
  fails before any tag deletion or artifact publication.

## Scripts (stable names for tasks 3/4/5/8)

Real now: `dev:extension`, `dev:extension:firefox`, `dev:web`, `build`, `test`
(unit+worker), `test:unit`, `test:worker`, `typecheck`, `lint`. Honest stubs that
exit 1 (`test:e2e`, `test:browser:firefox`, `verify:artifacts`, `verify:upgrade`,
`verify:staging`, `verify:cutover`) are owned by tasks 5/23/25/26/28/29.
`test:unit`/`test:worker` forward CLI args and fail on zero selected tests
(`passWithNoTests: false`; verified with `does-not-exist.test.ts`).
> Task-30 status: every stub has since been implemented — `test:e2e` (Playwright,
> task 5), `test:browser:firefox`/`test:browser:chrome` (native harnesses,
> task 23), `verify:artifacts` (task 25), `verify:upgrade` (task 26),
> `verify:staging` (task 28), `verify:cutover` (task 29). `test` now runs
> unit + worker + e2e. See `docs/testing.md`.

## Evidence

`.omo/evidence/task-2-d-op-v2-share/`: `baseline.txt`, `red-commands.log`,
`green-*.log`, `zero-selection.log`, `artifacts/` (generated manifests, worker
output excerpts, `wrangler types` diff).
