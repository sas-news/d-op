(function () {
  'use strict';

  const APP_TAG = 'd-op-injected';

  function send(type, payload) {
    window.postMessage({ source: APP_TAG, type, payload }, window.location.origin);
  }

  function extractChapters() {
    const data = window.vc && window.vc.ws010105Data;
    if (!data || !Array.isArray(data.chapters) || data.chapters.length === 0) {
      return null;
    }

    return {
      partId: data.partId || null,
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

  let found = false;
  let timer = null;
  let lastPartId = null;
  let lastUrl = location.href;

  function poll() {
    const info = extractChapters();
    if (info && info.partId !== lastPartId) {
      lastPartId = info.partId;
      send('CHAPTERS_FOUND', info);
      found = true;
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
      found = false;
      lastPartId = null;
      startPolling();
    }
  }).observe(document, { subtree: true, childList: true });
})();
