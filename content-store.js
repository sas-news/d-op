(function () {
  'use strict';

  function findPartId(element) {
    const link = element.querySelector('a[href*="partId="]');
    if (!link) return null;
    const url = new URL(link.href, location.origin);
    return url.searchParams.get('partId');
  }

  function findWorkTitle() {
    const titleEl = document.querySelector('h1, .workTitle, .title, [class*="Title"]');
    return titleEl ? titleEl.textContent.trim() : '';
  }

  function findEpisodeTitle(element) {
    const titleEl = element.querySelector('.title, .episodeTitle, h3, .itemTitle');
    return titleEl ? titleEl.textContent.trim() : '';
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function seconds(ms) {
    return ms / 1000;
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function guessRangeName(chapter, index, total, durationMs) {
    const durationSec = durationMs ? durationMs / 1000 : Infinity;
    const startSec = seconds(chapter.start);
    const endSec = seconds(chapter.end);
    const lenSec = endSec - startSec;
    const nearStart = startSec < 180;
    const veryStart = startSec < 15;
    const nearEnd = durationSec - endSec < 300;
    const opEdDuration = lenSec >= 75 && lenSec <= 105;
    const introDuration = lenSec < 15;

    const used = new Set();
    const makeName = (candidate) => {
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
      return `パート${index + 1}`;
    };

    if (total === 1) {
      if (opEdDuration && nearStart) return makeName('OP');
      if (introDuration && veryStart) return makeName('イントロ');
      return `パート1`;
    }

    if (total === 2) {
      if (index === 0) {
        if (opEdDuration && nearStart) return makeName('OP');
        if (introDuration && veryStart) return makeName('イントロ');
        return `パート1`;
      }
      if (opEdDuration && nearEnd) return makeName('ED');
      if (introDuration && veryStart) return makeName('イントロ');
      return `パート2`;
    }

    if (index === 0 && introDuration && veryStart) return makeName('イントロ');
    if (index === total - 1 && opEdDuration && nearEnd) return makeName('ED');
    if (index > 0 && index < total - 1 && opEdDuration && nearStart) return makeName('OP');
    return `パート${index + 1}`;
  }

  async function fetchChapters(partId) {
    try {
      const url = `https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=${encodeURIComponent(partId)}`;
      const resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) return null;
      const text = await resp.text();

      const chapterMatch = text.match(/"chapters"\s*:\s*(\[[^\]]*\])/);
      if (!chapterMatch) return null;
      const chapters = JSON.parse(chapterMatch[1]);

      const durMatch = text.match(/"duration"\s*:\s*(\d+)/);
      const duration = durMatch ? parseInt(durMatch[1], 10) : null;

      return { chapters, duration };
    } catch (err) {
      console.error('[d-op store] fetchChapters failed', err);
      return null;
    }
  }

  function playEpisode(partId, rangeIndex, episodeTitle) {
    try {
      const workTitle = findWorkTitle();
      const params = new URLSearchParams();
      params.set('partId', partId);
      params.set('dopRangeIndex', String(rangeIndex));
      params.set('dopTitle', workTitle);
      params.set('dopEpisodeTitle', episodeTitle);
      const url = `https://animestore.docomo.ne.jp/animestore/sc_d_pc?${params.toString()}`;
      chrome.runtime.sendMessage({
        type: 'OPEN_PLAYER',
        url: url,
        closeCurrentWindow: false
      });
    } catch (err) {
      console.error('[d-op store] playEpisode failed', err);
      showError('再生の準備に失敗しました: ' + err.message);
    }
  }

  function showRangeMenu(item, chapters, duration, episodeTitle, anchor) {
    const existing = document.getElementById('d-op-store-range-menu');
    if (existing) existing.remove();

    const none = chapters
      .filter((c) => c.type === 'none')
      .slice()
      .sort((a, b) => a.start - b.start);

    const menu = document.createElement('div');
    menu.id = 'd-op-store-range-menu';
    menu.className = 'd-op-store-range-menu';

    if (none.length === 0) {
      const row = document.createElement('div');
      row.className = 'd-op-store-range-item d-op-store-range-disabled';
      row.textContent = 'スキップ区間なし';
      menu.appendChild(row);
    } else {
      none.forEach((c, i) => {
        const name = guessRangeName(c, i, none.length, duration);
        const row = document.createElement('div');
        row.className = 'd-op-store-range-item';
        row.textContent = `${name} (${formatTime(seconds(c.start))}-${formatTime(seconds(c.end))})`;
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          menu.remove();
          playEpisode(findPartId(item), i, episodeTitle);
        });
        menu.appendChild(row);
      });
    }

    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
    menu.style.left = `${rect.left + window.scrollX}px`;

    const close = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  function showError(message) {
    let modal = document.getElementById('d-op-store-modal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'd-op-store-modal';
    modal.className = 'd-op-store-modal';

    const panel = document.createElement('div');
    panel.className = 'd-op-store-modal-panel';

    const title = document.createElement('h3');
    title.textContent = 'エラー';

    const body = document.createElement('p');
    body.textContent = message;

    const footer = document.createElement('div');
    footer.className = 'd-op-store-modal-footer';

    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    okBtn.addEventListener('click', () => modal.remove());
    footer.appendChild(okBtn);

    const closeOnEsc = (e) => {
      if (e.key === 'Escape') {
        modal.remove();
        document.removeEventListener('keydown', closeOnEsc);
      }
    };
    document.addEventListener('keydown', closeOnEsc);

    panel.appendChild(title);
    panel.appendChild(body);
    panel.appendChild(footer);
    modal.appendChild(panel);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
    document.body.appendChild(modal);
  }

  function decorateItems() {
    const items = document.querySelectorAll('.itemModule, .itemList > li, .seriesEpisodeList > li, [class*="Episode"]');
    items.forEach((item) => {
      if (item.dataset.dopDecorated) return;
      const partId = findPartId(item);
      if (!partId) return;
      const episodeTitle = findEpisodeTitle(item);

      const controls = document.createElement('div');
      controls.className = 'd-op-store-controls';

      const btn = document.createElement('button');
      btn.className = 'd-op-store-btn';
      btn.textContent = 'OP/ED';
      btn.title = 'スキップ区間を選択して再生';
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.disabled) return;
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.innerHTML = '<span class="d-op-spinner"></span>読込';
        try {
          const data = await fetchChapters(partId);
          if (data && data.chapters && data.chapters.length > 0) {
            showRangeMenu(item, data.chapters, data.duration, episodeTitle, btn);
          } else {
            playEpisode(partId, 0, episodeTitle);
          }
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });

      controls.appendChild(btn);
      item.style.position = 'relative';
      item.appendChild(controls);
      item.dataset.dopDecorated = 'true';
    });
  }

  function init() {
    if (window.__dOpStoreInitialized) return;
    window.__dOpStoreInitialized = true;

    decorateItems();
    const observer = new MutationObserver(debounce(decorateItems, 300));
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function debounce(fn, wait) {
    let timer = null;
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, wait);
    };
  }

  init();
})();
