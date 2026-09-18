# Current Extension Behavior Inventory (baseline fc9d7fd)

Scope: checked-in legacy MV3 extension at `fc9d7fd60a057c5054aadb49e7e1297320f313e4` (v1.0.0).
All paths below are repo-root-relative at that baseline; after relocation use
`git show <baseline>:<path>`. No authenticated real-site run was performed;
anything requiring a logged-in player is marked real-site-unverified.

Legend per item: [OBSERVED] source-grounded fact, [INFERRED] intent read from
code, [DEFECT] known/suspected bug, [DELTA] intentional v2 correction,
[UNVERIFIED] needs real logged-in d-Anime to confirm.

## 1. Entrypoints and manifests

- [OBSERVED] `manifest.json` (Chrome): MV3, `background.service_worker =
  background.js`, permissions `tabs`+`storage`, host permissions
  `https://animestore.docomo.ne.jp/*` + `https://anime.dmkt-sp.jp/*`,
  player content stack `browser-polyfill.js, common.js, content.js` on
  `sc_d_pc?*`, store stack `browser-polyfill.js, common.js, content-store.js`
  elsewhere under `/animestore/`, `injected.js` as web-accessible resource.
  Maps to task 8 (adapter) / task 2 (generated manifests).
- [OBSERVED] `manifest.firefox.json`: identical except `background.scripts =
  [browser-polyfill.js, background.js]` plus `browser_specific_settings.gecko`
  id `d-op@sasnews.dev` and `data_collection_permissions.required = [none]`.
  Maps to task 2 / task 25 packaging.
- [OBSERVED] Release workflow `.github/workflows/release.yml:17-72`: zips the
  15 root files + icons for Chrome; rebuilds Firefox dir with
  `manifest.firefox.json -> manifest.json`; optional CRX; then
  **deletes and recreates** tag `v<version>` and the GitHub release
  (`git push origin :refs/tags/...`, `gh release delete --yes`, draft
  release). [DEFECT/DELTA] destructive tag/replacement history; v2 must use
  immutable tags (plan task 25). [UNVERIFIED] actual store upload behavior.

## 2. Persistent keys and transient state

| Key | Owner/writer | Shape | Behavior |
| --- | --- | --- | --- |
| `dop_playlists` | `common.js dopGetPlaylists/dopSavePlaylists`; every UI reads/writes directly, no serialization | Array of `{id, name, items[]}`, item `{id, partId, workId, title, episodeTitle, episodeNumber, url, range:{start,end,name?} or null}` + legacy `opRange/edRange/customRange/type` on read | `dopSavePlaylists` throws localized quota error only when message contains `QUOTA`, else rethrows. Maps to tasks 3, 7, 11. |
| `dop_playback` | popup/options create via `dopSetPlayback`; player overwrites; background reads for recovery | `{playlistId, index, shuffledIndices?, updatedAt, windowId?}` | `dopSetPlayback` preserves an existing `windowId`, else stamps `dopGetWindowId()` (real window id or negative `Date.now` fallback). Expires after 5 min (`DOP_RESUME_MAX_AGE_MS`). Maps to tasks 7, 9. |
| `dop_pending` | written only to clear (`dopClearPending` in popup/options/content `beforeunload`); never populated with a value in this tree | opaque / always cleared | [INFERRED] leftover key from an older handoff design. [DELTA] v2 replaces with typed operation ledger (task 7). |
| `dop_oped_mode` | content.js `dopSetOpEdMode(true/false)` | `{active:true, updatedAt}` or absent; 5-min max age | Persists work-page OP/ED intent across navigation; gated by `sessionStorage dop_oped_active`. Maps to tasks 7, 9. |
| `dop_window_mode` | options radios; background `getWindowMode()` | `'window'` (default) \| `'tab'` | Controls popup-vs-tab player creation. Maps to tasks 9, 10. |
| `dop_collapsed_playlists` | options `dopSetCollapsedPlaylist` | `{[playlistId]: bool}` | Collapse UI state only. Maps to task 10. |
| `dop_player_window` | background `savePlayerWindowBounds/getStoredWindowBounds` | `{windowId, left, top, width, height}` | Restores popup geometry; removed on player close. Maps to task 9. |
| `sessionStorage dop_oped_active` | content.js | `'1'` flag | Second factor for op-ed resume; cleared by `clearPlaylistState`. |
| URL params `dopRangeIndex/dopTitle/dopEpisodeTitle/dopPlaylistId/dopIndex` | content-store.js writes; content.js `readUrlParams` consumes then `history.replaceState` strips | ints/strings | Two navigation systems (see section 8). Maps to task 9. |

