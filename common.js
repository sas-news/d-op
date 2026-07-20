// =============================================================================
// d-OP shared constants
// =============================================================================
const DOP_STORAGE_KEY = 'dop_playlists';
const DOP_PLAYBACK_KEY = 'dop_playback';
const DOP_PENDING_KEY = 'dop_pending';
const DOP_OPED_MODE_KEY = 'dop_oped_mode';
const DOP_WINDOW_MODE_KEY = 'dop_window_mode';
const DOP_COLLAPSED_KEY = 'dop_collapsed_playlists';

// ---------------------------------------------------------------------------
// Timing constants — all in milliseconds unless noted
// ---------------------------------------------------------------------------
const DOP_RESUME_MAX_AGE_MS = 5 * 60 * 1000;    // playback state expires after 5 min
const DOP_OPED_MODE_MAX_AGE_MS = 5 * 60 * 1000; // OP/ED mode expires after 5 min
const DOP_SEEK_COOLDOWN_PLAYBACK_MS = 5000;     // seek cooldown after playlist start
const DOP_SEEK_COOLDOWN_SEEKING_MS = 1000;      // seek cooldown after user seeking
const DOP_SEEK_COOLDOWN_SEEKED_MS = 800;        // seek cooldown after seek completes
const DOP_STARTUP_LOCK_ITEM_MS = 800;           // startup lock after playItemInCurrentVideo
const DOP_STARTUP_LOCK_PLAYBACK_MS = 1500;      // startup lock after fresh playback start
const DOP_ENFORCE_MIN_GAP_MS = 200;             // minimum gap between enforce actions
const DOP_SEEK_READY_POLL_MS = 100;             // seekToStartWhenReady polling interval
const DOP_SEEK_READY_DEADLINE_MS = 3000;        // seekToStartWhenReady deadline
const DOP_DOUBLE_CLICK_WINDOW_MS = 1500;        // prev-button double-click window
const DOP_PANEL_HIDE_DELAY_MS = 3000;           // top-right panel auto-hide delay
const DOP_POPUP_HIDE_DELAY_MS = 200;            // add-button popup hide delay
const DOP_SEEK_MARKER_DEBOUNCE_MS = 100;        // seek marker update debounce
const DOP_STORE_DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Heuristic constants — for guessRangeName (OP/ED inference)
// ---------------------------------------------------------------------------
const DOP_GUESS_NEAR_START_SEC = 180;           // within 3 min of video start → "near start"
const DOP_GUESS_VERY_START_SEC = 15;            // within 15 sec → "very start"
const DOP_GUESS_NEAR_END_SEC = 300;             // within 5 min of video end → "near end"
const DOP_GUESS_OPED_DURATION_MIN = 75;         // OP/ED minimum duration in seconds
const DOP_GUESS_OPED_DURATION_MAX = 105;        // OP/ED maximum duration in seconds
const DOP_GUESS_INTRO_DURATION_MAX = 15;        // intro maximum duration in seconds

// ---------------------------------------------------------------------------
// Enforcer tolerance for floating point comparison
// ---------------------------------------------------------------------------
const DOP_RANGE_TOLERANCE_SEC = 0.05;

// =============================================================================
// Utility functions
// =============================================================================

/**
 * Convert milliseconds to seconds.
 */
function seconds(ms) {
  return ms / 1000;
}

/**
 * Format seconds as m:ss string.
 */
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Format milliseconds as m:ss string (used by popup/options).
 */
function formatSec(ms) {
  return formatTime(seconds(ms));
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, function (m) {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return m;
    }
  });
}

/**
 * Decode common HTML entities (textarea trick).
 */
function decodeHtmlEntities(str) {
  if (!str) return '';
  const doc = new DOMParser().parseFromString(str, 'text/html');
  return doc.body.textContent || '';
}

/**
 * Generate a unique ID. Uses crypto.randomUUID() when available.
 */
function dopGenerateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto (shouldn't happen in modern browsers)
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Shared debounce utility.
 */
function debounce(fn, wait) {
  let timer = null;
  return function () {
    const context = this;
    const args = arguments;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      fn.apply(context, args);
    }, wait);
  };
}

