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

  function formatRangeName(range) {
    return range.name || '範囲';
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

  let renderQueued = false;
  let renderRunning = false;

  async function render() {
    if (renderRunning) {
      renderQueued = true;
      return;
    }
    renderRunning = true;
    do {
      renderQueued = false;
      await doRender();
    } while (renderQueued);
    renderRunning = false;
  }

  async function doRender() {
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
    chrome.runtime.sendMessage({ type: 'REQUEST_PLAYER', url: url.toString() });
  }

  function renderPlaylistList(playlists) {
    playlistList.innerHTML = '';
    if (playlists.length === 0) {
      playlistList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">♪</div>
          <div>プレイリストがありません。</div>
          <button id="emptyCreateBtn">管理画面で作成</button>
        </div>
      `;
      const emptyCreateBtn = document.getElementById('emptyCreateBtn');
      if (emptyCreateBtn) {
        emptyCreateBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
      }
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

          const episodeNum = item.episodeNumber || extractEpisodeNumber(item.episodeTitle);

          const titleEl = document.createElement('div');
          titleEl.className = 'item-title';
          if (episodeNum) {
            titleEl.textContent = decodeHtmlEntities(episodeNum) + ' - ' + (decodeHtmlEntities(item.title) || '(タイトル不明)');
          } else {
            titleEl.textContent = decodeHtmlEntities(item.title) || '(タイトル不明)';
          }

          let episodeSub = null;
          if (!episodeNum && item.episodeTitle) {
            episodeSub = document.createElement('div');
            episodeSub.className = 'item-episode';
            episodeSub.textContent = decodeHtmlEntities(item.episodeTitle);
          }

          const metaEl = document.createElement('div');
          metaEl.className = 'item-meta';

          const rangeNameEl = document.createElement('span');
          rangeNameEl.className = 'item-range-name';
          rangeNameEl.textContent = item.range ? formatRangeName(item.range) : '範囲未設定';
          metaEl.appendChild(rangeNameEl);

          if (item.range) {
            const timeEl = document.createElement('span');
            timeEl.className = 'item-range-time';
            timeEl.textContent = `${formatSec(item.range.start)}-${formatSec(item.range.end)}`;
            metaEl.appendChild(timeEl);
          }

          row.appendChild(titleEl);
          if (episodeSub) row.appendChild(episodeSub);
          row.appendChild(metaEl);
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

      const episodeNum = item.episodeNumber || extractEpisodeNumber(item.episodeTitle);

      const title = document.createElement('div');
      title.className = 'item-title';
      if (episodeNum) {
        title.textContent = decodeHtmlEntities(episodeNum) + ' - ' + (decodeHtmlEntities(item.title) || '(タイトル不明)');
      } else {
        title.textContent = decodeHtmlEntities(item.title) || '(タイトル不明)';
      }

      let episodeSub = null;
      if (!episodeNum && item.episodeTitle) {
        episodeSub = document.createElement('div');
        episodeSub.className = 'item-episode';
        episodeSub.textContent = decodeHtmlEntities(item.episodeTitle);
      }

      const meta = document.createElement('div');
      meta.className = 'item-meta';

      const rangeNameEl = document.createElement('span');
      rangeNameEl.className = 'item-range-name';
      rangeNameEl.textContent = item.range ? formatRangeName(item.range) : '範囲未設定';
      meta.appendChild(rangeNameEl);

      if (item.range) {
        const timeEl = document.createElement('span');
        timeEl.className = 'item-range-time';
        timeEl.textContent = `${formatSec(item.range.start)}-${formatSec(item.range.end)}`;
        meta.appendChild(timeEl);
      }

      info.appendChild(title);
      if (episodeSub) info.appendChild(episodeSub);
      info.appendChild(meta);
      row.appendChild(thumb);
      row.appendChild(info);

      row.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'FORWARD_TO_PLAYER', command: 'PLAYLIST_JUMP', payload: { index: idx } });
        render();
      });

      playlistItems.appendChild(row);
    });
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  prevBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'FORWARD_TO_PLAYER', command: 'PLAYLIST_PREV' });
  });
  nextBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'FORWARD_TO_PLAYER', command: 'PLAYLIST_NEXT' });
  });
  stopBtn.addEventListener('click', async () => {
    chrome.runtime.sendMessage({ type: 'RELEASE_PLAYER' });
    await render();
  });
  openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.dop_playback) {
      render();
    }
  });

  render();
})();
