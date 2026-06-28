(function () {
  'use strict';

  const playbackSection = document.getElementById('playback');
  const playlistListSection = document.getElementById('playlistListSection');
  const playlistNameEl = document.getElementById('playlistName');
  const trackInfoEl = document.getElementById('trackInfo');
  const trackDetailEl = document.getElementById('trackDetail');
  const trackProgressEl = document.getElementById('trackProgress');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const stopBtn = document.getElementById('stopBtn');
  const openOptions = document.getElementById('openOptions');
  const playlistList = document.getElementById('playlistList');
  const playlistItems = document.getElementById('playlistItems');

  let expandedPlaylistId = null;

  function decodeHtmlEntities(str) {
    const txt = document.createElement('textarea');
    txt.innerHTML = str || '';
    return txt.value;
  }

  function formatRangeType(range) {
    if (range.name) return range.name;
    if (range.type === 'op') return 'OP';
    if (range.type === 'ed') return 'ED';
    if (range.type === 'custom') return 'CUSTOM';
    return range.type || '不明';
  }

  function formatSec(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function isSystemPlaylist(playlist) {
    return typeof playlist.name === 'string' && playlist.name.startsWith('__dop_');
  }

  async function render() {
    const playbackState = await dopGetPlayback();
    const playlists = (await dopGetPlaylists()).filter((p) => !isSystemPlaylist(p));

    if (!playbackState) {
      playbackSection.classList.add('hidden');
      playlistListSection.classList.remove('hidden');
      renderPlaylistList(playlists);
      return;
    }

    const playlist = playlists.find((p) => p.id === playbackState.playlistId);
    if (!playlist || playbackState.index >= playlist.items.length) {
      playbackSection.classList.add('hidden');
      playlistListSection.classList.remove('hidden');
      renderPlaylistList(playlists);
      return;
    }

    const item = playlist.items[playbackState.index];

    playbackSection.classList.remove('hidden');
    playlistListSection.classList.add('hidden');

    playlistNameEl.textContent = playlist.name;
    trackInfoEl.textContent = decodeHtmlEntities(item.title || item.episodeTitle) || '(タイトル不明)';
    trackDetailEl.textContent = decodeHtmlEntities(item.episodeTitle) || '';
    trackProgressEl.textContent = `${playbackState.index + 1} / ${playlist.items.length}`;

    prevBtn.disabled = playbackState.index <= 0;
    nextBtn.disabled = playbackState.index >= playlist.items.length - 1;

    renderPlaylistItems(playlist, playbackState.index);
  }

  async function startPlaylistItem(playlist, index) {
    const item = playlist.items[index];
    if (!item || !item.range) return;
    await dopSetPlayback({ playlistId: playlist.id, index, updatedAt: Date.now() });
    await dopClearPending();
    const url = new URL(item.url);
    url.searchParams.set('dopPlaylistId', playlist.id);
    url.searchParams.set('dopIndex', String(index));
    await chrome.tabs.create({ url: url.toString(), active: true });
  }

  function renderPlaylistList(playlists) {
    playlistList.innerHTML = '';
    if (playlists.length === 0) {
      playlistList.innerHTML = '<p class="empty">プレイリストがありません。</p>';
      return;
    }

    playlists.forEach((playlist) => {
      const card = document.createElement('div');
      card.className = 'playlist-card' + (expandedPlaylistId === playlist.id ? ' expanded' : '');

      const header = document.createElement('div');
      header.className = 'playlist-card-header';

      const title = document.createElement('span');
      title.textContent = escapeHtml(playlist.name);
      title.className = 'playlist-card-title';
      title.addEventListener('click', () => {
        expandedPlaylistId = expandedPlaylistId === playlist.id ? null : playlist.id;
        renderPlaylistList(playlists);
      });

      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${playlist.items.length}曲`;

      const playBtn = document.createElement('button');
      playBtn.className = 'playlist-card-play';
      playBtn.textContent = '▶';
      playBtn.title = '先頭から再生';
      playBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (playlist.items.length === 0) return;
        await startPlaylistItem(playlist, 0);
      });

      header.appendChild(title);
      header.appendChild(count);
      header.appendChild(playBtn);
      card.appendChild(header);

      if (expandedPlaylistId === playlist.id) {
        const items = document.createElement('div');
        items.className = 'playlist-card-items';
        playlist.items.forEach((item, idx) => {
          const row = document.createElement('div');
          row.className = 'playlist-card-item';
          row.innerHTML = `
            <span class="item-title">${escapeHtml(decodeHtmlEntities(item.title || item.episodeTitle) || '(タイトル不明)')}</span>
            <span class="item-meta">${item.range ? formatRangeType(item.range) + ' ' + formatSec(item.range.start) + '-' + formatSec(item.range.end) : '範囲未設定'}</span>
          `;
          row.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!item.range) return;
            await startPlaylistItem(playlist, idx);
            render();
          });
          items.appendChild(row);
        });
        card.appendChild(items);
      }

      playlistList.appendChild(card);
    });
  }

  function renderPlaylistItems(playlist, currentIndex) {
    playlistItems.innerHTML = '';
    playlist.items.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'playlist-item' + (idx === currentIndex ? ' current' : '');

      const thumb = document.createElement('div');
      thumb.className = 'item-thumb';
      thumb.textContent = idx + 1;

      const info = document.createElement('div');
      info.className = 'item-info';

      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = decodeHtmlEntities(item.title || item.episodeTitle) || '(タイトル不明)';

      const meta = document.createElement('div');
      meta.className = 'item-meta';
      meta.textContent = item.range
        ? `${formatRangeType(item.range)} ${formatSec(item.range.start)}-${formatSec(item.range.end)}`
        : '範囲未設定';

      info.appendChild(title);
      info.appendChild(meta);
      row.appendChild(thumb);
      row.appendChild(info);

      row.addEventListener('click', () => {
        sendToActiveTab('PLAYLIST_JUMP', { index: idx });
        render();
      });

      playlistItems.appendChild(row);
    });
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  async function sendToActiveTab(type, payload) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type, payload });
    }
  }

  prevBtn.addEventListener('click', () => sendToActiveTab('PLAYLIST_PREV'));
  nextBtn.addEventListener('click', () => sendToActiveTab('PLAYLIST_NEXT'));
  stopBtn.addEventListener('click', async () => {
    await sendToActiveTab('PLAYLIST_STOP');
    await dopClearPlayback();
    await dopClearPending();
    render();
  });
  openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

  render();
})();