## 3. Runtime message handlers (every handler mapped)

Background `background.js:137-157` [OBSERVED]:
- `REQUEST_PLAYER {url}` -> `handleRequestPlayer(url)`. Mapped task 9.
- `OPEN_PLAYER {url}` -> same handler (legacy alias, no distinct behavior).
  [INFERRED] kept for older content scripts. Mapped task 9 (keep or retire explicitly).
- `RELEASE_PLAYER` -> `handleReleasePlayer()` (sends `PLAYLIST_STOP` to tab,
  removes tab, clears `dop_playback/dop_pending/dop_player_window`). Mapped task 9.
- `FORWARD_TO_PLAYER {command, payload}` -> `tabs.sendMessage(tabId, {type:
  command, payload})` fire-and-forget with `.catch(()=>{})`. Mapped task 9.

Player `content.js handleRuntimeMessage (1451-1469)` [OBSERVED]:
- `PLAYLIST_PREV` -> `handlePrevClick()` (single = restart range, double =
  step back, see section 5). Task 9.
- `PLAYLIST_NEXT` -> `advancePlayback(1)`. Task 9.
- `PLAYLIST_STOP` -> `clearPlaylistState()`. Task 9.
- `PLAYLIST_JUMP {index}` (display/shuffle position) -> `jumpToPlaylistIndex`.
  Task 9.

Main-world bridge `injected.js:181-206` to-page [OBSERVED], origin-checked
(`event.origin === location.origin`, `source === d-op-injected`):
- `SEEK {time}` `PLAY {}` `PAUSE {}` `BLOCK_AUTO_ADVANCE`
  `UNBLOCK_AUTO_ADVANCE` `GO_NEXT`. Tasks 8, 9.
- `CHAPTERS_FOUND` from-page consumed by content.js `init` message listener
  (1514-1521), also origin/source-checked. Task 8.

Popup sends [OBSERVED]: `REQUEST_PLAYER` (ordered + shuffle starts),
`FORWARD_TO_PLAYER PLAYLIST_JUMP/PREV/NEXT`, `RELEASE_PLAYER` (stop).
Content-store sends `REQUEST_PLAYER` only. All mapped tasks 8-10.

## 4. Playlist CRUD, copy, reorder, import/export

- [OBSERVED] `common.js:386-465`: `dopCreatePlaylist` (randomUUID, empty
  items), `dopAddItemToPlaylist` (assigns fresh id, push), `dopDeletePlaylist`
  (+ clears playback if it pointed at it), `dopRenamePlaylist`,
  `dopRemoveItem`, `dopClearItems` (dead code, no caller in tree), `dopMoveItem`
  (+/-1 swap, dead code, no caller), `dopCopyItemToPlaylist` (via `cleanItem`
  + fresh id). Maps to tasks 3, 6, 7, 10.
- [OBSERVED] Options edit (`options.js:157-180`): inline range name/start/end
  edit with `parseTimeInput`, rejects `start >= end` with status line, saves
  via `dopSavePlaylists`, empty name stored as `undefined`. Task 10.
- [OBSERVED] Copy dialog (`528-594`): any non-system playlist selectable as
  target, including the source itself (self-copy allowed). Task 10.
