(function () {
  'use strict';

  const APP_TAG = 'd-op-injected';
  const STORAGE_KEY = 'd-op-state';

  const Mode = {
    NONE: 'none',
    OP_ONLY: 'op-only',
    ED_ONLY: 'ed-only',
    OP_ED: 'op-ed'
  };

  let chaptersInfo = null;
  let targetRanges = [];
  let currentMode = Mode.NONE;
  let originalOpSkip = null;
  let uiRoot = null;

  function getVideo() {
    return document.getElementById('video');
  }

  function getCookieValue(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookieValue(name, value) {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; domain=${location.hostname}; SameSite=Lax`;
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

  function buildRanges() {
    const none = getNoneChapters();
    switch (currentMode) {
      case Mode.OP_ONLY:
        return none.length > 0 ? [none[0]] : [];
      case Mode.ED_ONLY:
        return none.length > 0 ? [none[none.length - 1]] : [];
      case Mode.OP_ED:
        return none.slice();
      default:
        return [];
    }
  }

  function saveState() {
    chrome.storage.session.set({
      [STORAGE_KEY]: { mode: currentMode, partId: chaptersInfo ? chaptersInfo.partId : null }
    });
  }

  function restoreState() {
    chrome.storage.session.get(STORAGE_KEY).then((res) => {
      const saved = res[STORAGE_KEY];
      if (saved && saved.mode && saved.mode !== Mode.NONE) {
        activateMode(saved.mode);
      }
    });
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

  function seek(timeSec) {
    const video = getVideo();
    if (!video) return false;
    video.currentTime = timeSec;
    return true;
  }

  function play() {
    const video = getVideo();
    if (video && video.paused) {
      video.play().catch(() => {});
    }
  }

  function pause() {
    const video = getVideo();
    if (video && !video.paused) {
      video.pause();
    }
  }

  function activateMode(mode) {
    currentMode = mode;
    targetRanges = buildRanges();
    saveState();

    if (mode === Mode.NONE) {
      resetNativeSkip();
      updateUI();
      return;
    }

    if (targetRanges.length === 0) {
      currentMode = Mode.NONE;
      updateUI();
      return;
    }

    setNativeSkip(false);
    seek(seconds(targetRanges[0].start));
    play();
    updateUI();
  }

  function findCurrentRangeIndex(currentTime) {
    for (let i = 0; i < targetRanges.length; i++) {
      const r = targetRanges[i];
      if (currentTime >= seconds(r.start) - 0.1 && currentTime <= seconds(r.end) + 0.1) {
        return i;
      }
    }
    return -1;
  }

  function onTimeUpdate() {
    if (currentMode === Mode.NONE || targetRanges.length === 0) return;

    const video = getVideo();
    if (!video) return;

    const t = video.currentTime;
    const firstStart = seconds(targetRanges[0].start);
    const lastEnd = seconds(targetRanges[targetRanges.length - 1].end);

    if (t < firstStart - 0.5) {
      seek(firstStart);
      return;
    }

    if (t > lastEnd + 0.5) {
      pause();
      return;
    }

    const idx = findCurrentRangeIndex(t);
    if (idx >= 0) {
      if (t > seconds(targetRanges[idx].end) - 0.5) {
        const next = targetRanges[idx + 1];
        if (next) {
          seek(seconds(next.start));
        } else {
          pause();
        }
      }
      return;
    }

    for (let i = 0; i < targetRanges.length; i++) {
      if (t < seconds(targetRanges[i].start)) {
        seek(seconds(targetRanges[i].start));
        return;
      }
    }
  }

  function attachVideoListener() {
    const video = getVideo();
    if (!video) return;
    video.removeEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('timeupdate', onTimeUpdate);
  }

  function createButton(label, mode, disabled) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.disabled = disabled;
    if (currentMode === mode) {
      btn.classList.add('active');
    }
    btn.addEventListener('click', () => {
      if (currentMode === mode) {
        activateMode(Mode.NONE);
      } else {
        activateMode(mode);
      }
    });
    return btn;
  }

  function updateUI() {
    if (!uiRoot) return;

    const none = getNoneChapters();
    const hasRanges = none.length > 0;

    const panel = document.createElement('div');
    panel.className = 'd-op-panel';

    const title = document.createElement('div');
    title.className = 'd-op-title';
    title.textContent = 'OPED Player';
    panel.appendChild(title);

    const status = document.createElement('div');
    status.className = 'd-op-status';
    if (!chaptersInfo) {
      status.textContent = 'チャプター情報を取得中...';
    } else if (!hasRanges) {
      status.textContent = 'OP/ED情報がありません';
    } else {
      const labels = none.map((c) => `${formatTime(seconds(c.start))}-${formatTime(seconds(c.end))}`).join(' / ');
      status.textContent = `検出: ${labels}`;
    }
    panel.appendChild(status);

    const buttons = document.createElement('div');
    buttons.className = 'd-op-buttons';

    buttons.appendChild(createButton('OPのみ', Mode.OP_ONLY, !hasRanges));
    buttons.appendChild(createButton('EDのみ', Mode.ED_ONLY, !hasRanges));
    buttons.appendChild(createButton('OP+ED', Mode.OP_ED, !hasRanges));

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'リセット';
    resetBtn.addEventListener('click', () => activateMode(Mode.NONE));
    buttons.appendChild(resetBtn);

    panel.appendChild(buttons);

    const modeLabel = document.createElement('div');
    modeLabel.className = 'd-op-mode';
    modeLabel.textContent = currentMode === Mode.NONE ? '通常再生中' : `モード: ${currentMode}`;
    panel.appendChild(modeLabel);

    uiRoot.replaceChildren(panel);
  }

  function createUI() {
    if (uiRoot) return;
    uiRoot = document.createElement('div');
    uiRoot.id = 'd-op-root';
    document.body.appendChild(uiRoot);
    updateUI();
  }

  function handleChapters(info) {
    chaptersInfo = info;
    attachVideoListener();
    createUI();
    updateUI();
    restoreState();
  }

  function init() {
    chrome.runtime.sendMessage({ type: 'INJECT_SCRIPT' });

    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin) return;
      const msg = event.data;
      if (!msg || msg.source !== APP_TAG) return;
      if (msg.type === 'CHAPTERS_FOUND') {
        handleChapters(msg.payload);
      }
    });

    const observer = new MutationObserver(() => {
      if (getVideo()) {
        attachVideoListener();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