/**
 * Parse time string (m:ss or seconds) to milliseconds.
 */
function parseTimeInput(str) {
  if (!str) return null;
  const parts = String(str).trim().split(':');
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseInt(parts[1], 10);
    if (!isNaN(m) && !isNaN(s)) return (m * 60 + s) * 1000;
  }
  const sec = parseFloat(str);
  if (!isNaN(sec)) return Math.floor(sec * 1000);
  return null;
}

// =============================================================================
// OP/ED range name guessing (heuristic — d-Anime does not label chapters)
// =============================================================================

/**
 * Guess a human-readable name for a "none" chapter based on duration and position.
 * This is inherently heuristic because d-Anime's ws010105Data.chapters only has
 * type === 'none' for skippable sections — no 'op'/'ed' flag exists.
 *
 * Heuristics used:
 *   - ~75-105 sec + near start → OP
 *   - ~75-105 sec + near end   → ED
 *   - <15 sec + position 0     → イントロ (intro/recap)
 *   - otherwise                 → パートN
 */
function guessRangeName(chapter, index, total, durationSec) {
  const startSec = seconds(chapter.start);
  const endSec = seconds(chapter.end);
  const lenSec = endSec - startSec;

  const nearStart = startSec < DOP_GUESS_NEAR_START_SEC;
  const veryStart = startSec < DOP_GUESS_VERY_START_SEC;
  const nearEnd = durationSec - endSec < DOP_GUESS_NEAR_END_SEC;
  const opEdDuration = lenSec >= DOP_GUESS_OPED_DURATION_MIN && lenSec <= DOP_GUESS_OPED_DURATION_MAX;
  const introDuration = lenSec < DOP_GUESS_INTRO_DURATION_MAX;

  // Track used names to avoid duplicates (e.g. two near-start ranges)
  const used = new Set();
  function makeName(candidate) {
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    return `パート${index + 1}`;
  }

  if (total === 1) {
    if (opEdDuration && nearStart) return makeName('OP');
    if (introDuration && veryStart) return makeName('イントロ');
    return `パート1`;
  }

  if (total === 2) {
    if (index === 0) {
      if (opEdDuration && nearStart) return makeName('OP');
      if (introDuration && veryStart) return makeName('イントロ');
      return `パート1`;
    }
    if (opEdDuration && nearEnd) return makeName('ED');
    if (introDuration && veryStart) return makeName('イントロ');
    return `パート2`;
  }

  // total >= 3
  if (index === 0 && introDuration && veryStart) return makeName('イントロ');
  if (index === total - 1 && opEdDuration && nearEnd) return makeName('ED');
  if (index > 0 && index < total - 1 && opEdDuration && nearStart) return makeName('OP');
  return `パート${index + 1}`;
}

// =============================================================================
// Range name derivation (legacy + modern)
// =============================================================================

function deriveRangeName(range) {
  if (!range) return null;
  if (range.name) return range.name;
  if (range.type) {
    if (range.type === 'op') return 'OP';
    if (range.type === 'ed') return 'ED';
    if (range.type === 'custom') return 'CUSTOM';
    return range.type.toUpperCase();
  }
  return null;
}

// =============================================================================
// Data cleaning / migration (legacy opRange/edRange → range[])
// =============================================================================

function cleanItem(item) {
  const range = item.range
    ? {
        start: item.range.start,
        end: item.range.end,
        name: deriveRangeName(item.range) || undefined
      }
    : null;
  return {
    id: item.id,
    partId: item.partId,
    workId: item.workId,
    title: item.title,
    episodeTitle: item.episodeTitle,
    episodeNumber: item.episodeNumber || '',
    url: item.url,
    range
  };
}

function migrateItem(item) {
  if (item.range) return [cleanItem(item)];
  const result = [];
  if (item.opRange) {
    result.push(cleanItem({ ...item, range: { type: 'op', start: item.opRange.start, end: item.opRange.end } }));
  }
  if (item.edRange) {
    result.push(cleanItem({ ...item, range: { type: 'ed', start: item.edRange.start, end: item.edRange.end } }));
  }
  if (item.customRange) {
    result.push(cleanItem({ ...item, range: { type: 'custom', start: item.customRange.start, end: item.customRange.end } }));
  }
  if (result.length === 0) {
    result.push(cleanItem({ ...item, range: null }));
  }
  return result;
}

