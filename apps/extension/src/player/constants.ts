// Player orchestration timing constants — ported from legacy common.js:14-43
// (baseline fc9d7fd60a057c5054aadb49e7e1297320f313e4) and the content.js
// enforcement/readiness code that consumed them. Values are identical to the
// legacy constants; docs/current-extension-behavior.md section 9 is the
// task-1 inventory mapping. All durations are integer milliseconds.

/** dop_playback resume expiry — legacy DOP_RESUME_MAX_AGE_MS (common.js:14). */
export const RESUME_MAX_AGE_MS = 5 * 60 * 1000
/** dop_oped_mode resume expiry — legacy DOP_OPED_MODE_MAX_AGE_MS (common.js:15). */
export const OPED_MODE_MAX_AGE_MS = 5 * 60 * 1000
/** Seek cooldown right after a playlist start — DOP_SEEK_COOLDOWN_PLAYBACK_MS (common.js:16). */
export const SEEK_COOLDOWN_PLAYBACK_MS = 5000
/** Seek cooldown while the user is scrubbing — DOP_SEEK_COOLDOWN_SEEKING_MS (common.js:17). */
export const SEEK_COOLDOWN_SEEKING_MS = 1000
/** Seek cooldown after a seek completed — DOP_SEEK_COOLDOWN_SEEKED_MS (common.js:18). */
export const SEEK_COOLDOWN_SEEKED_MS = 800
/** Startup lock for same-episode item switch — DOP_STARTUP_LOCK_ITEM_MS (common.js:19). */
export const STARTUP_LOCK_ITEM_MS = 800
/** Startup lock after a fresh cross-episode navigation — DOP_STARTUP_LOCK_PLAYBACK_MS (common.js:20). */
export const STARTUP_LOCK_PLAYBACK_MS = 8000
/** Minimum gap between two enforce actions — DOP_ENFORCE_MIN_GAP_MS (common.js:21). */
export const ENFORCE_MIN_GAP_MS = 200
/** seekToStartWhenReady metadata/seeked deadline — DOP_SEEK_READY_DEADLINE_MS (common.js:23). */
export const SEEK_READY_DEADLINE_MS = 3000
/** seekToStartWhenReady seek attempts — legacy `retries < 3` (content.js:196). */
export const SEEK_READY_MAX_ATTEMPTS = 3
/** seeked acceptance window |currentTime - target| — legacy `< 0.5` s (content.js:192). */
export const SEEK_ACCEPT_TOLERANCE_MS = 500
/** Prev-button double-click window — DOP_DOUBLE_CLICK_WINDOW_MS (common.js:24). */
export const DOUBLE_CLICK_WINDOW_MS = 1500
/** Prev counts as "near start" within 1 s of range start — legacy `< 1.0` s (content.js:357). */
export const PREV_RESTART_THRESHOLD_MS = 1000
/** Top-right panel auto-fade — DOP_PANEL_HIDE_DELAY_MS (common.js:25). */
export const PANEL_HIDE_DELAY_MS = 3000
/** Seek-marker rebuild debounce — DOP_SEEK_MARKER_DEBOUNCE_MS (common.js:27). */
export const SEEK_MARKER_DEBOUNCE_MS = 100
/** DOM reattach debounce for the player MutationObserver (v2 guard; legacy
 *  disconnected/re-observed per batch, content.js:1551-1565). */
export const DOM_MUTATION_DEBOUNCE_MS = 100
/** Range membership tolerance — DOP_RANGE_TOLERANCE_SEC 0.05 s (common.js:43). */
export const RANGE_TOLERANCE_MS = 50
/** End-of-range tail so the last second still counts as inside — legacy `end + 1` s
 *  (content.js:455 insideRange, content.js:471 lastEnd). */
export const RANGE_TAIL_MS = 1000
/** Op-ed past-end seeks near duration end — legacy `duration - 0.5` s (content.js:504). */
export const OPED_SEEK_END_OFFSET_MS = 500
/** Op-ed does not seek when within 1 s of the end — legacy `t < duration - 1` (content.js:503). */
export const OPED_END_MARGIN_MS = 1000

/** Cookie forced off during playlist/custom playback — legacy `op_skip` (content.js:122-138). */
export const NATIVE_SKIP_COOKIE = "op_skip"
/** sessionStorage flag gating op-ed resume — legacy `dop_oped_active` (content.js:419). */
export const OPED_SESSION_FLAG = "dop_oped_active"

/** dop* URL params consumed and stripped by the player page (content.js:369-384). */
export const PLAYER_URL_PARAM_KEYS = [
  "dopRangeIndex",
  "dopTitle",
  "dopEpisodeTitle",
  "dopPlaylistId",
  "dopIndex",
] as const
