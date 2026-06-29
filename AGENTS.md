# AGENTS.md — dアニメ OPED Player

## What this repo is

Chrome Manifest V3 extension with **no build step, no package manager, and no tests**. All files are loaded directly by the browser from the repo root. Edit HTML/JS/CSS and reload the extension in `chrome://extensions` to verify.

## Entrypoints and file roles

- `manifest.json` — MV3 manifest. Declares two content scripts, one background service worker, popup, options page, and `injected.js` as a web-accessible resource.
- `background.js` — Only responsibility: inject `injected.js` into the **MAIN** world when `content.js` sends `INJECT_SCRIPT`.
- `common.js` — Shared storage layer (`chrome.storage.local`) and playlist helpers. Loaded by content scripts, popup, and options page.
- `injected.js` — Runs in the page's main world, reads `window.vc.ws010105Data.chapters`, and exposes `SEEK`/`PLAY`/`PAUSE` commands via `window.postMessage`.
- `content.js` — Isolated-world content script for the **player page** (`sc_d_pc`). Orchestrates OP/ED enforcement, playlist playback, seek-bar markers, and the bottom control bar.
- `content-store.js` — Isolated-world content script for **work/episode-list pages** (everything under `/animestore/` except `sc_d_pc`). Adds per-episode OP/ED menus and fetches player-page HTML to read chapter data.
- `popup.*` / `options.*` — Extension popup and playlist management page.

## Architecture constraints you will break if you are not careful

- **Never access `window.vc` directly from `content.js`**. The player object lives in the main world; use `window.postMessage` to talk to `injected.js`.
- **Chapters are not labeled by d-Anime**. `ws010105Data.chapters[].type === 'none'` marks skippable sections, but there is no `op`/`ed` flag. Names are guessed heuristically (duration ~1:30 + position) and stored as `range.name`.
- **Ranges are name-only now**. Legacy data had `range.type` (`op`/`ed`/`custom`). New code writes `{ start, end, name }`. `common.js` migrates old `type` values into names on read.
- **Two navigation systems**:
  1. Work-page menus open the player with `dopRangeIndex` and an op-ed persistence flag in storage (`dop_oped_mode`).
  2. Playlist playback stores `{ playlistId, index }` in `dop_playback` and crosses episodes via URL params `dopPlaylistId`/`dopIndex`.
- Do not confuse the two: playlist mode hides native prev/next; op-ed mode must leave them visible.

## How to verify changes

1. Open `chrome://extensions` → enable Developer mode → Load unpacked → select this repo root.
2. Edit source files.
3. Click the reload icon on the extension card in `chrome://extensions`.
4. Test on an actual d-Anime Store episode/work page; there is no local test harness.

## High-risk areas when editing

- **MutationObserver** (`content.js`) runs on the whole player DOM. Always guard expensive work with flags/debounce; rebuilding UI on every tick froze the browser in earlier iterations.
- **`createAddButton` popup** is rebuilt only when `partId` changes or it has never been built. If you change the popup contents, clear the wrapper or reset `wrapper.dataset.dopPopupBuilt`.
- **`updateSeekMarkers`** is async and reads all playlists from storage. It is debounced (100 ms) and guarded against concurrent runs.
- **Work-page chapter fetch** (`content-store.js fetchChapters`) parses the player-page HTML with regex for `"chapters"` and `"duration"`. If d-Anime changes the HTML shape, the fallback is to open the first range.
- **Do not use browser `alert`/`confirm`/`prompt`**. The UI uses custom modals defined in `styles.css` / `styles-store.css`.

## Style and conventions

- No formatter/linter is configured; match the existing plain JS style.
- Use `chrome.storage.local` only through `common.js` helpers; do not write raw storage keys outside it.
- Keep UI controls visually aligned with the native 50 px d-Anime control bar.
- Hide generated extension UI when not in use; never leave orphaned DOM nodes after mode changes.