function migratePlaylist(playlist) {
  const items = (playlist.items || []).flatMap(migrateItem);
  return { ...playlist, items };
}

// =============================================================================
// Storage layer
// =============================================================================

async function dopGetPlaylists() {
  const result = await browser.storage.local.get(DOP_STORAGE_KEY);
  const playlists = (result[DOP_STORAGE_KEY] || []).map(migratePlaylist);
  return playlists;
}

async function dopSavePlaylists(playlists) {
  try {
    await browser.storage.local.set({ [DOP_STORAGE_KEY]: playlists });
  } catch (err) {
    if (err.message && err.message.includes('QUOTA')) {
      throw new Error('ストレージ容量が不足しています。不要なプレイリストを削除してください。');
    }
    throw err;
  }
}

async function dopGetPlayback() {
  const result = await browser.storage.local.get(DOP_PLAYBACK_KEY);
  return result[DOP_PLAYBACK_KEY] || null;
}

async function dopSetPlayback(playback) {
  if (!playback) {
    await browser.storage.local.remove(DOP_PLAYBACK_KEY);
    return;
  }
  playback.windowId = await dopGetWindowId();
  await browser.storage.local.set({ [DOP_PLAYBACK_KEY]: playback });
}

async function dopClearPlaybackForWindow(windowId) {
  const playback = await dopGetPlayback();
  if (playback && playback.windowId === windowId) {
    await dopClearPlayback();
    return true;
  }
  return false;
}

async function dopClearPlayback() {
  await browser.storage.local.remove(DOP_PLAYBACK_KEY);
}

async function dopGetPending() {
  const result = await browser.storage.local.get(DOP_PENDING_KEY);
  return result[DOP_PENDING_KEY] || null;
}

async function dopSetPending(pending) {
  await browser.storage.local.set({ [DOP_PENDING_KEY]: pending });
}

async function dopClearPending() {
  await browser.storage.local.remove(DOP_PENDING_KEY);
}

async function dopGetOpEdMode() {
  const result = await browser.storage.local.get(DOP_OPED_MODE_KEY);
  return result[DOP_OPED_MODE_KEY] || null;
}

async function dopSetOpEdMode(active) {
  if (active) {
    await browser.storage.local.set({ [DOP_OPED_MODE_KEY]: { active: true, updatedAt: Date.now() } });
  } else {
    await browser.storage.local.remove(DOP_OPED_MODE_KEY);
  }
}

async function dopGetWindowMode() {
  const result = await browser.storage.local.get(DOP_WINDOW_MODE_KEY);
  return result[DOP_WINDOW_MODE_KEY] || 'window';
}

async function dopSetWindowMode(mode) {
  await browser.storage.local.set({ [DOP_WINDOW_MODE_KEY]: mode });
}

async function dopGetCollapsedPlaylists() {
  const result = await browser.storage.local.get(DOP_COLLAPSED_KEY);
  return result[DOP_COLLAPSED_KEY] || {};
}

async function dopSetCollapsedPlaylist(playlistId, collapsed) {
  const state = await dopGetCollapsedPlaylists();
  state[playlistId] = collapsed;
  await browser.storage.local.set({ [DOP_COLLAPSED_KEY]: state });
}

/**
 * Get the current browser window ID. Stored as numeric ID in playback state.
 * Falls back to a session-scoped random ID when window API is unavailable
 * (e.g. in a service worker context).
 */
async function dopGetWindowId() {
  try {
    if (browser.windows && browser.windows.getCurrent) {
      const w = await browser.windows.getCurrent();
      if (w && typeof w.id === 'number') return w.id;
    }
  } catch (_) {
    // Window API unavailable (service worker, etc.)
  }
  // Fallback: negative random ID to distinguish from real window IDs
  return -(Date.now() % 0x7FFFFFFF);
}

