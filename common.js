const DOP_STORAGE_KEY = 'dop_playlists';
const DOP_PLAYBACK_KEY = 'dop_playback';
const DOP_PENDING_KEY = 'dop_pending';
const DOP_OPED_MODE_KEY = 'dop_oped_mode';
const DOP_WINDOW_MODE_KEY = 'dop_window_mode';

function dopGenerateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

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

async function dopGetPlaylists() {
  const result = await chrome.storage.local.get(DOP_STORAGE_KEY);
  const playlists = (result[DOP_STORAGE_KEY] || []).map(migratePlaylist);
  return playlists;
}

async function dopSavePlaylists(playlists) {
  try {
    await chrome.storage.local.set({ [DOP_STORAGE_KEY]: playlists });
  } catch (err) {
    if (err.message && err.message.includes('QUOTA')) {
      throw new Error('ストレージ容量が不足しています。不要なプレイリストを削除してください。');
    }
    throw err;
  }
}

async function dopGetPlayback() {
  const result = await chrome.storage.local.get(DOP_PLAYBACK_KEY);
  return result[DOP_PLAYBACK_KEY] || null;
}

async function dopSetPlayback(playback) {
  if (!playback) {
    await chrome.storage.local.remove(DOP_PLAYBACK_KEY);
    return;
  }
  playback.windowId = await dopGetWindowId();
  await chrome.storage.local.set({ [DOP_PLAYBACK_KEY]: playback });
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
  await chrome.storage.local.remove(DOP_PLAYBACK_KEY);
}

async function dopGetPending() {
  const result = await chrome.storage.local.get(DOP_PENDING_KEY);
  return result[DOP_PENDING_KEY] || null;
}

async function dopSetPending(pending) {
  await chrome.storage.local.set({ [DOP_PENDING_KEY]: pending });
}

async function dopClearPending() {
  await chrome.storage.local.remove(DOP_PENDING_KEY);
}

async function dopGetOpEdMode() {
  const result = await chrome.storage.local.get(DOP_OPED_MODE_KEY);
  return result[DOP_OPED_MODE_KEY] || null;
}

async function dopSetOpEdMode(active) {
  if (active) {
    await chrome.storage.local.set({ [DOP_OPED_MODE_KEY]: { active: true, updatedAt: Date.now() } });
  } else {
    await chrome.storage.local.remove(DOP_OPED_MODE_KEY);
  }
}

async function dopGetWindowMode() {
  const result = await chrome.storage.local.get(DOP_WINDOW_MODE_KEY);
  return result[DOP_WINDOW_MODE_KEY] || 'window';
}

async function dopSetWindowMode(mode) {
  await chrome.storage.local.set({ [DOP_WINDOW_MODE_KEY]: mode });
}

async function dopGetWindowId() {
  try {
    if (chrome.windows && chrome.windows.getCurrent) {
      const w = await chrome.windows.getCurrent();
      if (w && w.id) return 'w' + w.id;
    }
  } catch (_) {}
  return 's' + dopGenerateId();
}

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
