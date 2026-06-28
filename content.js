(function () {
  'use strict';

  const APP_TAG = 'd-op-injected';
  const DEBUG = false;

  let chaptersInfo = null;
  let targetRanges = [];
  let currentMode = 'none';
  let originalOpSkip = null;
  let lastActionTime = 0;
  let attachedVideo = null;
  let enforcerTimer = null;
  let currentPlayback = null;
  let customStart = null;
  let customEnd = null;

  function getVideo() {
    return document.getElementById('video');
  }

  function getCookieValue(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookieValue(name, value) {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; SameSite=Lax`;
  }

  function seconds(ms) {
    return ms / 1000;
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function getNoneChapters() {
    if (!chaptersInfo || !chaptersInfo.chapters) return [];
    return chaptersInfo.chapters.filter((c) => c.type === 'none');
  }

  function getOpRange() {
    const none = getNoneChapters();
    return none.length > 0 ? none[0] : null;
  }

  function getEdRange() {
    const none = getNoneChapters();
    return none.length > 1 ? none[none.length - 1] : null;
  }

  function buildRanges() {
    if (currentPlayback && currentPlayback.item) {
      const item = currentPlayback.item;
      const ranges = [];
      if (currentPlayback.mode === 'op' && item.opRange) ranges.push(item.opRange);
      if (currentPlayback.mode === 'ed' && item.edRange) ranges.push(item.edRange);
      if (currentPlayback.mode === 'custom' && item.customRange) ranges.push(item.customRange);
      if (currentPlayback.mode === 'both') {
        if (item.opRange) ranges.push(item.opRange);
        if (item.edRange) ranges.push(item.edRange);
      }
      return ranges.map((r) => ({ start: r.start, end: r.end }));
    }
    const none = getNoneChapters();
    if (currentMode === 'op-only') return none.length > 0 ? [none[0]] : [];
    if (currentMode === 'ed-only') return none.length > 0 ? [none[none.length - 1]] : [];
    if (currentMode === 'op-ed') return none.slice();
    if (currentMode === 'custom-test') return targetRanges.slice();
    return [];
  }

  function sendCommand(type, payload) {
    window.postMessage({ source: APP_TAG, direction: 'to-page', type, payload }, window.location.origin);
  }

  function seek(timeSec) {
    sendCommand('SEEK', { time: timeSec });
  }

  function play() {
    sendCommand('PLAY', {});
  }

  function pause() {
    sendCommand('PAUSE', {});
  }

  function setNativeSkip(enabled) {
    if (originalOpSkip === null) {
      originalOpSkip = getCookieValue('op_skip') || '1';
    }
    setCookieValue('op_skip', enabled ? originalOpSkip : '0');
  }

  function resetNativeSkip() {
    if (originalOpSkip !== null) {
      setCookieValue('op_skip', originalOpSkip);
      originalOpSkip = null;
    }
  }

  function startEnforcer() {
    if (enforcerTimer) return;
    enforcerTimer = setInterval(() => enforceRanges(false), 100);
  }

  function stopEnforcer() {
    if (enforcerTimer) {
      clearInterval(enforcerTimer);
      enforcerTimer = null;
    }
  }

  function activateMode(mode) {
    currentMode = mode;
    targetRanges = buildRanges();
    log('activateMode', { mode, ranges: targetRanges.map((r) => [seconds(r.start), seconds(r.end)]) });

    if (mode === 'none' || targetRanges.length === 0) {
      stopEnforcer();
      resetNativeSkip();
      currentMode = 'none';
      return;
    }

    setNativeSkip(false);
    startEnforcer();
    const start = seconds(targetRanges[0].start);
    seek(start);
    play();
  }

  function startPlayback(playlist, index, mode) {
    const item = playlist.items[index];
    if (!item) return;
    currentPlayback = { playlistId: playlist.id, index, mode, item };
    dopSetPlayback(currentPlayback);
    targetRanges = buildRanges();
    log('startPlayback', { playlist: playlist.name, index, mode });

    if (targetRanges.length === 0) {
      currentPlayback = null;
      dopClearPlayback();
      return;
    }

    setNativeSkip(false);
    startEnforcer();
    const start = seconds(targetRanges[0].start);
    seek(start);
    play();
  }

  async function advancePlayback(direction) {
    if (!currentPlayback) return false;
    const playlists = await dopGetPlaylists();
    const playlist = playlists.find((p) => p.id === currentPlayback.playlistId);
    if (!playlist) {
      currentPlayback = null;
      dopClearPlayback();
      return false;
    }
    const newIndex = currentPlayback.index + direction;
    if (newIndex < 0 || newIndex >= playlist.items.length) {
      pause();
      return false;
    }
    const item = playlist.items[newIndex];
    const currentPartId = new URLSearchParams(location.search).get('partId');
    if (currentPartId === item.partId) {
      startPlayback(playlist, newIndex, currentPlayback.mode);
    } else {
      await dopSetPlayback({ ...currentPlayback, index: newIndex });
      location.href = item.url;
    }
    return true;
  }

  function log(label, data) {
    if (!DEBUG) return;
    console.log('[d-op]', label, data);
  }

  function insideRange(t) {
    for (const r of targetRanges) {
      if (t >= seconds(r.start) - 0.05 && t <= seconds(r.end) + 0.05) {
        return true;
      }
    }
    return false;
  }

  function enforceRanges(fromEvent) {
    if ((currentMode === 'none' && !currentPlayback) || targetRanges.length === 0) return;

    const video = getVideo();
    if (!video) return;

    const t = video.currentTime;
    const firstStart = seconds(targetRanges[0].start);
    const lastEnd = seconds(targetRanges[targetRanges.length - 1].end);

    if (insideRange(t)) {
      return;
    }

    const now = Date.now();
    if (now - lastActionTime < 200) return;
    lastActionTime = now;

    log('out of range', { t, firstStart, lastEnd });

    if (t < firstStart) {
      seek(firstStart);
      return;
    }

    if (t > lastEnd) {
      if (currentPlayback) {
        advancePlayback(1);
      } else {
        pause();
      }
      return;
    }

    for (const r of targetRanges) {
      if (t < seconds(r.start)) {
        seek(seconds(r.start));
        return;
      }
    }
  }

  function onTimeUpdate() {
    enforceRanges(true);
  }

  function attachVideoListener() {
    const video = getVideo();
    if (!video) return;
    if (attachedVideo === video) return;
    if (attachedVideo) {
      attachedVideo.removeEventListener('timeupdate', onTimeUpdate);
    }
    attachedVideo = video;
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('durationchange', updateSeekMarkers);
    video.addEventListener('loadedmetadata', updateSeekMarkers);
  }

  function createAddButton() {
    let wrapper = document.getElementById('d-op-add-wrapper');
    if (wrapper) return wrapper;

    wrapper = document.createElement('div');
    wrapper.id = 'd-op-add-wrapper';
    wrapper.className = 'mainButton d-op-add-wrapper';

    const btn = document.createElement('button');
    btn.className = 'd-op-add-button';
    btn.textContent = '＋';
    btn.title = 'プレイリストに追加';
    btn.setAttribute('aria-label', 'プレイリストに追加');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showAddMenuModal();
    });

    wrapper.appendChild(btn);

    const timeEl = document.querySelector('.buttonArea .time');
    if (timeEl && timeEl.parentNode) {
      const next = timeEl.nextElementSibling;
      if (next) {
        timeEl.parentNode.insertBefore(wrapper, next);
      } else {
        timeEl.parentNode.appendChild(wrapper);
      }
    }

    return wrapper;
  }

  async function showAddMenuModal() {
    const list = document.createElement('div');
    list.className = 'd-op-modal-menu-list';

    const opBtn = document.createElement('button');
    opBtn.className = 'd-op-modal-menu-item';
    opBtn.textContent = 'OPを追加';
    opBtn.addEventListener('click', () => {
      document.getElementById('d-op-modal').remove();
      openPlaylistModal('op');
    });

    const edBtn = document.createElement('button');
    edBtn.className = 'd-op-modal-menu-item';
    edBtn.textContent = 'EDを追加';
    edBtn.addEventListener('click', () => {
      document.getElementById('d-op-modal').remove();
      openPlaylistModal('ed');
    });

    const customBtn = document.createElement('button');
    customBtn.className = 'd-op-modal-menu-item';
    customBtn.textContent = 'カスタム範囲';
    customBtn.addEventListener('click', () => {
      document.getElementById('d-op-modal').remove();
      showCustomRangeUI();
    });

    list.appendChild(opBtn);
    list.appendChild(edBtn);
    list.appendChild(customBtn);

    await showModal('プレイリストに追加', list, [{ label: 'キャンセル', value: null }]);
  }

  function overrideNativeControls() {
    const nextBtn = document.querySelector('.nextButton, .next button, [class*="next"]');
    const prevBtn = document.querySelector('.prevButton, .prev button, [class*="prev"]');

    if (nextBtn && !nextBtn.dataset.dopOverridden) {
      nextBtn.dataset.dopOverridden = 'true';
      nextBtn.addEventListener('click', async (e) => {
        if (currentPlayback) {
          e.preventDefault();
          e.stopPropagation();
          await advancePlayback(1);
        }
      }, true);
    }

    if (prevBtn && !prevBtn.dataset.dopOverridden) {
      prevBtn.dataset.dopOverridden = 'true';
      prevBtn.addEventListener('click', async (e) => {
        if (currentPlayback) {
          e.preventDefault();
          e.stopPropagation();
          await advancePlayback(-1);
        }
      }, true);
    }
  }

  function getSeekRanges() {
    if (currentPlayback && currentPlayback.item) {
      const item = currentPlayback.item;
      const ranges = [];
      if (item.opRange) ranges.push({ ...item.opRange, label: 'OP' });
      if (item.edRange) ranges.push({ ...item.edRange, label: 'ED' });
      if (item.customRange) ranges.push({ ...item.customRange, label: 'CUSTOM' });
      return ranges;
    }
    return getNoneChapters().map((c) => ({ ...c, label: 'OP/ED' }));
  }

  function updateSeekMarkers() {
    const video = getVideo();
    const seekArea = document.querySelector('.seekArea');
    if (!video || !seekArea || !video.duration) return;

    let container = document.getElementById('d-op-seek-markers');
    if (!container) {
      container = document.createElement('div');
      container.id = 'd-op-seek-markers';
      container.className = 'd-op-seek-markers';
      seekArea.appendChild(container);
    }

    container.innerHTML = '';
    const duration = video.duration;
    const ranges = getSeekRanges();

    ranges.forEach((r) => {
      const start = seconds(r.start);
      const end = seconds(r.end);
      if (start >= duration || end <= 0) return;
      const left = Math.max(0, start / duration * 100);
      const width = Math.min(100 - left, (end - start) / duration * 100);
      if (width <= 0) return;

      const marker = document.createElement('div');
      marker.className = 'd-op-seek-marker';
      marker.style.left = left + '%';
      marker.style.width = width + '%';
      marker.title = `${r.label}: ${formatTime(start)}-${formatTime(end)}`;
      if (r.label === 'OP') marker.classList.add('op');
      if (r.label === 'ED') marker.classList.add('ed');
      if (r.label === 'CUSTOM') marker.classList.add('custom');
      container.appendChild(marker);
    });
  }

  function showModal(title, content, buttons) {
    return new Promise((resolve) => {
      let modal = document.getElementById('d-op-modal');
      if (modal) modal.remove();

      modal = document.createElement('div');
      modal.id = 'd-op-modal';
      modal.className = 'd-op-modal';

      const panel = document.createElement('div');
      panel.className = 'd-op-modal-panel';

      const header = document.createElement('h3');
      header.textContent = title;
      panel.appendChild(header);

      if (content) {
        const body = document.createElement('div');
        body.className = 'd-op-modal-body';
        if (typeof content === 'string') {
          body.textContent = content;
        } else {
          body.appendChild(content);
        }
        panel.appendChild(body);
      }

      const footer = document.createElement('div');
      footer.className = 'd-op-modal-footer';

      buttons.forEach((btn) => {
        const button = document.createElement('button');
        button.textContent = btn.label;
        button.className = btn.primary ? 'primary' : '';
        button.addEventListener('click', () => {
          modal.remove();
          resolve(btn.value);
        });
        footer.appendChild(button);
      });

      panel.appendChild(footer);
      modal.appendChild(panel);
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.remove();
          resolve(null);
        }
      });
      document.body.appendChild(modal);
    });
  }

  async function openPlaylistModal(rangeType) {
    const playlists = await dopGetPlaylists();
    if (playlists.length === 0) {
      const name = await showModal('新規プレイリスト', 'プレイリストがありません。新規作成してください。', [
        { label: 'キャンセル', value: null }
      ]);
      if (!name) return;
      return;
    }

    const list = document.createElement('div');
    list.className = 'd-op-modal-playlist-list';
    let selectedId = null;

    playlists.forEach((playlist) => {
      const row = document.createElement('button');
      row.className = 'd-op-modal-playlist-item';
      row.textContent = `${playlist.name} (${playlist.items.length}曲)`;
      row.addEventListener('click', () => {
        selectedId = playlist.id;
        list.querySelectorAll('.d-op-modal-playlist-item').forEach((b) => b.classList.remove('selected'));
        row.classList.add('selected');
      });
      list.appendChild(row);
    });

    const newRow = document.createElement('div');
    newRow.className = 'd-op-modal-new-row';
    const newInput = document.createElement('input');
    newInput.type = 'text';
    newInput.placeholder = '新規プレイリスト名';
    newRow.appendChild(newInput);

    const content = document.createElement('div');
    content.appendChild(list);
    content.appendChild(newRow);

    const result = await showModal('プレイリストに追加', content, [
      { label: 'キャンセル', value: null },
      { label: '追加', value: 'add', primary: true }
    ]);

    if (result !== 'add') return;

    if (selectedId) {
      await addCurrentToPlaylist(selectedId, rangeType);
      return;
    }

    const name = newInput.value.trim();
    if (name) {
      const playlist = await dopCreatePlaylist(name);
      await addCurrentToPlaylist(playlist.id, rangeType);
    }
  }

  function showCustomRangeUI() {
    customStart = null;
    customEnd = null;

    const body = document.createElement('div');
    body.className = 'd-op-custom-range';

    const rangeText = document.createElement('div');
    rangeText.className = 'd-op-custom-range-text';
    rangeText.textContent = '開始/終了を設定してください';

    const startBtn = document.createElement('button');
    startBtn.textContent = '開始地点を設定';
    startBtn.addEventListener('click', () => {
      const video = getVideo();
      if (!video) return;
      customStart = Math.floor(video.currentTime * 1000);
      updateRangeText();
    });

    const endBtn = document.createElement('button');
    endBtn.textContent = '終了地点を設定';
    endBtn.addEventListener('click', () => {
      const video = getVideo();
      if (!video) return;
      customEnd = Math.floor(video.currentTime * 1000);
      updateRangeText();
    });

    const testBtn = document.createElement('button');
    testBtn.textContent = '再生テスト';
    testBtn.className = 'primary';
    testBtn.addEventListener('click', () => {
      if (!customStart || !customEnd) return;
      activateMode('none');
      currentMode = 'custom-test';
      targetRanges = [{ start: Math.min(customStart, customEnd), end: Math.max(customStart, customEnd) }];
      setNativeSkip(false);
      startEnforcer();
      seek(seconds(targetRanges[0].start));
      play();
    });

    const addBtn = document.createElement('button');
    addBtn.textContent = 'プレイリストに追加';
    addBtn.className = 'primary';
    addBtn.addEventListener('click', async () => {
      if (!customStart || !customEnd) return;
      stopEnforcer();
      resetNativeSkip();
      currentMode = 'none';
      document.getElementById('d-op-modal').remove();
      await openPlaylistModal('custom');
    });

    function updateRangeText() {
      const s = customStart ? formatTime(seconds(customStart)) : '--:--';
      const e = customEnd ? formatTime(seconds(customEnd)) : '--:--';
      rangeText.textContent = `範囲: ${s} - ${e}`;
    }

    const buttons = document.createElement('div');
    buttons.className = 'd-op-custom-range-buttons';
    buttons.appendChild(startBtn);
    buttons.appendChild(endBtn);
    buttons.appendChild(testBtn);

    body.appendChild(rangeText);
    body.appendChild(buttons);
    body.appendChild(addBtn);

    showModal('カスタム範囲', body, [{ label: '閉じる', value: null }]);
  }

  async function addCurrentToPlaylist(playlistId, rangeType) {
    const data = chaptersInfo;
    if (!data) return;

    let range = null;
    if (rangeType === 'op') {
      const r = getOpRange();
      if (r) range = { start: r.start, end: r.end };
    } else if (rangeType === 'ed') {
      const r = getEdRange();
      if (r) range = { start: r.start, end: r.end };
    } else if (rangeType === 'custom') {
      if (customStart && customEnd) {
        range = { start: Math.min(customStart, customEnd), end: Math.max(customStart, customEnd) };
      }
    }

    if (!range) {
      await showModal('エラー', '範囲を取得できませんでした。', [{ label: 'OK', value: null, primary: true }]);
      return;
    }

    const item = {
      partId: data.partId,
      workId: data.workId,
      title: data.workTitle || data.partTitle || '',
      episodeTitle: data.partTitle || '',
      url: location.href,
      opRange: rangeType === 'op' ? range : null,
      edRange: rangeType === 'ed' ? range : null,
      customRange: rangeType === 'custom' ? range : null
    };

    await dopAddItemToPlaylist(playlistId, item);
    customStart = null;
    customEnd = null;
    await showModal('追加完了', 'プレイリストに追加しました。', [{ label: 'OK', value: null, primary: true }]);
  }

  async function checkPendingPlayback() {
    const pending = await dopGetPending();
    if (!pending || !chaptersInfo) return;
    const currentPartId = chaptersInfo.partId;
    if (pending.partId !== currentPartId) return;

    await dopClearPending();

    const none = getNoneChapters();
    const first = none.length > 0 ? none[0] : null;
    const last = none.length > 1 ? none[none.length - 1] : null;

    const playlists = await dopGetPlaylists();
    let playlist = playlists.find((p) => p.name === '__dop_auto');
    if (!playlist) {
      playlist = await dopCreatePlaylist('__dop_auto');
    } else {
      await dopClearItems(playlist.id);
    }

    const item = {
      partId: currentPartId,
      workId: chaptersInfo.workId || '',
      title: chaptersInfo.workTitle || chaptersInfo.partTitle || pending.title || '',
      episodeTitle: chaptersInfo.partTitle || pending.episodeTitle || '',
      url: location.href,
      opRange: pending.rangeType === 'op' && first ? { start: first.start, end: first.end } : null,
      edRange: pending.rangeType === 'ed' && last ? { start: last.start, end: last.end } : null,
      customRange: null
    };

    await dopAddItemToPlaylist(playlist.id, item);
    await dopSetPlayback({
      playlistId: playlist.id,
      index: 0,
      mode: pending.rangeType
    });
    startPlayback(playlist, 0, pending.rangeType);
  }

  async function resumePlaybackIfAny() {
    const pending = await dopGetPending();
    if (pending) {
      await checkPendingPlayback();
      return;
    }

    const playback = await dopGetPlayback();
    if (!playback) return;
    const playlists = await dopGetPlaylists();
    const playlist = playlists.find((p) => p.id === playback.playlistId);
    if (!playlist || playback.index >= playlist.items.length) {
      await dopClearPlayback();
      return;
    }
    const item = playlist.items[playback.index];
    const currentPartId = new URLSearchParams(location.search).get('partId');
    if (currentPartId !== item.partId) {
      location.href = item.url;
      return;
    }
    startPlayback(playlist, playback.index, playback.mode);
  }

  function handleRuntimeMessage(message) {
    if (!message || !message.type) return;
    switch (message.type) {
      case 'PLAYLIST_PREV':
        advancePlayback(-1);
        break;
      case 'PLAYLIST_NEXT':
        advancePlayback(1);
        break;
      case 'PLAYLIST_STOP':
        stopEnforcer();
        resetNativeSkip();
        currentPlayback = null;
        currentMode = 'none';
        dopClearPlayback();
        break;
    }
  }

  function handleChapters(info) {
    chaptersInfo = info;
    attachVideoListener();
    createAddButton();
    overrideNativeControls();
    updateSeekMarkers();
    checkPendingPlayback();
    resumePlaybackIfAny();
  }

  function init() {
    if (window.__dOpInitialized) return;
    window.__dOpInitialized = true;

    chrome.runtime.sendMessage({ type: 'INJECT_SCRIPT' }, () => {
      chrome.runtime.lastError;
    });

    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin) return;
      const msg = event.data;
      if (!msg || msg.source !== APP_TAG) return;
      if (msg.type === 'CHAPTERS_FOUND') {
        handleChapters(msg.payload);
      }
    });

    chrome.runtime.onMessage.addListener((message) => {
      handleRuntimeMessage(message);
    });

    const observer = new MutationObserver(() => {
      const video = getVideo();
      if (video && attachedVideo !== video) {
        attachVideoListener();
        updateSeekMarkers();
      }
      createAddButton();
      overrideNativeControls();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