// =============================================================================
// Playlist CRUD
// =============================================================================

async function dopCreatePlaylist(name) {
  const playlists = await dopGetPlaylists();
  const playlist = { id: dopGenerateId(), name, items: [] };
  playlists.push(playlist);
  await dopSavePlaylists(playlists);
  return playlist;
}

async function dopAddItemToPlaylist(playlistId, item) {
  const playlists = await dopGetPlaylists();
  const playlist = playlists.find((p) => p.id === playlistId);
  if (!playlist) return false;
  item.id = dopGenerateId();
  playlist.items.push(item);
  await dopSavePlaylists(playlists);
  return true;
}

async function dopDeletePlaylist(playlistId) {
  let playlists = await dopGetPlaylists();
  playlists = playlists.filter((p) => p.id !== playlistId);
  await dopSavePlaylists(playlists);
  const playback = await dopGetPlayback();
  if (playback && playback.playlistId === playlistId) {
    await dopClearPlayback();
  }
}

async function dopRenamePlaylist(playlistId, name) {
  const playlists = await dopGetPlaylists();
  const playlist = playlists.find((p) => p.id === playlistId);
  if (playlist) {
    playlist.name = name;
    await dopSavePlaylists(playlists);
  }
}

async function dopRemoveItem(playlistId, itemId) {
  const playlists = await dopGetPlaylists();
  const playlist = playlists.find((p) => p.id === playlistId);
  if (playlist) {
    playlist.items = playlist.items.filter((i) => i.id !== itemId);
    await dopSavePlaylists(playlists);
  }
}

async function dopClearItems(playlistId) {
  const playlists = await dopGetPlaylists();
  const playlist = playlists.find((p) => p.id === playlistId);
  if (playlist) {
    playlist.items = [];
    await dopSavePlaylists(playlists);
  }
}

async function dopMoveItem(playlistId, itemId, direction) {
  const playlists = await dopGetPlaylists();
  const playlist = playlists.find((p) => p.id === playlistId);
  if (!playlist) return;
  const idx = playlist.items.findIndex((i) => i.id === itemId);
  if (idx < 0) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= playlist.items.length) return;
  const item = playlist.items.splice(idx, 1)[0];
  playlist.items.splice(newIdx, 0, item);
  await dopSavePlaylists(playlists);
}

async function dopCopyItemToPlaylist(targetPlaylistId, item) {
  const playlists = await dopGetPlaylists();
  const playlist = playlists.find((p) => p.id === targetPlaylistId);
  if (!playlist) return false;
  const copy = {
    ...cleanItem(item),
    id: dopGenerateId()
  };
  playlist.items.push(copy);
  await dopSavePlaylists(playlists);
  return true;
}

// =============================================================================
// Shuffle helpers
// =============================================================================

function dopCreateShuffledIndices(n) {
  const indices = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

function dopCreateShuffledFromIndex(n, startIndex) {
  const prefix = Array.from({ length: startIndex + 1 }, (_, i) => i);
  const suffixLen = n - startIndex - 1;
  if (suffixLen <= 0) return { indices: prefix, newPosition: startIndex };
  const suffix = Array.from({ length: suffixLen }, (_, i) => startIndex + 1 + i);
  for (let i = suffix.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [suffix[i], suffix[j]] = [suffix[j], suffix[i]];
  }
  return { indices: [...prefix, ...suffix], newPosition: startIndex };
}

function dopReshuffleFromPosition(shuffledIndices, currentPos) {
  const prefix = shuffledIndices.slice(0, currentPos + 1);
  const suffix = shuffledIndices.slice(currentPos + 1);
  for (let i = suffix.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [suffix[i], suffix[j]] = [suffix[j], suffix[i]];
  }
  return [...prefix, ...suffix];
}

function dopResolvePlaybackIndex(playbackState) {
  if (!playbackState) return null;
  if (playbackState.shuffledIndices && playbackState.shuffledIndices.length > 0) {
    return playbackState.shuffledIndices[playbackState.index];
  }
  return playbackState.index;
}
