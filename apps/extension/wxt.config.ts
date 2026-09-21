import { defineConfig } from "wxt"

// Task 2 WXT skeleton: generate per-browser MV3 manifests preserving listing identity
// inputs (name, permissions, d-Anime hosts, Firefox gecko ID). WXT emits
// background.service_worker for Chrome and background.scripts for Firefox.
// Content scripts, popup/options entries, and icons land in tasks 8/10/21/25.
export default defineConfig({
  // Both target browsers ship MV3 (matching legacy manifest.json / manifest.firefox.json).
  manifestVersion: 3,
  manifest: ({ browser, mode }) => ({
    name: "d-OP",
    version: "0.1.0",
    description:
      "dアニメストアの動画からOP/EDを抽出して連続再生。劇中歌や好きなシーンのプレイリスト化にも対応しています！",
    homepage_url: "https://github.com/sas-news/d-op",
    permissions: ["tabs", "storage"],
    host_permissions: [
      "https://animestore.docomo.ne.jp/*",
      "https://anime.dmkt-sp.jp/*",
      // Task 17: the background worker fetches the fixed Share API origin
      // cross-origin (credentials omitted). Localhost dev origins join ONLY
      // in non-production builds — they never enter a release manifest.
      "https://d-op.sasnews.dev/*",
      ...(mode === "production" ? [] : ["http://localhost:4321/*", "http://127.0.0.1:4321/*"]),
    ],
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "d-op@sasnews.dev",
              // Task 22: ordinary use is local-only, so NOTHING is required —
              // "none" stays accurate because Share is an optional feature.
              // The optional categories mirror the actual Share payload and
              // are only granted after the explicit in-extension consent
              // (Firefox ≥140 shows the native prompt; src/share/consent.ts
              // keeps this list in sync with SHARE_DATA_COLLECTION_PERMISSIONS):
              //  - websiteContent — published snapshots carry titles/episode
              //    titles/ids of d-Anime pages the user curated.
              //  - personallyIdentifyingInfo — author/description are
              //    free-text fields that may carry a self-provided name.
              //  - technicalAndInteraction — the anonymous aggregate import
              //    notification ({eventId} only) signals extension usage.
              data_collection_permissions: {
                required: ["none"],
                optional: [
                  "websiteContent",
                  "personallyIdentifyingInfo",
                  "technicalAndInteraction",
                ],
              },
            },
          },
        }
      : {}),
    web_accessible_resources: [
      {
        resources: ["danime-main.js"],
        matches: ["https://animestore.docomo.ne.jp/*", "https://anime.dmkt-sp.jp/*"],
      },
    ],
  }),
})
