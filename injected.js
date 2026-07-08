(function () {
  'use strict';

  const APP_TAG = 'd-op-injected';

  function send(type, payload) {
    window.postMessage({ source: APP_TAG, direction: 'from-page', type, payload }, window.location.origin);
  }

  function log(label, data) {
    console.log('[d-op injected]', label, data);
  }

  function getPlayer() {
    return window.vc && window.vc.videoEl ? window.vc.videoEl : document.getElementById('video');
  }

  function doSeek(timeSec) {
    if (window.vc && typeof window.vc.jump === 'function') {
      window.vc.jump(timeSec);
      log('vc.jump', timeSec);
      return;
    }
    const player = getPlayer();
    if (player) {
      player.currentTime = timeSec;
      log('direct seek', timeSec);
    }
  }

  function doPlay() {
    const player = getPlayer();
    if (player && player.paused) {
      player.play().catch((err) => log('play failed', err.message));
      log('play', {});
    }
  }

  function doPause() {
    const player = getPlayer();
    if (!player) return;
    let attempts = 0;
    const tryPause = () => {
      if (player.paused) {
        log('pause confirmed', {});
        return;
      }
      player.pause();
      attempts++;
      log('pause attempt', attempts);
      if (attempts < 10) {
        setTimeout(tryPause, 100);
      }
    };
    tryPause();
  }

  function extractChapters() {
    const data = window.vc && window.vc.ws010105Data;
    if (!data || !Array.isArray(data.chapters) || data.chapters.length === 0) {
      return null;
    }

    return {
      partId: data.partId || null,
      workTitle: data.workTitle || null,
      partTitle: data.partTitle || null,
      partDispNumber: (data.partDispNumber && data.partDispNumber !== '�@') ? data.partDispNumber : null,
      title: data.workTitle || data.partTitle || null,
      duration: data.duration || null,
      chapters: data.chapters.map((c, index) => ({
        index,
        start: c.start,
        end: c.end,
        type: c.type,
        showInterface: c.showInterface
      })),
      skipWaitTime: data.skipWaitTime,
      minTimeToSkip: data.minTimeToSkip
    };
  }

  let timer = null;
  let lastPartId = null;
  let lastUrl = location.href;

  function poll() {
    const info = extractChapters();
    if (info && info.partId !== lastPartId) {
      lastPartId = info.partId;
      send('CHAPTERS_FOUND', info);
      log('chapters sent', { partId: info.partId, count: info.chapters.length });
      stopPolling();
    }
  }

  function startPolling() {
    if (timer) return;
    timer = setInterval(poll, 500);
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  if (!extractChapters()) {
    startPolling();
  } else {
    poll();
  }

  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastPartId = null;
      startPolling();
    }
  }).observe(document, { subtree: true, childList: true });

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== APP_TAG || msg.direction !== 'to-page') return;

    switch (msg.type) {
      case 'SEEK':
        doSeek(msg.payload && msg.payload.time);
        break;
      case 'PLAY':
        doPlay();
        break;
      case 'PAUSE':
        doPause();
        break;
    }
  });
})();
