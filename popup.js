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
  const shuffleBadge = document.getElementById('shuffleBadge');
  const openOptions = document.getElementById('openOptions');
  const playlistList = document.getElementById('playlistList');
  const playlistItems = document.getElementById('playlistItems');

  let expandedPlaylistId = null;

  function createShuffleIconSvg() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'currentColor');
    svg.style.display = 'block';
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M14.83 13.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13zM4 5.41l5.18 5.18 1.42-1.41L5.41 4 4 5.41zM20 4h-5.5l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4z');
    svg.appendChild(path);
    return svg;
  }

  function formatRangeName(range) {
    return range.name || '範囲';
  }

  function isSystemPlaylist(playlist) {
    return typeof playlist.name === 'string' && playlist.name.startsWith('__dop_');
  }

  async function startShufflePlayback(playlist) {
    if (playlist.items.length === 0) return;
    const indices = dopCreateShuffledIndices(playlist.items.length);
    const realIndex = indices[0];
    const item = playlist.items[realIndex];
    if (!item || !item.range) return;
    await dopSetPlayback({ playlistId: playlist.id, index: 0, shuffledIndices: indices, updatedAt: Date.now() });
    await dopClearPending();
    const url = new URL(item.url);
    url.searchParams.set('dopPlaylistId', playlist.id);
    url.searchParams.set('dopIndex', String(realIndex));
    browser.runtime.sendMessage({ type: 'REQUEST_PLAYER', url: url.toString() });
  }

  async function startShuffleFromHere(playlist, currentRealIndex, currentShuffledIndices, currentShufflePos) {
    let indices;
    if (currentShuffledIndices) {
      indices = dopReshuffleFromPosition(currentShuffledIndices, currentShufflePos);
    } else {
      indices = dopCreateShuffledFromIndex(playlist.items.length, currentRealIndex).indices;
    }
    const item = playlist.items[currentRealIndex];
    if (!item || !item.range) return;
    await dopSetPlayback({ playlistId: playlist.id, index: currentShufflePos, shuffledIndices: indices, updatedAt: Date.now() });
    await dopClearPending();
    const url = new URL(item.url);
    url.searchParams.set('dopPlaylistId', playlist.id);
    url.searchParams.set('dopIndex', String(currentRealIndex));
    browser.runtime.sendMessage({ type: 'REQUEST_PLAYER', url: url.toString() });
  }

  let renderQueued = false;
  let renderRunning = false;

  async function render() {
    if (renderRunning) { renderQueued = true; return; }
    renderRunning = true;
    do { renderQueued = false; await doRender(); } while (renderQueued);
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
    const maxCount = playbackState.shuffledIndices
      ? playbackState.shuffledIndices.length
      : playlist ? playlist.items.length : 0;
    if (!playlist || playbackState.index >= maxCount) {
      playbackSection.classList.add('hidden');
      playlistListSection.classList.remove('hidden');
      renderPlaylistList(playlists);
      return;
    }

    const item = playlist.items[playbackState.index];
    const shuffledIndices = playbackState.shuffledIndices || null;
    const realIndex = shuffledIndices ? shuffledIndices[playbackState.index] : playbackState.index;
    const realItem = playlist.items[realIndex];
    if (!realItem) {
      playbackSection.classList.add('hidden');
      playlistListSection.classList.remove('hidden');
      renderPlaylistList(playlists);
      return;
    }

    playbackSection.classList.remove('hidden');
    playlistListSection.classList.add('hidden');

    playlistNameEl.textContent = playlist.name;
    shuffleBadge.classList.toggle('hidden', !shuffledIndices);
    trackInfoEl.textContent = decodeHtmlEntities(realItem.title || realItem.episodeTitle) || '(タイトル不明)';
    trackDetailEl.textContent = decodeHtmlEntities(realItem.episodeTitle) || '';
    const orderLength = shuffledIndices ? shuffledIndices.length : playlist.items.length;
    trackProgressEl.textContent = `${playbackState.index + 1} / ${orderLength}`;

    prevBtn.disabled = playbackState.index <= 0;
    nextBtn.disabled = playbackState.index >= orderLength - 1;

    renderPlaylistItems(playlist, playbackState.index, shuffledIndices);
  }

  async function startPlaylistItem(playlist, index) {
    const item = playlist.items[index];
    if (!item || !item.range) return;
    await dopSetPlayback({ playlistId: playlist.id, index, updatedAt: Date.now() });
    await dopClearPending();
    const url = new URL(item.url);
    url.searchParams.set('dopPlaylistId', playlist.id);
    url.searchParams.set('dopIndex', String(index));
    browser.runtime.sendMessage({ type: 'REQUEST_PLAYER', url: url.toString() });
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
        emptyCreateBtn.addEventListener('click', () => browser.runtime.openOptionsPage());
      }
      return;
    }

    playlists.forEach((playlist) => {
      const card = document.createElement('div');
      card.className = 'playlist-card' + (expandedPlaylistId === playlist.id ? ' expanded' : '');

      const header = document.createElement('div');
      header.className = 'playlist-card-header';
      header.addEventListener('click', () => {
        expandedPlaylistId = expandedPlaylistId === playlist.id ? null : playlist.id;
        renderPlaylistList(playlists);
      });

      const title = document.createElement('span');
      title.textContent = escapeHtml(playlist.name);
      title.className = 'playlist-card-title';

      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${playlist.items.length}曲`;

      const isEmpty = playlist.items.length === 0;

      const playBtn = document.createElement('button');
      playBtn.className = 'playlist-card-play';
      playBtn.textContent = '▶';
      playBtn.title = isEmpty ? 'プレイリストが空です' : '先頭から再生';
      playBtn.disabled = isEmpty;
      playBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isEmpty) return;
        await startPlaylistItem(playlist, 0);
      });

      const shuffleBtn = document.createElement('button');
      shuffleBtn.className = 'playlist-card-shuffle';
      shuffleBtn.replaceChildren(createShuffleIconSvg());
      shuffleBtn.title = isEmpty ? 'プレイリストが空です' : 'シャッフル再生';
      shuffleBtn.disabled = isEmpty;
      shuffleBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isEmpty) return;
        await startShufflePlayback(playlist);
      });

      header.appendChild(title);
      header.appendChild(count);
      header.appendChild(playBtn);
      header.appendChild(shuffleBtn);
      card.appendChild(header);

      if (expandedPlaylistId === playlist.id) {
        const items = document.createElement('div');
        items.className = 'playlist-card-items';
        if (playlist.items.length === 0) {
          const emptyMsg = document.createElement('div');
          emptyMsg.className = 'playlist-card-empty';
          emptyMsg.textContent = 'プレイリストが空です。';
          items.appendChild(emptyMsg);
        } else {
          playlist.items.forEach((item, idx) => {
          const row = document.createElement('div');
          row.className = 'playlist-card-item';

          const epNum = item.episodeNumber ? decodeHtmlEntities(item.episodeNumber) : '';
          const epTitle = item.episodeTitle ? decodeHtmlEntities(item.episodeTitle) : '';
          const workTitle = decodeHtmlEntities(item.title) || '';

          const titleEl = document.createElement('div');
          titleEl.className = 'item-episode';
          titleEl.textContent = [epNum, epTitle].filter(Boolean).join(' ') || workTitle || '(タイトル不明)';

          const episodeSub = document.createElement('div');
          episodeSub.className = 'item-work';
          episodeSub.textContent = workTitle;

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
          row.appendChild(episodeSub);
          row.appendChild(metaEl);
          row.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!item.range) return;
            await startPlaylistItem(playlist, idx);
            render();
          });
          items.appendChild(row);
        });
        }
        card.appendChild(items);
      }

      playlistList.appendChild(card);
    });
  }

  function renderPlaylistItems(playlist, currentShufflePos, shuffledIndices) {
    playlistItems.innerHTML = '';
    const isShuffleActive = Boolean(shuffledIndices);

    const order = shuffledIndices || Array.from({ length: playlist.items.length }, (_, i) => i);
    order.forEach((realIdx, displayPos) => {
      const item = playlist.items[realIdx];
      const row = document.createElement('div');
      row.className = 'playlist-item' + (displayPos === currentShufflePos ? ' current' : '');

      const thumb = document.createElement('div');
      thumb.className = 'item-thumb';
      thumb.textContent = displayPos + 1;

      const info = document.createElement('div');
      info.className = 'item-info';

      const epNum = item.episodeNumber ? decodeHtmlEntities(item.episodeNumber) : '';
      const epTitle = item.episodeTitle ? decodeHtmlEntities(item.episodeTitle) : '';
      const workTitle = decodeHtmlEntities(item.title) || '';

      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = [epNum, epTitle].filter(Boolean).join(' ') || workTitle || '(タイトル不明)';

      const episodeSub = document.createElement('div');
      episodeSub.className = 'item-episode';
      episodeSub.textContent = workTitle;

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
      info.appendChild(episodeSub);
      info.appendChild(meta);
      row.appendChild(thumb);
      row.appendChild(info);

      row.addEventListener('click', () => {
        browser.runtime.sendMessage({ type: 'FORWARD_TO_PLAYER', command: 'PLAYLIST_JUMP', payload: { index: displayPos } });
        render();
      });

      playlistItems.appendChild(row);
    });

    const shuffleActions = document.getElementById('shuffleActions');
    if (shuffleActions) {
      shuffleActions.classList.remove('hidden');

      const realCurrentIndex = shuffledIndices
        ? shuffledIndices[currentShufflePos]
        : currentShufflePos;

      const fullBtn = document.getElementById('shuffleFullBtn');
      if (fullBtn) {
        fullBtn.onclick = async () => {
          await startShufflePlayback(playlist);
          render();
        };
      }

      const hereBtn = document.getElementById('shuffleHereBtn');
      if (hereBtn) {
        hereBtn.onclick = async () => {
          await startShuffleFromHere(playlist, realCurrentIndex, shuffledIndices, currentShufflePos);
          render();
        };
      }
    }
  }

  prevBtn.addEventListener('click', () => {
    browser.runtime.sendMessage({ type: 'FORWARD_TO_PLAYER', command: 'PLAYLIST_PREV' });
  });
  nextBtn.addEventListener('click', () => {
    browser.runtime.sendMessage({ type: 'FORWARD_TO_PLAYER', command: 'PLAYLIST_NEXT' });
  });
  stopBtn.addEventListener('click', async () => {
    browser.runtime.sendMessage({ type: 'RELEASE_PLAYER' });
    await render();
  });
  openOptions.addEventListener('click', () => browser.runtime.openOptionsPage());

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.dop_playback) {
      render();
    }
  });

  document.getElementById('popupVersion').textContent = 'd-OP v' + browser.runtime.getManifest().version;

  render();
})();
