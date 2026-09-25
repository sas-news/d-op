import { defineConfig } from "wxt"

// Task 2 WXT skeleton, task 25 packaging: generate per-browser MV3 manifests
// preserving listing identity inputs (name, permissions, d-Anime hosts,
// Firefox gecko ID). WXT emits background.service_worker for Chrome and
// background.scripts for Firefox.
// The manifest version is intentionally NOT set here: WXT resolves it from
// apps/extension/package.json so package.json stays the single version source
// (scripts/verify-artifacts.mjs asserts manifests/package.json equality).
export default defineConfig({
  // Both target browsers ship MV3 (matching legacy manifest.json / manifest.firefox.json).
  manifestVersion: 3,
  zip: {
    // Release zips land in .output/ as d-op-<version>-<browser>.zip. WXT's
    // zero-zip writer emits sorted entries with zeroed timestamps, so the same
    // input bytes always produce the same archive bytes.
    name: "d-op",
    // The AMO reproducible source archive is repo-wide (lockfile + workspace);
    // scripts/pack-sources.mjs owns it, so WXT's per-package sources zip is off.
    zipSources: false,
  },
  manifest: ({ browser, mode }) => ({
    name: "d-OP",
    // Store listing text lives in STORE_LISTING.md (repo root) — keep this summary
    // in sync with it (the same sentence is the stores' short description).
    description:
      "dアニメストアの動画からOP/EDを抽出して連続再生。劇中歌や好きなシーンのプレイリスト化に加え、作成したリストの公開・共有にも対応しています！",
    homepage_url: "https://github.com/sas-news/d-op",
    // Task 25: ship the same icon set the v1 listing used (copied from the
    // historical root icons/ into public/icons/ so WXT emits them).
    icons: {
      16: "icons/icon16.png",
      32: "icons/icon32.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png",
    },
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
