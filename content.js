(function () {
  'use strict';

  const APP_TAG = 'd-op-injected';
  const DEBUG = false;

  let chaptersInfo = null;
  let lastPartId = null;
  let targetRanges = [];
  let currentMode = 'none';
  let originalOpSkip = null;
  let lastActionTime = 0;
  let attachedVideo = null;
  let currentPlayback = null;
  let customStart = null;
  let customEnd = null;
  let customName = '';
  let customSelecting = false;
  let seekCooldownUntil = 0;
  let startupLockUntil = 0;
  let lastPrevClickTime = 0;
  let panelHideTimer = null;
  let currentSeekRanges = [];
  let seekMarkerDebounceTimer = null;
  let currentSessionId = null;
  let isInputFocused = false;

  function getPlayerPageInfo() {
    const backInfo = document.getElementById('backInfo');
    if (!backInfo) return {};
    const txt = function (sel) {
      const el = backInfo.querySelector(sel);
      return el ? el.textContent.trim() : '';
    };
    return {
      workTitle: txt('.backInfoTxt1'),
      episodeNumber: txt('.backInfoTxt2'),
      episodeTitle: txt('.backInfoTxt3')
    };
  }

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

  function isEditableElement(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function getNoneChapters() {
    if (!chaptersInfo || !chaptersInfo.chapters) return [];
    return chaptersInfo.chapters
      .filter((c) => c.type === 'none')
      .slice()
      .sort((a, b) => a.start - b.start);
  }

  function getNoneRanges(durationSec) {
    const none = getNoneChapters();
    return none.map((c, i) => ({
      ...c,
      name: guessRangeName(c, i, none.length, durationSec)
    }));
  }

  function buildRanges() {
    if (currentPlayback && currentPlayback.item && currentPlayback.item.range) {
      return [currentPlayback.item.range];
    }
    const none = getNoneChapters();
    if (currentMode === 'op-ed') return none.slice();
    if (currentMode === 'custom-test') return targetRanges.slice();
    if (customSelecting && customStart && customEnd && customStart < customEnd) {
      return [{ start: customStart, end: customEnd }];
    }
    return [];
  }

  function sendCommand(type, payload) {
    window.postMessage({ source: APP_TAG, direction: 'to-page', type, payload }, window.location.origin);
  }

  function injectPageScript() {
    if (document.getElementById('d-op-injected-script')) return;
    const script = document.createElement('script');
    script.id = 'd-op-injected-script';
    script.src = browser.runtime.getURL('injected.js');
    script.setAttribute('data-dop-injected', 'true');
    (document.head || document.documentElement).appendChild(script);
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
    if (!enabled) {
      sendCommand('BLOCK_AUTO_ADVANCE', {});
    }
  }

  function resetNativeSkip() {
    if (originalOpSkip !== null) {
      setCookieValue('op_skip', originalOpSkip);
      originalOpSkip = null;
    }
    sendCommand('UNBLOCK_AUTO_ADVANCE', {});
  }

  async function clearPlaylistState() {
    resetNativeSkip();
    currentPlayback = null;
    currentMode = 'none';
    targetRanges = [];
    seekCooldownUntil = 0;
    lastActionTime = 0;
    startupLockUntil = 0;
    const cleanup = currentSessionId
      ? dopClearPlaybackForWindow(currentSessionId)
      : dopClearPlayback();
    await cleanup;
    await dopSetOpEdMode(false);
    history.replaceState(null, '', removeDopParamsFromUrl(location.href));
    updatePlaylistUI();
    updateSeekMarkers();
  }

  function activateMode(mode) {
    currentMode = mode;
    targetRanges = buildRanges();
    log('activateMode', { mode, ranges: targetRanges.map((r) => [seconds(r.start), seconds(r.end)]) });

    if (mode === 'none' || targetRanges.length === 0) {
      resetNativeSkip();
      currentMode = 'none';
      return;
    }

    setNativeSkip(false);
    const start = seconds(targetRanges[0].start);
    seek(start);
    play();
  }

  function seekToStartWhenReady(startSec, onReady) {
    const video = getVideo();
    if (!video) {
      if (onReady) onReady();
      return;
    }
    // Video already loaded — seek immediately
    if (video.readyState >= 1 && video.duration) {
      seek(startSec);
      if (onReady) setTimeout(onReady, DOP_SEEK_READY_POLL_MS);
      return;
    }
    // Wait for loadedmetadata (fires ~300ms after navigation, duration guaranteed)
    const onMeta = function () {
      video.removeEventListener('loadedmetadata', onMeta);
      clearTimeout(fallback);
      seek(startSec);
      if (onReady) setTimeout(onReady, DOP_SEEK_READY_POLL_MS);
    };
    const fallback = setTimeout(function () {
      video.removeEventListener('loadedmetadata', onMeta);
      if (onReady) onReady();
    }, DOP_SEEK_READY_DEADLINE_MS);
    video.addEventListener('loadedmetadata', onMeta);
  }

  function startPlayback(playlist, realIndex, shuffledIndices, opts) {
    const item = playlist.items[realIndex];
    if (!item || !item.range) return;
    const isSameEpisode = !!(opts && opts.isSameEpisode);
    const si = isSameEpisode
      ? ((currentPlayback && currentPlayback.shuffledIndices) || shuffledIndices || null)
      : (shuffledIndices || null);
    const shufflePos = si ? si.indexOf(realIndex) : realIndex;
    currentPlayback = { playlistId: playlist.id, index: shufflePos >= 0 ? shufflePos : realIndex, item, shuffledIndices: si };
    dopSetPlayback({ playlistId: playlist.id, index: shufflePos >= 0 ? shufflePos : realIndex, shuffledIndices: si, updatedAt: Date.now() });
    targetRanges = buildRanges();
    seekCooldownUntil = Date.now() + DOP_SEEK_COOLDOWN_PLAYBACK_MS;
    lastActionTime = 0;
    log('startPlayback', { playlist: playlist.name, index: realIndex, type: item.range.type });

    if (targetRanges.length === 0) {
      currentPlayback = null;
      dopClearPlayback();
      updatePlaylistUI();
      return;
    }

    setNativeSkip(false);
    startupLockUntil = Date.now() + (isSameEpisode ? DOP_STARTUP_LOCK_ITEM_MS : DOP_STARTUP_LOCK_PLAYBACK_MS);
    updatePlaylistUI();
    updateSeekMarkers();

    const start = seconds(targetRanges[0].start);
    if (!isSameEpisode) pause();
    seekToStartWhenReady(start, () => play());
  }

  function playItemInCurrentVideo(playlist, realIndex, storedShuffledIndices) {
    startPlayback(playlist, realIndex, storedShuffledIndices, { isSameEpisode: true });
  }

  async function playPlaylistIndex(playlist, index, storedShuffledIndices) {
    const item = playlist.items[index];
    if (!item || !item.range) return;
    const currentPartId = new URLSearchParams(location.search).get('partId');
    if (currentPartId === item.partId) {
      playItemInCurrentVideo(playlist, index, storedShuffledIndices);
    } else {
      await goToPlaylistItem(playlist.id, index, item, storedShuffledIndices);
    }
  }

  async function advancePlayback(direction) {
    if (!currentPlayback) return false;
    const playlists = await dopGetPlaylists();
    const playlist = playlists.find((p) => p.id === currentPlayback.playlistId);
    if (!playlist) {
      await clearPlaylistState();
      return false;
    }
    const shuffled = currentPlayback.shuffledIndices;
    const maxCount = shuffled ? shuffled.length : playlist.items.length;
    const newShufflePos = currentPlayback.index + direction;
    if (newShufflePos < 0 || newShufflePos >= maxCount) {
      if (newShufflePos >= maxCount) {
        if (!currentPlayback._endPopupShown) {
          currentPlayback._endPopupShown = true;
          showEndOfPlaylistPopup(playlist);
        }
      } else {
        pause();
      }
      return false;
    }
    const realIndex = shuffled ? shuffled[newShufflePos] : newShufflePos;
    await playPlaylistIndex(playlist, realIndex);
    return true;
  }

  async function goToPlaylistItem(playlistId, realIndex, item, storedShuffledIndices) {
    const shuffled = (currentPlayback && currentPlayback.shuffledIndices) || storedShuffledIndices || null;
    const shufflePos = shuffled ? shuffled.indexOf(realIndex) : realIndex;
    await dopSetPlayback({ playlistId, index: shufflePos >= 0 ? shufflePos : realIndex, shuffledIndices: shuffled, updatedAt: Date.now() });
    const url = new URL(item.url);
    url.searchParams.set('dopPlaylistId', playlistId);
    url.searchParams.set('dopIndex', String(realIndex));
    browser.runtime.sendMessage({
      type: 'REQUEST_PLAYER',
      url: url.toString()
    });
  }

  function showEndOfPlaylistPopup(playlist) {
    pause();
    const content = document.createElement('div');
    content.style.textAlign = 'center';
    content.textContent = 'プレイリストの最後まで再生しました';

    showModal('再生終了', content, [
      { label: '最初から再生', value: 'restart' },
      { label: 'このまま継続', value: 'continue', primary: true },
      { label: 'モードを解除', value: 'close' }
    ]).then(async (value) => {
      if (value === 'restart') {
        await clearPlaylistState();
        startPlayback(playlist, 0);
      } else if (value === 'continue') {
        // 一時停止のまま、フラグはリセットしない（insideRange 到達時にリセット）
      } else {
        await clearPlaylistState();
      }
    });
  }

  async function handlePrevClick() {
    if (!currentPlayback) return;
    const video = getVideo();
    const start = seconds(currentPlayback.item.range.start);
    const now = Date.now();
    const nearStart = video && Math.abs(video.currentTime - start) < 1.0;
    const doubleClick = nearStart && (now - lastPrevClickTime < DOP_DOUBLE_CLICK_WINDOW_MS);

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
      rangeIndex: params.has('dopRangeIndex') ? parseInt(params.get('dopRangeIndex'), 10) : null,
      title: params.get('dopTitle') || '',
      episodeTitle: params.get('dopEpisodeTitle') || '',
      playlistId: params.get('dopPlaylistId'),
      index: params.has('dopIndex') ? parseInt(params.get('dopIndex'), 10) : null
    };
  }

  function removeDopParamsFromUrl(href) {
    const url = new URL(href);
    ['dopRangeIndex', 'dopTitle', 'dopEpisodeTitle', 'dopPlaylistId', 'dopIndex'].forEach((k) => url.searchParams.delete(k));
    return url.toString();
  }

  async function checkUrlParams() {
    const params = readUrlParams();

    if (params.playlistId && params.index !== null) {
      const playlists = await dopGetPlaylists();
      const playlist = playlists.find((p) => p.id === params.playlistId);
      if (playlist && params.index >= 0 && params.index < playlist.items.length) {
        history.replaceState(null, '', removeDopParamsFromUrl(location.href));
        const stored = await dopGetPlayback();
        const shuffledIndices = (stored && stored.playlistId === params.playlistId)
          ? stored.shuffledIndices || null : null;
        startPlayback(playlist, params.index, shuffledIndices);
        return;
      }
    }

    if (params.rangeIndex !== null) {
      history.replaceState(null, '', removeDopParamsFromUrl(location.href));
      await startWorkPageRange(params.rangeIndex);
    }
  }

  async function enterOpEdMode(startIndex = 0) {
    const video = getVideo();
    const durationSec = video && video.duration ? video.duration : Infinity;
    const none = getNoneRanges(durationSec);
    if (none.length === 0) return false;
    const index = Math.max(0, Math.min(startIndex, none.length - 1));

    currentPlayback = null;
    currentMode = 'op-ed';
    targetRanges = none.map((c) => ({ start: c.start, end: c.end, name: c.name }));
    setNativeSkip(false);
    updatePlaylistUI();
    await updateSeekMarkers();

    const start = seconds(none[index].start);
    pause();
    seekToStartWhenReady(start, () => play());
    return true;
  }

  async function startWorkPageRange(rangeIndex) {
    const video = getVideo();
    const durationSec = video && video.duration ? video.duration : Infinity;
    const none = getNoneRanges(durationSec);
    if (none.length === 0) {
      showModal('エラー', 'この話にはOP/ED情報が見つかりませんでした。', [{ label: 'OK', value: null, primary: true }]);
      return;
    }
    if (rangeIndex < 0 || rangeIndex >= none.length) {
      showModal('エラー', '指定した区間が見つかりませんでした。', [{ label: 'OK', value: null, primary: true }]);
      return;
    }

    await clearPlaylistState();
    await dopSetOpEdMode(true);
    await enterOpEdMode(rangeIndex);
  }

  function log(label, data) {
    if (!DEBUG) return;
    console.log('[d-op]', label, data);
  }

  function insideRange(t) {
    for (const r of targetRanges) {
      if (t >= seconds(r.start) - DOP_RANGE_TOLERANCE_SEC && t <= seconds(r.end) + DOP_RANGE_TOLERANCE_SEC) {
        return true;
      }
    }
    return false;
  }

  function enforceRanges() {
    if ((currentMode === 'none' && !currentPlayback) || targetRanges.length === 0) return;
    if (Date.now() < seekCooldownUntil) return;

    const video = getVideo();
    if (!video) return;

    const t = video.currentTime;
    const firstStart = seconds(targetRanges[0].start);
    const lastEnd = seconds(targetRanges[targetRanges.length - 1].end);
    const duration = video.duration || Infinity;

    if (insideRange(t)) {
      if (currentPlayback && currentPlayback._endPopupShown) {
        currentPlayback._endPopupShown = false;
      }
      return;
    }

    const now = Date.now();
    if (now - lastActionTime < DOP_ENFORCE_MIN_GAP_MS) return;
    lastActionTime = now;

    log('out of range', { t, firstStart, lastEnd });

    if (t < firstStart) {
      seek(firstStart);
      return;
    }

    if (t > lastEnd || video.ended) {
      if (currentPlayback) {
        pause();
        advancePlayback(1);
      } else if (currentMode !== 'op-ed') {
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
    enforceRanges();

    const video = getVideo();
    if (currentPlayback && video && Date.now() < startupLockUntil) {
      const start = seconds(targetRanges[0].start);
      if (Math.abs(video.currentTime - start) > 1.0) {
        seek(start);
      }
    }
  }

  function onSeeking() {
    seekCooldownUntil = Date.now() + DOP_SEEK_COOLDOWN_SEEKING_MS;
  }

  function onSeeked() {
    seekCooldownUntil = Date.now() + DOP_SEEK_COOLDOWN_SEEKED_MS;
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
      popup.id = 'd-op-add-popup';
      popup.className = 'd-op-popup';

      wrapper.appendChild(btn);
      wrapper.appendChild(popup);

      let popupHideTimer = null;

      const showPopup = () => {
        if (popupHideTimer) {
          clearTimeout(popupHideTimer);
          popupHideTimer = null;
        }
        popup.classList.add('d-op-popup-visible');
      };

      const scheduleHidePopup = () => {
        popupHideTimer = setTimeout(() => {
          popup.classList.remove('d-op-popup-visible');
        }, DOP_POPUP_HIDE_DELAY_MS);
      };

      wrapper.addEventListener('mouseenter', showPopup);
      wrapper.addEventListener('mouseleave', scheduleHidePopup);
      popup.addEventListener('mouseenter', showPopup);
      popup.addEventListener('mouseleave', scheduleHidePopup);
    }

    const popup = wrapper.querySelector('.d-op-popup');
    const currentPartId = chaptersInfo ? chaptersInfo.partId : null;
    const shouldRebuildPopup = popup && currentPartId &&
      (wrapper.dataset.dopPopupPartId !== currentPartId || !wrapper.dataset.dopPopupBuilt);
    if (shouldRebuildPopup) {
      popup.innerHTML = '';
      const video = getVideo();
      const durationSec = video && video.duration ? video.duration : Infinity;
      const ranges = getNoneRanges(durationSec);
      if (ranges.length === 0) {
        popup.appendChild(createPopupRow('スキップ区間なし', () => {}));
      } else {
        ranges.forEach((r) => {
          const label = `${r.name} (${formatTime(seconds(r.start))}-${formatTime(seconds(r.end))})`;
          popup.appendChild(createPopupRow(`${label} を追加`, () => openPlaylistModal(r.name, r)));
        });
      }
      popup.appendChild(createPopupRow('カスタム範囲', () => showCustomRangeBar()));
      wrapper.dataset.dopPopupPartId = currentPartId;
      wrapper.dataset.dopPopupBuilt = 'true';
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

      const nativePrev = document.querySelector('.buttonArea .prev');
      const nativeNext = document.querySelector('.buttonArea .next');

      if (nativePrev && nativePrev.parentNode) {
        if (prevWrapper.parentNode !== nativePrev.parentNode) {
          nativePrev.parentNode.insertBefore(prevWrapper, nativePrev);
        }
      }
      if (nativeNext && nativeNext.parentNode) {
        if (nextWrapper.parentNode !== nativeNext.parentNode) {
          nativeNext.parentNode.insertBefore(nextWrapper, nativeNext.nextSibling);
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
      document.body.classList.remove('d-op-skip-hidden');
      prevWrapper.style.display = 'none';
      nextWrapper.style.display = 'none';
      hideTopRightPanel();
      return;
    }

    if (currentPlayback) {
      document.body.classList.add('d-op-playlist-active');
      document.body.classList.add('d-op-skip-hidden');
      prevWrapper.style.display = 'inline-flex';
      nextWrapper.style.display = 'inline-flex';
      prevBtn.disabled = currentPlayback.index <= 0;
      nextBtn.disabled = true;
      dopGetPlaylists().then((playlists) => {
        const playlist = playlists.find((p) => p.id === currentPlayback.playlistId);
        if (playlist) {
          const maxCount = currentPlayback.shuffledIndices
            ? currentPlayback.shuffledIndices.length
            : playlist.items.length;
          nextBtn.disabled = currentPlayback.index >= maxCount - 1;
        }
      });
    } else {
      document.body.classList.remove('d-op-playlist-active');
      document.body.classList.add('d-op-skip-hidden');
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
    }, DOP_PANEL_HIDE_DELAY_MS);
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
    let sub = currentPlayback && currentPlayback.shuffledIndices ? 'SHUFFLE - プレイリスト再生中' : 'プレイリスト再生中';
    let meta = '';
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

    const metaText = document.createElement('div');
    metaText.className = 'd-op-top-meta';

    const stopBtn = document.createElement('button');
    stopBtn.textContent = '解除';
    stopBtn.title = 'プレイリスト再生を解除';
    stopBtn.addEventListener('click', () => {
      clearPlaylistState();
    });

    const contentWrap = document.createElement('div');
    contentWrap.className = 'd-op-top-content';
    contentWrap.appendChild(modeText);
    contentWrap.appendChild(subText);
    contentWrap.appendChild(metaText);

    panel.appendChild(contentWrap);
    panel.appendChild(stopBtn);

    if (currentPlayback) {
      dopGetPlaylists().then((playlists) => {
        const playlist = playlists.find((p) => p.id === currentPlayback.playlistId);
        if (playlist) {
          subText.textContent = playlist.name;
          const maxCount = currentPlayback.shuffledIndices
            ? currentPlayback.shuffledIndices.length
            : playlist.items.length;
          metaText.textContent = `${currentPlayback.index + 1} / ${maxCount}`;
        }
      });
    }
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

  async function getSeekRanges(durationSec) {
    const ranges = [];
    const none = getNoneRanges(durationSec);
    ranges.push(...none.map((c) => ({ ...c, label: c.name })));

    if (currentPlayback && currentPlayback.item) {
      const playlists = await dopGetPlaylists();
      const playlist = playlists.find((p) => p.id === currentPlayback.playlistId);
      if (playlist) {
        const currentPartId = currentPlayback.item.partId;
        playlist.items.forEach((item) => {
          if (item.partId === currentPartId && item.range) {
            const r = item.range;
            const label = r.name || '範囲';
            const dup = ranges.some((c) => c.start === r.start && c.end === r.end);
            if (!dup) ranges.push({ ...r, label });
          }
        });
      } else if (currentPlayback.item.range) {
        const r = currentPlayback.item.range;
        const label = r.name || '範囲';
        const dup = ranges.some((c) => c.start === r.start && c.end === r.end);
        if (!dup) ranges.push({ ...r, label });
      }
    }

    if (currentMode === 'custom-test' || customSelecting) {
      if (targetRanges.length > 0) {
        const r = targetRanges[0];
        const label = customName || 'CUSTOM';
        const dup = ranges.some((c) => c.start === r.start && c.end === r.end);
        if (!dup) ranges.push({ ...r, label });
      } else if (customSelecting) {
        const label = customName || 'CUSTOM';
        if (customStart !== null && customEnd !== null && customStart < customEnd) {
          const r = { start: customStart, end: customEnd };
          const dup = ranges.some((c) => c.start === r.start && c.end === r.end);
          if (!dup) ranges.push({ ...r, label });
        } else if (customStart !== null || customEnd !== null) {
          const point = customStart !== null ? customStart : customEnd;
          const dup = ranges.some((c) => c.start === point && c.end === point);
          if (!dup) ranges.push({ start: point, end: point, label });
        }
      }
    }

    if (chaptersInfo && chaptersInfo.partId) {
      const playlists = await dopGetPlaylists();
      playlists.forEach((playlist) => {
        playlist.items.forEach((item) => {
          if (item.partId === chaptersInfo.partId && item.range) {
            const dup = ranges.some((c) => c.start === item.range.start && c.end === item.range.end);
            if (!dup) {
              const r = item.range;
              const label = r.name || '範囲';
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
      if (timeSec >= start - DOP_RANGE_TOLERANCE_SEC && timeSec <= end + DOP_RANGE_TOLERANCE_SEC) return r;
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

  function scheduleUpdateSeekMarkers() {
    if (seekMarkerDebounceTimer) clearTimeout(seekMarkerDebounceTimer);
    seekMarkerDebounceTimer = setTimeout(() => runUpdateSeekMarkers(), DOP_SEEK_MARKER_DEBOUNCE_MS);
  }

  async function runUpdateSeekMarkers() {
    const video = getVideo();
    const seekArea = document.querySelector('.seekArea');
    if (!video || !seekArea || !video.duration) return;

    let container = document.getElementById('d-op-seek-markers');
    if (!container) {
      container = document.createElement('div');
      container.id = 'd-op-seek-markers';
      container.className = 'd-op-seek-markers';
    }
    const seekThumb = seekArea.querySelector('#seekThumb');
    if (seekThumb && seekThumb.previousSibling !== container) {
      seekArea.insertBefore(container, seekThumb);
    } else if (!seekThumb && container.parentNode !== seekArea) {
      seekArea.appendChild(container);
    }

    container.innerHTML = '';
    const duration = video.duration;
    const ranges = await getSeekRanges(duration);
    currentSeekRanges = ranges;
    const canSeekColor = currentMode === 'op-ed' || currentMode === 'custom-test' || customSelecting || !!currentPlayback;

    ranges.forEach((r) => {
      const start = seconds(r.start);
      const end = seconds(r.end);
      if (start >= duration || end <= 0) return;
      const left = Math.max(0, start / duration * 100);
      const width = Math.max(0, Math.min(100 - left, (end - start) / duration * 100));

      const marker = document.createElement('div');
      marker.className = 'd-op-seek-marker';
      marker.style.left = left + '%';
      if (width > 0) {
        marker.style.width = width + '%';
      } else {
        marker.classList.add('point');
      }
      marker.title = `${r.label}: ${formatTime(start)}-${formatTime(end)}`;
      if (canSeekColor) {
        if (r.label === 'OP') marker.classList.add('op');
        if (r.label === 'ED') marker.classList.add('ed');
        if (r.label === 'イントロ' || r.label === 'CUSTOM') marker.classList.add('custom');
        if (currentPlayback && currentPlayback.item && currentPlayback.item.range) {
          const cr = currentPlayback.item.range;
          if (r.start === cr.start && r.end === cr.end) {
            marker.classList.add('active');
          }
        }
      }
      container.appendChild(marker);
    });

    attachSeekPopupListener();
  }

  function updateSeekMarkers() {
    scheduleUpdateSeekMarkers();
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
      const onKey = (e) => {
        if (e.key === 'Escape') {
          modal.remove();
          resolve(null);
          document.removeEventListener('keydown', onKey);
        }
      };
      document.addEventListener('keydown', onKey);
      document.body.appendChild(modal);
    });
  }

  async function openPlaylistModal(defaultName, range) {
    const playlists = (await dopGetPlaylists()).filter((p) => !isSystemPlaylist(p));

    const list = document.createElement('div');
    list.className = 'd-op-modal-playlist-list';
    let selectedId = null;

    if (playlists.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--dop-text-tertiary);font-size:13px;padding:var(--dop-space-3) 0;';
      empty.textContent = 'プレイリストがありません。以下から新規作成してください。';
      list.appendChild(empty);
    }

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

    const nameRow = document.createElement('div');
    nameRow.className = 'd-op-modal-new-row';
    nameRow.style.marginTop = '10px';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = '区間名';
    nameInput.value = defaultName || '';
    nameRow.appendChild(nameInput);

    const content = document.createElement('div');
    content.appendChild(list);
    content.appendChild(newRow);
    content.appendChild(nameRow);

    const result = await showModal('プレイリストに追加', content, [
      { label: 'キャンセル', value: null },
      { label: '追加', value: 'add', primary: true }
    ]);

    if (result !== 'add') return;

    const playlistName = newInput.value.trim();

    if (!selectedId && !playlistName) {
      await showModal('エラー', 'プレイリストを選択するか、新規プレイリスト名を入力してください。', [{ label: 'OK', value: null, primary: true }]);
      await openPlaylistModal(defaultName, range);
      return;
    }

    const itemName = nameInput.value.trim() || defaultName || '範囲';
    const rangeToAdd = { start: range.start, end: range.end, name: itemName };

    if (selectedId) {
      await addCurrentRangeToPlaylist(selectedId, rangeToAdd);
      return;
    }

    if (playlistName) {
      const playlist = await dopCreatePlaylist(playlistName);
      await addCurrentRangeToPlaylist(playlist.id, rangeToAdd);
    }
  }

  function isSystemPlaylist(playlist) {
    return typeof playlist.name === 'string' && playlist.name.startsWith('__dop_');
  }

  async function showCustomRangeBar() {
    if (currentMode !== 'none' || currentPlayback) {
      const value = await showModal(
        '再生モードを解除',
        'カスタム範囲を選択するには、現在の再生モードを解除してください。',
        [
          { label: 'キャンセル', value: 'cancel' },
          { label: '解除して続行', value: 'ok', primary: true }
        ]
      );
      if (value !== 'ok') return;
      await clearPlaylistState();
    }

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
      if (customStart === null || customEnd === null) return;
      if (customStart >= customEnd) {
        showModal('エラー', '開始地点は終了地点より前に設定してください。', [{ label: 'OK', value: null, primary: true }]);
        return;
      }
      currentMode = 'custom-test';
      targetRanges = [{ start: customStart, end: customEnd }];
      setNativeSkip(false);
      updateSeekMarkers();
      seek(seconds(customStart));
      play();
    });

    const addBtn = document.createElement('button');
    addBtn.textContent = '追加';
    addBtn.className = 'primary';
    addBtn.addEventListener('click', async () => {
      if (customStart === null || customEnd === null) return;
      if (customStart >= customEnd) {
        showModal('エラー', '開始地点は終了地点より前に設定してください。', [{ label: 'OK', value: null, primary: true }]);
        return;
      }
      const range = {
        start: customStart,
        end: customEnd,
        name: customName || 'CUSTOM'
      };
      await openPlaylistModal(range.name, range);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.addEventListener('click', () => {
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

  async function addCurrentRangeToPlaylist(playlistId, range) {
    const data = chaptersInfo;
    if (!data || !range) return;

    const page = getPlayerPageInfo();

    const item = {
      partId: data.partId,
      workId: data.workId || '',
      title: data.workTitle || page.workTitle || '',
      episodeTitle: data.partTitle || page.episodeTitle || '',
      episodeNumber: data.partDispNumber || page.episodeNumber || '',
      url: location.href,
      range
    };

    await dopAddItemToPlaylist(playlistId, item);

    customStart = null;
    customEnd = null;
    customName = '';
    customSelecting = false;
    if (currentMode === 'custom-test') {
      currentMode = 'none';
      targetRanges = [];
      resetNativeSkip();
    }
    const bar = document.getElementById('d-op-custom-bar');
    if (bar) bar.remove();
    await updateSeekMarkers();

    await showModal('追加完了', 'プレイリストに追加しました。', [{ label: 'OK', value: null, primary: true }]);
  }

  async function resumePlaybackIfAny() {
    if (currentPlayback) return;
    if (currentMode !== 'none') return;
    if (readUrlParams().rangeIndex !== null || readUrlParams().playlistId) return;

    const playback = await dopGetPlayback();
    if (!playback) return;
    if (playback.updatedAt && Date.now() - playback.updatedAt > DOP_RESUME_MAX_AGE_MS) {
      await dopClearPlayback();
      return;
    }

    const playlists = await dopGetPlaylists();
    const playlist = playlists.find((p) => p.id === playback.playlistId);
    if (!playlist) {
      await dopClearPlayback();
      return;
    }
    const realIndex = dopResolvePlaybackIndex(playback);
    if (realIndex === null || realIndex >= playlist.items.length) {
      await dopClearPlayback();
      return;
    }
    const item = playlist.items[realIndex];
    const currentPartId = new URLSearchParams(location.search).get('partId');
    if (currentPartId !== item.partId) {
      await goToPlaylistItem(playlist.id, realIndex, item);
      return;
    }
    startPlayback(playlist, realIndex, playback.shuffledIndices);
  }

  async function jumpToPlaylistIndex(index) {
    const playback = await dopGetPlayback();
    if (!playback) return;
    const playlists = await dopGetPlaylists();
    const playlist = playlists.find((p) => p.id === playback.playlistId);
    if (!playlist) return;
    const realIndex = playback.shuffledIndices
      ? playback.shuffledIndices[index]
      : index;
    if (realIndex < 0 || realIndex >= playlist.items.length) return;
    await playPlaylistIndex(playlist, realIndex, playback.shuffledIndices);
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
        if (message.payload && message.payload.index !== undefined) {
          jumpToPlaylistIndex(message.payload.index);
        }
        break;
    }
  }

  async function handleChapters(info) {
    const partIdChanged = chaptersInfo === null || chaptersInfo.partId !== info.partId;
    chaptersInfo = info;

    if (partIdChanged) {
      lastPartId = info.partId;
      if (!currentPlayback && currentMode !== 'op-ed') {
        currentMode = 'none';
        targetRanges = [];
        resetNativeSkip();
      } else if (!currentPlayback && currentMode === 'op-ed') {
        await enterOpEdMode(0);
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

    if (currentMode === 'none' && !currentPlayback) {
      const opEdMode = await dopGetOpEdMode();
      if (opEdMode && opEdMode.active) {
        if (Date.now() - opEdMode.updatedAt < DOP_OPED_MODE_MAX_AGE_MS) {
          await enterOpEdMode(0);
        } else {
          await dopSetOpEdMode(false);
        }
      }
    }
  }

  function init() {
    if (window.__dOpInitialized) return;
    window.__dOpInitialized = true;

    injectPageScript();

    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin) return;
      const msg = event.data;
      if (!msg || msg.source !== APP_TAG) return;
      if (msg.type === 'CHAPTERS_FOUND') {
        handleChapters(msg.payload);
      }
    });

    browser.runtime.onMessage.addListener((message) => {
      handleRuntimeMessage(message);
    });

    window.addEventListener('beforeunload', () => {
      dopClearPending();
    });

    document.addEventListener('mousemove', onMouseMove);

    // Block Home/End/Arrow keys when input/textarea/contenteditable is focused
    // (prevent d-Anime player from capturing them)
    document.addEventListener('focusin', (e) => {
      isInputFocused = isEditableElement(e.target);
    });

    document.addEventListener('focusout', () => {
      setTimeout(() => {
        isInputFocused = isEditableElement(document.activeElement);
      }, 0);
    });

    document.addEventListener('keydown', (e) => {
      if (!isInputFocused) return;
      const blockedKeys = ['Home', 'End', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'];
      if (blockedKeys.includes(e.key)) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }, true);

    const observer = new MutationObserver(() => {
      observer.disconnect();
      try {
        const video = getVideo();
        if (video && attachedVideo !== video) {
          attachVideoListener();
          updateSeekMarkers();
        }
        createAddButton();
        createPlaylistControls();
      } finally {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
