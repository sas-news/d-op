(function () {
  'use strict';

  const noPlayback = document.getElementById('noPlayback');
  const playback = document.getElementById('playback');
  const playlistNameEl = document.getElementById('playlistName');
  const trackInfoEl = document.getElementById('trackInfo');
  const trackDetailEl = document.getElementById('trackDetail');
  const trackProgressEl = document.getElementById('trackProgress');
  const nextInfoEl = document.getElementById('nextInfo');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const stopBtn = document.getElementById('stopBtn');
  const openOptions = document.getElementById('openOptions');
  const popupPlaylists = document.getElementById('popupPlaylists');
  const popupPlayMode = document.getElementById('popupPlayMode');

  function formatMode(mode) {
    if (mode === 'op') return 'OP';
    if (mode === 'ed') return 'ED';
    if (mode === 'both') return 'OP+ED';
    return mode;
  }

  function isSystemPlaylist(playlist) {
    return typeof playlist.name === 'string' && playlist.name.startsWith('__dop_');
  }

  async function render() {
    const playbackState = await dopGetPlayback();
    const playlists = (await dopGetPlaylists()).filter((p) => !isSystemPlaylist(p));

    if (!playbackState) {
      noPlayback.classList.remove('hidden');
      playback.classList.add('hidden');
      renderPlaylistList(playlists);
      return;
    }

    const playlist = playlists.find((p) => p.id === playbackState.playlistId);
    if (!playlist || playbackState.index >= playlist.items.length) {
      noPlayback.classList.remove('hidden');
      playback.classList.add('hidden');
      renderPlaylistList(playlists);
      return;
    }

    const item = playlist.items[playbackState.index];
    const nextItem = playlist.items[playbackState.index + 1] || null;

    noPlayback.classList.add('hidden');
    playback.classList.remove('hidden');

    playlistNameEl.textContent = `${playlist.name} [${formatMode(playbackState.mode)}]`;
    trackInfoEl.textContent = item.title || item.episodeTitle || '(タイトル不明)';
    trackDetailEl.textContent = item.episodeTitle || '';
    trackProgressEl.textContent = `${playbackState.index + 1} / ${playlist.items.length}`;

    if (nextItem) {
      nextInfoEl.textContent = `次: ${nextItem.title || nextItem.episodeTitle || '(タイトル不明)'} [${formatMode(playbackState.mode)}]`;
      nextInfoEl.classList.remove('hidden');
    } else {
      nextInfoEl.classList.add('hidden');
    }
  }

  async function sendToActiveTab(type) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type });
    }
  }

  function renderPlaylistList(playlists) {
    popupPlaylists.innerHTML = '';
    if (playlists.length === 0) {
      popupPlaylists.innerHTML = '<p>プレイリストがありません。</p>';
      return;
    }
    playlists.forEach((playlist) => {
      const row = document.createElement('div');
      row.className = 'playlist-row';

      const name = document.createElement('span');
      name.textContent = `${playlist.name} (${playlist.items.length})`;

      const playBtn = document.createElement('button');
      playBtn.textContent = '再生';
      playBtn.addEventListener('click', async () => {
        if (playlist.items.length === 0) return;
        await dopSetPlayback({ playlistId: playlist.id, index: 0, mode: popupPlayMode.value });
        chrome.tabs.create({ url: playlist.items[0].url, active: true });
        render();
      });

      row.appendChild(name);
      row.appendChild(playBtn);
      popupPlaylists.appendChild(row);
    });
  }

  prevBtn.addEventListener('click', () => sendToActiveTab('PLAYLIST_PREV'));
  nextBtn.addEventListener('click', () => sendToActiveTab('PLAYLIST_NEXT'));
  stopBtn.addEventListener('click', () => sendToActiveTab('PLAYLIST_STOP'));
  openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

  render();
})();
