import { handle } from "@astrojs/cloudflare/handler"
import type { D1Database, ExecutionContext, ScheduledController } from "@cloudflare/workers-types"
import { requireDb } from "./server/env"
import { runScheduledCleanup } from "./server/services/maintenance"

// Worker entry point. `wrangler.jsonc` points `main` here so the deployed
// worker wraps the Astro adapter's fetch handler with a `scheduled` handler —
// `triggers.crons` runs the retention sweep (expired provisionals, receipts,
// discovery snapshots, day buckets) instead of letting them accumulate.
type CronEnv = { readonly DB?: D1Database | undefined }

export default {
  fetch: handle,
  scheduled(_controller: ScheduledController, env: CronEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduledCleanup(requireDb(env)))
  },
}