- [OBSERVED] Drag reorder (`300-392`): grip-only mousedown, floating clone,
  FLIP animation, clamps to list bounds, persists order on mouseup only if
  every id still resolves. No keyboard reorder path. Task 10.
- [OBSERVED] System playlists: any name starting `__dop_` hidden in popup and
  options, excluded from export/import. No creator in tree. Task 10.
- [OBSERVED] Export (`817-827`): **unsafe broad export**, serializes the full
  stored array (including internal ids, no schema version, no whitelist).
  Task 11 must replace with `{schemaVersion:2, playlists}` whitelist.
- [OBSERVED] Import (`829-891`): accepts root array only, regenerates missing
  ids, defaults missing fields to `''`/null, filters system playlists.
  Existing non-empty library forces a 3-way choice: replace / merge / cancel
  (`showImportChoice`); same-name sets offer merge-with-dedup vs separate-with-rename
  (`showMergeNameChoice`, `mergePlaylists`, `dedupeNames`). Dedup key is
  `item.id` plus `partId|start|end`. Tasks 3, 11.
- [DEFECT] Import drops `episodeNumber` (`options.js:841-849` builds the
  cleaned item without `episodeNumber`; `STORE_LISTING` sample has none
  either). Must be labeled fix, not preserved loss. Task 11.
- [DEFECT] `dedupeNames` mints a new playlist id for renames but `merge`
  path reuses imported item ids verbatim, so a re-imported file can collide
  with live ids. No dedup pass exists. Task 7/11 delta.
- [OBSERVED] `test/sample_playlist.json`: root-array legacy export with two
  playlists, ranges in ms with names OP/ED. Compatibility fixture for task 3/11.

## 5. Playback, shuffle, prev/next, completion

- [OBSERVED] Ordered start (`popup startPlaylistItem`, `options
  startPlaylistPlayback`): stores `{playlistId, index (real index),
  updatedAt}`, clears pending, opens item URL + `dopPlaylistId/dopIndex`.
  Refuses empty playlist and null-range item with an error modal (options) or
  silent return (popup clicked row). Tasks 9, 10.
- [OBSERVED] Shuffle start (`popup 42-54`): Fisher-Yates
  `dopCreateShuffledIndices`, stores shuffle position 0 in `index` but passes
  the *real* index in the URL. `startShuffleFromHere (56-71)` keeps the prefix
  and reshuffles the suffix (`dopReshuffleFromPosition`) or builds a
  clicked-first permutation (`dopCreateShuffledFromIndex`: prefix `0..start`
  kept in order, suffix shuffled). Current item is preserved across
  reshuffle. Tasks 6, 9, 10.
- [OBSERVED] Popup during playback renders `shuffledIndices ? shuffled :
  ordered` list, `pos+1 / len` counter, SHUFFLE badge, prev disabled at 0,
  next disabled at end, click row = `FORWARD_TO_PLAYER PLAYLIST_JUMP`. Note
  `doRender (105-107)` reads `playlist.items[playbackState.index]` (unused
  `item`) and separately resolves the real item; harmless but confusing.
  Task 10.
- [OBSERVED] Player `startPlayback (229-267)`: null-range item aborts silently
  (clears state); same-episode path reuses stored shuffle order and takes an
  800 ms startup lock, fresh navigation takes 8000 ms; pauses, then
  `seekToStartWhenReady` (polls `seeked` up to 3 retries, 3000 ms deadline)
  then plays. `playItemInCurrentVideo` vs `goToPlaylistItem` (same partId =
  in place, else new player URL via background). `advancePlayback` guarded by
  `advancingPlayback` flag. Tasks 8, 9.
- [OBSERVED] Previous double-click (`352-367`): if within 1.0 s of range start
  AND second click within 1500 ms (`DOP_DOUBLE_CLICK_WINDOW_MS`), steps back;
  else restarts range and resumes if paused. Single source of truth for the
  "previous" semantic. Task 9.
