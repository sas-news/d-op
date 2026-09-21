import cloudflare from "@astrojs/cloudflare"
import { defineConfig } from "astro/config"

// Task 2 web skeleton: SSR on Workers, sessions disabled (no KV provisioned),
// image passthrough (no Images binding), D1 binding declared in wrangler.jsonc.
export default defineConfig({
  output: "server",
  adapter: cloudflare({
    imageService: "passthrough",
    platformProxy: { enabled: true },
  }),
  session: false,
  build: {
    // CSP is style-src 'self' with no unsafe-inline: page styles must ship as
    // external same-origin stylesheets, never inlined <style> blocks.
    inlineStylesheets: "never",
  },
})
