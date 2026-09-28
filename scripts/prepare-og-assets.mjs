// Stages the OGP renderer's font assets into apps/web/public/assets/og/.
//
// The /p/:shareId/og.png renderer (src/server/services/share-og.ts) loads the
// Noto Sans JP / IBM Plex Mono font files through the Worker's ASSETS binding,
// so they must exist under public/ before `astro build` (which copies public/
// into dist/) and before Miniflare worker tests (which serve assets from
// public/ directly). The resvg wasm binary is NOT staged here — workerd
// forbids runtime wasm codegen, so it enters the worker bundle as a
// pre-compiled WebAssembly.Module import instead (wrangler's default
// CompiledWasm rule). The fonts come from the installed npm dependencies —
// pinned by bun.lock — so they are regenerated, never committed.

import { cpSync, mkdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(REPO_ROOT, "apps/web/package.json"))
const OUT = join(REPO_ROOT, "apps/web/public/assets/og")

// Font packages expose no exports map, so resolve their root via
// ./package.json.
const fontDir = (name) => dirname(require.resolve(`${name}/package.json`))

const SOURCES = [
  [
    join(fontDir("@expo-google-fonts/noto-sans-jp"), "400Regular/NotoSansJP_400Regular.ttf"),
    "NotoSansJP-Regular.ttf",
  ],
  [
    join(fontDir("@expo-google-fonts/noto-sans-jp"), "700Bold/NotoSansJP_700Bold.ttf"),
    "NotoSansJP-Bold.ttf",
  ],
  [
    join(fontDir("@expo-google-fonts/noto-sans-jp"), "900Black/NotoSansJP_900Black.ttf"),
    "NotoSansJP-Black.ttf",
  ],
  [
    join(fontDir("@expo-google-fonts/ibm-plex-mono"), "500Medium/IBMPlexMono_500Medium.ttf"),
    "IBMPlexMono-Medium.ttf",
  ],
  [
    join(fontDir("@expo-google-fonts/ibm-plex-mono"), "700Bold/IBMPlexMono_700Bold.ttf"),
    "IBMPlexMono-Bold.ttf",
  ],
]

mkdirSync(OUT, { recursive: true })
for (const [from, name] of SOURCES) {
  cpSync(from, join(OUT, name))
  console.log(`og-assets: ${name}`)
}