- [OBSERVED] End of playlist (`298-350`): stepping past the end pauses and
  shows a 3-choice modal: restart from 0 / stay paused / clear mode. `ended`
  event also calls `advancePlayback(1)`. Tasks 9, 10.
- [OBSERVED] Null-range local item: preserved in storage, UI shows
  `範囲未設定`, options disables edit/play, popup clicked-row start refuses,
  player `startPlayback` early-returns. Per plan this stays full-episode
  capable in v2 domain but unpublishable to Share. Tasks 6, 11.
- [DEFECT] `currentPlayback.item.range.type` is read in a log line
  (`content.js:250`) but modern ranges are name-only; value is `undefined`.
  Cosmetic only. Task 9 cleanup.
- [UNVERIFIED] Exact seek/enforce timing against the real player (tolerances,
  autoplay rejections, tail +1 s behavior) needs a logged-in session.

## 6. Enforcement, ranges, markers, native controls

- [OBSERVED] `enforceRanges (462-519)` on `timeupdate`: no-op when idle or
  inside range (+0.05 s tolerance, +1 s tail); before-start seeks to start;
  past-end/ended advances (playlist) or seeks near duration end (op-ed);
  min 200 ms gap between actions; `seekCooldownUntil` windows (5000 ms after
  start, 1000 ms on seeking, 800 ms on seeked, startup locks above).
  `trySwitchToOtherRange` jumps to another same-video playlist item instead
  of forcing back. Tasks 8, 9.
- [OBSERVED] Range naming is heuristic only (`common.js guessRangeName`):
  75-105 s near start = OP, near end = ED, <15 s at 0 = イントロ, else
  パートN; thresholds `DOP_GUESS_*` in section 9. d-Anime only marks
  `type === 'none'`. Shown in add-popup, work menus, markers. Task 6 keeps
  heuristic label; v2 never claims service-provided OP/ED.
- [OBSERVED] `updateSeekMarkers`: debounced 100 ms (`scheduleUpdateSeekMarkers`),
  rebuilds `#d-op-seek-markers` inside `.seekArea`, per-range left/width %,
  OP/ED/イントロ/CUSTOM coloring only when a mode is active, `active` class
  on the playing range, hover label via `#d-op-seek-popup-label`. Reads all
  playlists twice per run (`getSeekRanges`). Marker label prefers stored
  playlist range names over heuristics. Tasks 8-10.
- [DEFECT] No marker concurrency guard in this tree: overlapping async
  `runUpdateSeekMarkers` runs can interleave (no `running` flag, unlike
  popup `renderQueued/renderRunning`). Rapid chapter/mode changes may paint
  stale ranges. Task 10 delta (guard + generation token).
- [OBSERVED] Native controls: `setNativeSkip(false)` stores `op_skip` cookie
  and sends `BLOCK_AUTO_ADVANCE`; `setNativeSkip(true,false)` in op-ed mode
  only flips the cookie (does not block auto-advance, letting op-ed chain
  play); `resetNativeSkip` restores cookie + unblocks. Playlist mode hides
  native prev/next via `d-op-skip-hidden` body class and shows custom ⏮/⏭;
  op-ed mode leaves natives visible. `GO_NEXT` falls back to clicking
  `.buttonArea .next`. Tasks 8, 9. [UNVERIFIED] real cookie/auto-advance interplay.
- [OBSERVED] Current position display: top-right panel (`showTopRightPanel`)
  shows range label + playlist name + `pos/max`, auto-fades after 3000 ms,
  reappears on mousemove; `hideTopRightPanel` when idle. Task 10.
- [OBSERVED] Keyboard focus protection (`1533-1549`): `focusin/out` tracks
  input/textarea/select/contenteditable; capture-phase `keydown` stops
  propagation only while an editable is focused. Task 10. [UNVERIFIED] real
  player key handling.

