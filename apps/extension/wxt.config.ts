import { defineConfig } from "wxt"

// Task 2 WXT skeleton: generate per-browser MV3 manifests preserving listing identity
// inputs (name, permissions, d-Anime hosts, Firefox gecko ID). WXT emits
// background.service_worker for Chrome and background.scripts for Firefox.
// Content scripts, popup/options entries, and icons land in tasks 8/10/21/25.
export default defineConfig({
  // Both target browsers ship MV3 (matching legacy manifest.json / manifest.firefox.json).
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: "d-OP",
    version: "0.1.0",
    description:
      "dアニメストアの動画からOP/EDを抽出して連続再生。劇中歌や好きなシーンのプレイリスト化にも対応しています！",
    homepage_url: "https://github.com/sas-news/d-op",
    permissions: ["tabs", "storage"],
    host_permissions: ["https://animestore.docomo.ne.jp/*", "https://anime.dmkt-sp.jp/*"],
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "d-op@sasnews.dev",
              data_collection_permissions: { required: ["none"] },
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
