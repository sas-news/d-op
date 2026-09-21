/// <reference path="../../../worker-configuration.d.ts" />

// The wrangler-generated worker-configuration.d.ts (committed to the repo)
// declares `Cloudflare.Env` and `declare module "cloudflare:workers"`. The
// apps/web tsconfig lists it in `include`, so `bun run check` sees it
// directly; the root tsconfig covers apps/web/src but not that file, so the
// root project reaches the identical ambient declarations through this
// reference. This keeps `import { env } from "cloudflare:workers"` — the only
// env access supported by @astrojs/cloudflare 14 — resolvable under both
// typecheck gates without duplicating the generated declaration.