## 7. Custom range flow

- [OBSERVED] `showCustomRangeBar (1233-1370)`: requires leaving active modes
  (confirm modal, else abort); bar has start/end text inputs (accept
  `m:ss`/seconds via `parseTimeInput`), get-from-video buttons, Test
  (enters `custom-test` mode, enforces + seeks + plays), Add (opens
  multi-add modal with name default `CUSTOM`), Cancel (restores skip cookie,
  clears state, removes bar). Preview state participates in markers and
  top-panel label. Tasks 9, 10. [UNVERIFIED] real-video capture values.

## 8. Navigation modes (must stay separate)

- Playlist mode: `dop_playback {playlistId, index}` + URL
  `dopPlaylistId/dopIndex`; `checkUrlParams` strips params then
  `startPlayback`; cross-episode via background tab update; resume path
  `resumePlaybackIfAny` honors stored shuffle order. Hides native prev/next.
- Work-page op-ed mode: `dop_oped_mode {active, updatedAt}` + URL
  `dopRangeIndex/dopTitle/dopEpisodeTitle`; `startWorkPageRange` validates
  index, clears playlist state, sets op-ed flag, `enterOpEdMode` plays the
  Nth `none` chapter. Leaves native prev/next visible.
- [OBSERVED] `resumePlaybackIfAny` and `handleChapters` op-ed resume both
  refuse to run when URL params are present; expired playback (>5 min) or
  missing playlist/index clears state. Task 9.

## 9. Timing and heuristic constants (`common.js:14-43`)

Resume/op-ed max age 5 min; seek cooldowns 5000/1000/800 ms; startup locks
800/8000 ms; enforce gap 200 ms; seek-ready poll 100 ms/deadline 3000 ms;
prev double-click 1500 ms; panel hide 3000 ms; add-popup hide 200 ms; seek
marker debounce 100 ms; store decorate debounce 300 ms; guess thresholds
180/15/300 s and 75-105 s OP/ED, <15 s intro; range tolerance 0.05 s.
All carried into tasks 6/8/9 with evidence; real-player tuning stays
[UNVERIFIED].

## 10. Work-page menus and chapter fetch

- [OBSERVED] `content-store.js`: decorates `.itemModule` rows once each with
  an `OP/ED` button; click fetches same-origin player HTML
  (`fetch(url, {credentials:'same-origin'})`), regex-parses `"chapters"` and
  `"duration"`, shows a positioned range menu (heuristic names + times),
  click opens player with `dopRangeIndex`; empty chapters shows
  `スキップ区間なし` row; fetch failure/empty falls back to `playEpisode(0)`.
  Button shows spinner state and restores text. `MutationObserver` +
  300 ms debounce redecorates. Errors use a custom modal (no alert),
  Escape/backdrop/OK dismiss. Tasks 8, 10.
- [DEFECT] Regex `"chapters"\s*:\s*(\[[^\]]*\])` cannot parse nested chapter
  objects reliably; an HTML shape change silently falls back to range 0.
  Task 8 delta (bounded parser + explicit failure). [UNVERIFIED] real HTML shape.

## 11. Player page UI lifecycle

- Add button `♪` (`602-686`): created once, anchored after `.buttonArea
  .time`, hover popup (200 ms hide), popup rebuilt only when `partId`
  changes or never built (`dataset.dopPopupPartId/dopPopupBuilt`).
  Multi-add modal (`openPlaylistModal`): multi-select playlists + new-name
  field + range-name field, Add disabled until a target exists,
  `Promise.all` fan-out to `addCurrentRangeToPlaylist`. `addButtonCreating`
  re-entry flag. Tasks 9, 10.
- Playlist ⏮/⏭ (`699-745`): inserted around native prev/next, hidden when
  idle, shown in playlist mode; next disabled state resolved async.
