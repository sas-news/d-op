(function () {
  'use strict';

  const APP_TAG = 'd-op-injected';
  const DEBUG = false;
  const RESUME_MAX_AGE_MS = 5 * 60 * 1000;

  let chaptersInfo = null;
  let lastPartId = null;
  let targetRanges = [];
  let currentMode = 'none';
  let originalOpSkip = null;
  let lastActionTime = 0;
  let attachedVideo = null;
  let enforcerTimer = null;
  let currentPlayback = null;
  let customStart = null;
  let customEnd = null;
  let customName = '';
  let customSelecting = false;
  let seekCooldownUntil = 0;
  let startupLockUntil = 0;
  let lastPrevClickTime = 0;
  let panelHideTimer = null;
  const PANEL_HIDE_DELAY = 3000;
  let currentSeekRanges = [];

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
    return chaptersInfo.chapters
      .filter((c) => c.type === 'none')
      .slice()
      .sort((a, b) => a.start - b.start);
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
    if (currentPlayback && currentPlayback.item && currentPlayback.item.range) {
      return [currentPlayback.item.range];
    }
    const none = getNoneChapters();
    if (currentMode === 'op-only') return none.length > 0 ? [none[0]] : [];
    if (currentMode === 'ed-only') return none.length > 0 ? [none[none.length - 1]] : [];
    if (currentMode === 'op-ed') return none.slice();
    if (currentMode === 'custom-test') return targetRanges.slice();
    if (customSelecting && customStart && customEnd) {
      return [{ start: Math.min(customStart, customEnd), end: Math.max(customStart, customEnd) }];
    }
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

  function clearPlaylistState() {
    stopEnforcer();
    resetNativeSkip();
    currentPlayback = null;
    currentMode = 'none';
    targetRanges = [];
    dopClearPlayback();
    updatePlaylistUI();
    updateSeekMarkers();
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

  function seekToStartWhenReady(startSec, onReady) {
    const deadline = Date.now() + 3000;
    const trySeek = () => {
      const video = getVideo();
      if (video && video.readyState >= 1 && video.duration) {
        seek(startSec);
        if (onReady) setTimeout(onReady, 100);
        return;
      }
      if (Date.now() < deadline) {
        setTimeout(trySeek, 100);
      } else if (onReady) {
        onReady();
      }
    };
    trySeek();
  }

  function playItemInCurrentVideo(playlist, index) {
    const item = playlist.items[index];
    if (!item || !item.range) return;
    currentPlayback = { playlistId: playlist.id, index, item };
    dopSetPlayback({ playlistId: playlist.id, index, updatedAt: Date.now() });
    targetRanges = buildRanges();
    seekCooldownUntil = 0;
    lastActionTime = 0;
    log('playItemInCurrentVideo', { playlist: playlist.name, index, type: item.range.type });

    if (targetRanges.length === 0) {
      currentPlayback = null;
      dopClearPlayback();
      updatePlaylistUI();
      return;
    }

    setNativeSkip(false);
    startupLockUntil = Date.now() + 800;
    startEnforcer();
    updatePlaylistUI();
    updateSeekMarkers();

    const start = seconds(targetRanges[0].start);
    seekToStartWhenReady(start, () => play());
  }

  function startPlayback(playlist, index) {
    const item = playlist.items[index];
    if (!item || !item.range) return;
    currentPlayback = { playlistId: playlist.id, index, item };
    dopSetPlayback({ playlistId: playlist.id, index, updatedAt: Date.now() });
    targetRanges = buildRanges();
    seekCooldownUntil = 0;
    lastActionTime = 0;
    log('startPlayback', { playlist: playlist.name, index, type: item.range.type });

    if (targetRanges.length === 0) {
      currentPlayback = null;
      dopClearPlayback();
      updatePlaylistUI();
      return;
    }

    setNativeSkip(false);
    startupLockUntil = Date.now() + 1500;
    startEnforcer();
    updatePlaylistUI();
    updateSeekMarkers();

    const start = seconds(targetRanges[0].start);
    pause();
    seekToStartWhenReady(start, () => play());
  }

  async function playPlaylistIndex(playlist, index) {
    const item = playlist.items[index];
    if (!item || !item.range) return;
    const currentPartId = new URLSearchParams(location.search).get('partId');
    if (currentPartId === item.partId) {
      playItemInCurrentVideo(playlist, index);
    } else {
      await goToPlaylistItem(playlist.id, index, item);
    }
  }

  async function advancePlayback(direction) {
    if (!currentPlayback) return false;
    const playlists = await dopGetPlaylists();
    const playlist = playlists.find((p) => p.id === currentPlayback.playlistId);
    if (!playlist) {
      clearPlaylistState();
      return false;
    }
    const newIndex = currentPlayback.index + direction;
    if (newIndex < 0 || newIndex >= playlist.items.length) {
      if (newIndex >= playlist.items.length) {
        showEndOfPlaylistPopup(playlist);
      } else {
        pause();
      }
      return false;
    }
    await playPlaylistIndex(playlist, newIndex);
    return true;
  }

  async function goToPlaylistItem(playlistId, index, item) {
    await dopSetPlayback({ playlistId, index, updatedAt: Date.now() });
    const url = new URL(item.url);
    url.searchParams.set('dopPlaylistId', playlistId);
    url.searchParams.set('dopIndex', String(index));
    location.href = url.toString();
  }

  function showEndOfPlaylistPopup(playlist) {
    pause();
    const content = document.createElement('div');
    content.style.textAlign = 'center';
    content.textContent = 'プレイリストの最後まで再生しました';

    showModal('再生終了', content, [
      { label: '最初から再生', value: 'restart' },
      { label: 'このまま見る', value: 'continue', primary: true },
      { label: '閉じる', value: 'close' }
    ]).then((value) => {
      if (value === 'restart') {
        playPlaylistIndex(playlist, 0);
      } else {
        clearPlaylistState();
      }
    });
  }

  async function handlePrevClick() {
    if (!currentPlayback) return;
    const video = getVideo();
    const start = seconds(currentPlayback.item.range.start);
    const now = Date.now();
    const nearStart = video && Math.abs(video.currentTime - start) < 1.0;
    const doubleClick = nearStart && (now - lastPrevClickTime < 1500);

    if (doubleClick) {
      advancePlayback(-1);
    } else {
      seek(start);
      if (video && video.paused) play();
    }
    lastPrevClickTime = now;
  }

  function readUrlParams() {
    const params = new URLSearchParams(location.search);
    return {
      rangeType: params.get('dopRangeType'),
      title: params.get('dopTitle') || '',
      episodeTitle: params.get('dopEpisodeTitle') || '',
      playlistId: params.get('dopPlaylistId'),
      index: params.has('dopIndex') ? parseInt(params.get('dopIndex'), 10) : null
    };
  }

  function removeDopParamsFromUrl(href) {
    const url = new URL(href);
    ['dopRangeType', 'dopTitle', 'dopEpisodeTitle', 'dopPlaylistId', 'dopIndex'].forEach((k) => url.searchParams.delete(k));
    return url.toString();
  }

  async function checkUrlParams() {
    const params = readUrlParams();

    if (params.playlistId && params.index !== null) {
      const playlists = await dopGetPlaylists();
      const playlist = playlists.find((p) => p.id === params.playlistId);
      if (playlist && params.index >= 0 && params.index < playlist.items.length) {
        history.replaceState(null, '', removeDopParamsFromUrl(location.href));
        startPlayback(playlist, params.index);
        return;
      }
    }

    if (params.rangeType) {
      history.replaceState(null, '', removeDopParamsFromUrl(location.href));
      await startWorkPageRange(params.rangeType);
    }
  }

  async function startWorkPageRange(rangeType) {
    const none = getNoneChapters();
    if (none.length === 0) {
      showModal('エラー', 'この話にはOP/ED情報が見つかりませんでした。', [{ label: 'OK', value: null, primary: true }]);
      return;
    }

    const selectedRange = rangeType === 'op' ? getOpRange() : rangeType === 'ed' ? getEdRange() : null;
    if (!selectedRange) {
      showModal('エラー', 'この話には該当するOP/EDが見つかりませんでした。', [{ label: 'OK', value: null, primary: true }]);
      return;
    }

    clearPlaylistState();
    currentMode = 'op-ed';
    targetRanges = none.slice();
    setNativeSkip(false);
    startEnforcer();
    updatePlaylistUI();
    await updateSeekMarkers();

    const start = seconds(selectedRange.start);
    pause();
    seekToStartWhenReady(start, () => play());
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
    if (Date.now() < seekCooldownUntil) return;

    const video = getVideo();
    if (!video) return;

    const t = video.currentTime;
    const firstStart = seconds(targetRanges[0].start);
    const lastEnd = seconds(targetRanges[targetRanges.length - 1].end);
    const duration = video.duration || Infinity;

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

    if (t > lastEnd || t >= duration - 0.3 || video.ended) {
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

    const video = getVideo();
    if (currentPlayback && video && Date.now() < startupLockUntil) {
      const start = seconds(targetRanges[0].start);
      if (Math.abs(video.currentTime - start) > 1.0) {
        seek(start);
      }
    }
  }

  function onSeeking() {
    seekCooldownUntil = Date.now() + 1000;
  }

  function onSeeked() {
    seekCooldownUntil = Date.now() + 800;
  }

  function onVideoEnded() {
    if (currentPlayback) {
      advancePlayback(1);
    }
  }

  function attachVideoListener() {
    const video = getVideo();
    if (!video) return;
    if (attachedVideo === video) return;
    if (attachedVideo) {
      attachedVideo.removeEventListener('timeupdate', onTimeUpdate);
      attachedVideo.removeEventListener('seeking', onSeeking);
      attachedVideo.removeEventListener('seeked', onSeeked);
      attachedVideo.removeEventListener('ended', onVideoEnded);
    }
    attachedVideo = video;
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('ended', onVideoEnded);
    video.addEventListener('durationchange', updateSeekMarkers);
    video.addEventListener('loadedmetadata', updateSeekMarkers);
  }

  function createAddButton() {
    let wrapper = document.getElementById('d-op-add-wrapper');
    if (wrapper && wrapper.isConnected) return wrapper;
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'd-op-add-wrapper';
      wrapper.className = 'd-op-add-wrapper';

      const btn = document.createElement('button');
      btn.className = 'd-op-add-button';
      btn.textContent = '♪';
      btn.title = 'プレイリストに追加';
      btn.setAttribute('aria-label', 'プレイリストに追加');

      const popup = document.createElement('div');
      popup.className = 'd-op-popup';

      popup.appendChild(createPopupRow('OPを追加', () => openPlaylistModal('op')));
      popup.appendChild(createPopupRow('EDを追加', () => openPlaylistModal('ed')));
      popup.appendChild(createPopupRow('カスタム範囲', () => showCustomRangeBar()));

      wrapper.appendChild(btn);
      wrapper.appendChild(popup);
    }

    const timeEl = document.querySelector('.buttonArea .time');
    if (timeEl && timeEl.parentNode && wrapper.parentNode !== timeEl.parentNode) {
      const next = timeEl.nextElementSibling;
      if (next) {
        timeEl.parentNode.insertBefore(wrapper, next);
      } else {
        timeEl.parentNode.appendChild(wrapper);
      }
    }

    return wrapper;
  }

  function createPopupRow(label, onClick) {
    const row = document.createElement('div');
    row.className = 'd-op-popup-item';
    row.textContent = label;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return row;
  }

  function createPlaylistControls() {
    let prevWrapper = document.getElementById('d-op-playlist-prev');
    let nextWrapper = document.getElementById('d-op-playlist-next');
    const alreadyExist = prevWrapper && prevWrapper.isConnected && nextWrapper && nextWrapper.isConnected;

    if (!alreadyExist) {
      if (!prevWrapper) {
        prevWrapper = document.createElement('div');
        prevWrapper.id = 'd-op-playlist-prev';
        prevWrapper.className = 'd-op-playlist-btn-wrapper';
        const prevBtn = document.createElement('button');
        prevBtn.className = 'd-op-playlist-btn';
        prevBtn.textContent = '⏮';
        prevBtn.title = '前へ';
        prevBtn.addEventListener('click', () => handlePrevClick());
        prevWrapper.appendChild(prevBtn);
      }

      if (!nextWrapper) {
        nextWrapper = document.createElement('div');
        nextWrapper.id = 'd-op-playlist-next';
        nextWrapper.className = 'd-op-playlist-btn-wrapper';
        const nextBtn = document.createElement('button');
        nextBtn.className = 'd-op-playlist-btn';
        nextBtn.textContent = '⏭';
        nextBtn.title = '次へ';
        nextBtn.addEventListener('click', () => advancePlayback(1));
        nextWrapper.appendChild(nextBtn);
      }

      const addWrapper = document.getElementById('d-op-add-wrapper');
      if (addWrapper && addWrapper.parentNode) {
        if (prevWrapper.parentNode !== addWrapper.parentNode) {
          addWrapper.parentNode.insertBefore(prevWrapper, addWrapper);
        }
        if (nextWrapper.parentNode !== addWrapper.parentNode) {
          addWrapper.parentNode.insertBefore(nextWrapper, addWrapper.nextSibling);
        }
      } else {
        const timeEl = document.querySelector('.buttonArea .time');
        if (timeEl && timeEl.parentNode) {
          if (prevWrapper.parentNode !== timeEl.parentNode) {
            timeEl.parentNode.insertBefore(prevWrapper, timeEl.nextSibling);
          }
          if (nextWrapper.parentNode !== timeEl.parentNode) {
            timeEl.parentNode.insertBefore(nextWrapper, timeEl.nextSibling);
          }
        }
      }
    }

    return { prevWrapper, nextWrapper };
  }

  function updatePlaylistUI() {
    const { prevWrapper, nextWrapper } = createPlaylistControls();
    const prevBtn = prevWrapper.querySelector('button');
    const nextBtn = nextWrapper.querySelector('button');
    const active = currentPlayback || currentMode !== 'none';

    if (!active) {
      document.body.classList.remove('d-op-playlist-active');
      prevWrapper.style.display = 'none';
      nextWrapper.style.display = 'none';
      hideTopRightPanel();
      return;
    }

    document.body.classList.add('d-op-playlist-active');

    if (currentPlayback) {
      prevWrapper.style.display = 'inline-flex';
      nextWrapper.style.display = 'inline-flex';
      prevBtn.disabled = currentPlayback.index <= 0;
      nextBtn.disabled = true;
      dopGetPlaylists().then((playlists) => {
        const playlist = playlists.find((p) => p.id === currentPlayback.playlistId);
        if (playlist) {
          nextBtn.disabled = currentPlayback.index >= playlist.items.length - 1;
        }
      });
    } else {
      prevWrapper.style.display = 'none';
      nextWrapper.style.display = 'none';
    }

    showTopRightPanel();
  }

  function resetPanelHideTimer() {
    if (panelHideTimer) {
      clearTimeout(panelHideTimer);
      panelHideTimer = null;
    }
    panelHideTimer = setTimeout(() => {
      const panel = document.getElementById('d-op-top-panel');
      if (panel) panel.style.opacity = '0';
    }, PANEL_HIDE_DELAY);
  }

  function showTopRightPanel() {
    let panel = document.getElementById('d-op-top-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'd-op-top-panel';
      panel.className = 'd-op-top-panel';
      document.body.appendChild(panel);
    }

    let label = 'OP/ED';
    let sub = 'プレイリスト再生中';
    if (currentPlayback && currentPlayback.item && currentPlayback.item.range) {
      const range = currentPlayback.item.range;
      label = range.name || (range.type === 'op' ? 'OP' : range.type === 'ed' ? 'ED' : 'CUSTOM');
    } else if (currentMode === 'custom-test' || customSelecting) {
      label = customName || 'CUSTOM';
    } else if (currentMode === 'op-ed') {
      label = 'OP/ED';
    }

    panel.innerHTML = '';

    const modeText = document.createElement('div');
    modeText.className = 'd-op-top-mode';
    modeText.textContent = label;

    const subText = document.createElement('div');
    subText.className = 'd-op-top-sub';
    subText.textContent = sub;

    const stopBtn = document.createElement('button');
    stopBtn.textContent = '終了';
    stopBtn.title = 'プレイリスト再生を終了';
    stopBtn.addEventListener('click', () => {
      clearPlaylistState();
    });

    panel.appendChild(modeText);
    panel.appendChild(subText);
    panel.appendChild(stopBtn);
    panel.style.display = 'flex';
    panel.style.opacity = '1';
    resetPanelHideTimer();
  }

  function hideTopRightPanel() {
    const panel = document.getElementById('d-op-top-panel');
    if (panel) {
      panel.style.display = 'none';
      panel.style.opacity = '1';
    }
    if (panelHideTimer) {
      clearTimeout(panelHideTimer);
      panelHideTimer = null;
    }
  }

  function onMouseMove() {
    if (!currentPlayback && currentMode === 'none') return;
    const panel = document.getElementById('d-op-top-panel');
    if (panel) {
      panel.style.opacity = '1';
    }
    resetPanelHideTimer();
  }

  async function getSeekRanges() {
    const ranges = [];
    const none = getNoneChapters();
    const noneRanges = none.map((c, i, arr) => ({
      ...c,
      label: i === 0 ? 'OP' : i === arr.length - 1 ? 'ED' : 'OP/ED'
    }));
    ranges.push(...noneRanges);

    if (currentPlayback && currentPlayback.item && currentPlayback.item.range) {
      const r = currentPlayback.item.range;
      const label = r.name || r.type.toUpperCase();
      const dup = ranges.some((c) => c.start === r.start && c.end === r.end);
      if (!dup) ranges.push({ ...r, label });
    }

    if ((currentMode === 'custom-test' || customSelecting) && targetRanges.length > 0) {
      const r = targetRanges[0];
      const label = customName || 'CUSTOM';
      const dup = ranges.some((c) => c.start === r.start && c.end === r.end);
      if (!dup) ranges.push({ ...r, label });
    }

    if (chaptersInfo && chaptersInfo.partId) {
      const playlists = await dopGetPlaylists();
      playlists.forEach((playlist) => {
        playlist.items.forEach((item) => {
          if (item.partId === chaptersInfo.partId && item.range) {
            const dup = ranges.some((c) => c.start === item.range.start && c.end === item.range.end);
            if (!dup) {
              const r = item.range;
              const label = r.name || (r.type === 'op' ? 'OP' : r.type === 'ed' ? 'ED' : 'CUSTOM');
              ranges.push({ ...r, label });
            }
          }
        });
      });
    }

    return ranges;
  }

  function getRangeAt(timeSec) {
    for (const r of currentSeekRanges) {
      const start = seconds(r.start);
      const end = seconds(r.end);
      if (timeSec >= start - 0.05 && timeSec <= end + 0.05) return r;
    }
    return null;
  }

  function updateSeekPopupTitle(timeSec) {
    const wrap = document.getElementById('seekPopupInWrap');
    if (!wrap) return;
    let labelEl = document.getElementById('d-op-seek-popup-label');
    if (!labelEl) {
      labelEl = document.createElement('div');
      labelEl.id = 'd-op-seek-popup-label';
      labelEl.className = 'd-op-seek-popup-label';
      wrap.appendChild(labelEl);
    }
    const r = getRangeAt(timeSec);
    if (r) {
      labelEl.textContent = r.label;
      labelEl.style.display = 'block';
    } else {
      labelEl.style.display = 'none';
    }
  }

  function attachSeekPopupListener() {
    const seekArea = document.querySelector('.seekArea');
    if (!seekArea || seekArea.dataset.dopSeekListener) return;
    seekArea.dataset.dopSeekListener = 'true';
    seekArea.addEventListener('mousemove', (e) => {
      const rect = seekArea.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const video = getVideo();
      if (!video || !video.duration) return;
      updateSeekPopupTitle(ratio * video.duration);
    });
    seekArea.addEventListener('mouseleave', () => {
      const labelEl = document.getElementById('d-op-seek-popup-label');
      if (labelEl) labelEl.style.display = 'none';
    });
  }

  async function updateSeekMarkers() {
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
    const ranges = await getSeekRanges();
    currentSeekRanges = ranges;
    const canSeekColor = currentMode === 'op-ed' || currentMode === 'custom-test' || customSelecting;

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
      if (canSeekColor) {
        if (r.label === 'OP') marker.classList.add('op');
        if (r.label === 'ED') marker.classList.add('ed');
        if (r.label === 'CUSTOM' || r.type === 'custom') marker.classList.add('custom');
      }
      container.appendChild(marker);
    });

    attachSeekPopupListener();
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
    const playlists = (await dopGetPlaylists()).filter((p) => !isSystemPlaylist(p));
    if (playlists.length === 0) {
      await showModal('新規プレイリスト', 'プレイリストがありません。管理画面から作成してください。', [
        { label: 'OK', value: null, primary: true }
      ]);
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

  function isSystemPlaylist(playlist) {
    return typeof playlist.name === 'string' && playlist.name.startsWith('__dop_');
  }

  function showCustomRangeBar() {
    customSelecting = true;
    let bar = document.getElementById('d-op-custom-bar');
    if (bar) bar.remove();

    bar = document.createElement('div');
    bar.id = 'd-op-custom-bar';
    bar.className = 'd-op-custom-bar';

    const rangeText = document.createElement('span');
    rangeText.className = 'd-op-custom-bar-text';
    updateText();

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = '名前（空欄でCUSTOM）';
    nameInput.value = customName;
    nameInput.addEventListener('input', () => {
      customName = nameInput.value.trim();
      updateSeekMarkers();
    });

    const startBtn = document.createElement('button');
    startBtn.textContent = '開始';
    startBtn.title = '開始地点を設定';
    startBtn.addEventListener('click', () => {
      const video = getVideo();
      if (!video) return;
      customStart = Math.floor(video.currentTime * 1000);
      updateText();
      updateSeekMarkers();
    });

    const endBtn = document.createElement('button');
    endBtn.textContent = '終了';
    endBtn.title = '終了地点を設定';
    endBtn.addEventListener('click', () => {
      const video = getVideo();
      if (!video) return;
      customEnd = Math.floor(video.currentTime * 1000);
      updateText();
      updateSeekMarkers();
    });

    const testBtn = document.createElement('button');
    testBtn.textContent = 'テスト';
    testBtn.addEventListener('click', () => {
      if (!customStart || !customEnd) return;
      currentMode = 'custom-test';
      targetRanges = [{ start: Math.min(customStart, customEnd), end: Math.max(customStart, customEnd) }];
      setNativeSkip(false);
      startEnforcer();
      updateSeekMarkers();
      seek(seconds(targetRanges[0].start));
      play();
    });

    const addBtn = document.createElement('button');
    addBtn.textContent = '追加';
    addBtn.className = 'primary';
    addBtn.addEventListener('click', async () => {
      if (!customStart || !customEnd) return;
      await openPlaylistModal('custom');
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.addEventListener('click', () => {
      stopEnforcer();
      resetNativeSkip();
      currentMode = 'none';
      targetRanges = [];
      customStart = null;
      customEnd = null;
      customName = '';
      customSelecting = false;
      bar.remove();
      updateSeekMarkers();
    });

    function updateText() {
      const s = customStart ? formatTime(seconds(customStart)) : '--:--';
      const e = customEnd ? formatTime(seconds(customEnd)) : '--:--';
      rangeText.textContent = `${s} - ${e}`;
    }

    bar.appendChild(rangeText);
    bar.appendChild(nameInput);
    bar.appendChild(startBtn);
    bar.appendChild(endBtn);
    bar.appendChild(testBtn);
    bar.appendChild(addBtn);
    bar.appendChild(cancelBtn);
    document.body.appendChild(bar);
  }

  async function addCurrentToPlaylist(playlistId, rangeType) {
    const data = chaptersInfo;
    if (!data) return;

    let range = null;
    if (rangeType === 'op') {
      const r = getOpRange();
      if (r) range = { type: 'op', start: r.start, end: r.end };
    } else if (rangeType === 'ed') {
      const r = getEdRange();
      if (r) range = { type: 'ed', start: r.start, end: r.end };
    } else if (rangeType === 'custom') {
      if (customStart && customEnd) {
        range = {
          type: 'custom',
          start: Math.min(customStart, customEnd),
          end: Math.max(customStart, customEnd),
          name: customName || undefined
        };
      }
    }

    if (!range) {
      await showModal('エラー', '範囲を取得できませんでした。', [{ label: 'OK', value: null, primary: true }]);
      return;
    }

    const item = {
      partId: data.partId,
      workId: data.workId || '',
      title: data.workTitle || data.title || data.partTitle || '',
      episodeTitle: data.partTitle || '',
      url: location.href,
      range
    };

    await dopAddItemToPlaylist(playlistId, item);

    stopEnforcer();
    resetNativeSkip();
    currentMode = 'none';
    targetRanges = [];
    customStart = null;
    customEnd = null;
    customName = '';
    customSelecting = false;
    const bar = document.getElementById('d-op-custom-bar');
    if (bar) bar.remove();
    updateSeekMarkers();

    await showModal('追加完了', 'プレイリストに追加しました。', [{ label: 'OK', value: null, primary: true }]);
  }

  async function resumePlaybackIfAny() {
    if (currentPlayback) return;
    if (currentMode !== 'none') return;
    if (readUrlParams().rangeType || readUrlParams().playlistId) return;

    const playback = await dopGetPlayback();
    if (!playback) return;
    if (playback.updatedAt && Date.now() - playback.updatedAt > RESUME_MAX_AGE_MS) {
      await dopClearPlayback();
      return;
    }

    const playlists = await dopGetPlaylists();
    const playlist = playlists.find((p) => p.id === playback.playlistId);
    if (!playlist || playback.index >= playlist.items.length) {
      await dopClearPlayback();
      return;
    }
    const item = playlist.items[playback.index];
    const currentPartId = new URLSearchParams(location.search).get('partId');
    if (currentPartId !== item.partId) {
      await goToPlaylistItem(playlist.id, playback.index, item);
      return;
    }
    startPlayback(playlist, playback.index);
  }

  async function jumpToPlaylistIndex(index) {
    const playback = await dopGetPlayback();
    if (!playback) return;
    const playlists = await dopGetPlaylists();
    const playlist = playlists.find((p) => p.id === playback.playlistId);
    if (!playlist || index < 0 || index >= playlist.items.length) return;
    await playPlaylistIndex(playlist, index);
  }

  function handleRuntimeMessage(message) {
    if (!message || !message.type) return;
    switch (message.type) {
      case 'PLAYLIST_PREV':
        handlePrevClick();
        break;
      case 'PLAYLIST_NEXT':
        advancePlayback(1);
        break;
      case 'PLAYLIST_STOP':
        clearPlaylistState();
        break;
      case 'PLAYLIST_JUMP':
        if (message.index !== undefined) {
          jumpToPlaylistIndex(message.index);
        }
        break;
    }
  }

  async function handleChapters(info) {
    const partIdChanged = chaptersInfo === null || chaptersInfo.partId !== info.partId;
    chaptersInfo = info;

    if (partIdChanged) {
      lastPartId = info.partId;
      if (!currentPlayback) {
        currentMode = 'none';
        targetRanges = [];
        stopEnforcer();
        resetNativeSkip();
      }
      await updateSeekMarkers();
    }

    attachVideoListener();
    createAddButton();
    createPlaylistControls();
    await updateSeekMarkers();
    updatePlaylistUI();
    await checkUrlParams();
    await resumePlaybackIfAny();
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

    window.addEventListener('beforeunload', () => {
      dopClearPlayback();
      dopClearPending();
    });

    document.addEventListener('mousemove', onMouseMove);

    let observerPaused = false;
    const observer = new MutationObserver(() => {
      if (observerPaused) return;
      observerPaused = true;
      try {
        const video = getVideo();
        if (video && attachedVideo !== video) {
          attachVideoListener();
          updateSeekMarkers();
        }
        createAddButton();
        createPlaylistControls();
      } finally {
        observerPaused = false;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
