const DOP_STORAGE_KEY = 'dop_playlists';
const DOP_PLAYBACK_KEY = 'dop_playback';
const DOP_PENDING_KEY = 'dop_pending';

function dopGenerateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function dopGetPlaylists() {
  const result = await chrome.storage.local.get(DOP_STORAGE_KEY);
  return result[DOP_STORAGE_KEY] || [];
}

async function dopSavePlaylists(playlists) {
  await chrome.storage.local.set({ [DOP_STORAGE_KEY]: playlists });
}

async function dopGetPlayback() {
  const result = await chrome.storage.local.get(DOP_PLAYBACK_KEY);
  return result[DOP_PLAYBACK_KEY] || null;
}

async function dopSetPlayback(playback) {
  await chrome.storage.local.set({ [DOP_PLAYBACK_KEY]: playback });
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