- Modals (`showModal`, `showConfirm`, `showCopyDialog`, import choices):
  custom DOM, Escape/backdrop cancel, primary focus. No `alert/confirm/prompt`
  anywhere. Task 10.
- `MutationObserver` (`1551-1565`): disconnect/re-observe around each batch,
  reattaches video listeners, rebuilds add/playlist controls. Video listeners
  (`attachVideoListener`) detach from replaced elements. Task 10.
- Popup render guard (`popup.js:73-81`): `renderQueued/renderRunning`
  coalesces storage-change rerenders. No equivalent in markers (see defect).
- Onboarding (`background.js:62-66`): `onInstalled install` opens options
  page only. Task 10/28.

## 12. Window reuse, bounds, recovery

- [OBSERVED] `handleRequestPlayer`: revalidates in-memory `playerState`
  (tab URL still a player URL + window alive), else adopts stored
  `dop_playback.windowId` tab if it is a player URL; else creates tab mode
  (`tabs.create`) or popup window 1280x800 with stored bounds, falling back
  to a tab on failure. Saves bounds after every reuse/create.
- `validatePlayerState`, `tabs.onRemoved`, `windows.onRemoved`,
  service-worker `recoverPlayerState`: clear `dop_playback/dop_pending`
  (+ window bounds where applicable) when the player tab/window is gone;
  restart reattaches to a surviving player tab. `RELEASE_PLAYER` path above.
  All mapped task 9. [UNVERIFIED] multi-window/restart behavior on real browsers.

## 13. Bug and delta ledger (must not be guaranteed as behavior)

1. Duplicate/colliding migration ids: `migrateItem` fans one legacy item into
   up to 3 clones sharing the original `id`; import merge path keeps ids
   verbatim. [DEFECT] v2 repairs deterministically (task 7), never dedups by partId.
2. Null ranges: `range:null` items persist and render `範囲未設定`; silent
   early-return in some starts. [OBSERVED] v2 keeps local null-range +
   full-episode semantics, blocks Share publish with item-specific guidance
   (tasks 6, 11, 15).
3. Unset `currentSessionId` (`content.js:26` never assigned): `clearPlaylistState`
   always takes the `dopClearPlayback()` branch, so one tab can clear another
   tab's playback. [DEFECT] v2 generation/owner tokens (task 9).
4. Marker concurrency: no guard (section 6). [DEFECT] task 10.
5. `episodeNumber` import loss: dropped by import cleaner. [DEFECT] task 11.
6. Unsafe broad export (full stored array, no version). [DELTA] task 11.
7. Destructive release replacement. [DELTA] task 25.
8. Regex chapter parse + first-range fallback. [DEFECT] task 8.

## 14. Disclosure and branding

- `PRIVACY.md:7-37`: local-only storage, no external send, no account/token
  access; contact `contact@sasnews.dev`/GitHub. `STORE_LISTING.md`: single
  purpose (OP/ED extract + playlist), permission justifications, no remote
  code, 2FA makes static test accounts impossible, fixture-driven review
  steps. Chrome listing id `mcjkaoagedekadnimbcbkhdkgpbnnodc` (README links);
  Firefox id `d-op@sasnews.dev`. Old-site revision
  `59399be1419f830cb7b0b54c509692d41e9b48e2` preserved per plan (not
  re-verified here). Maps to tasks 21, 28.

## 15. Coverage map to later tasks

Tasks 2 (workspace/manifests), 3 (schemas/fixtures incl. null-range,
duplicates, episodeNumber), 6 (domain/shuffle/navigation), 7 (single-writer
storage/migration), 8 (adapter/bridge/parser), 9 (orchestration/windows),
10 (UI parity), 11 (safe import/export), 21/25/28 (disclosure/packaging/cutover),
30 (final verifiers). Every handler/key/action above names its task; zero
entries rely on grep-only proof; real-player items are explicitly
[UNVERIFIED].
