(function () {
  'use strict';

  function findPartId(element) {
    const link = element.querySelector('a[href*="partId="]');
    if (!link) return null;
    const url = new URL(link.href, location.origin);
    return url.searchParams.get('partId');
  }

  function findWorkTitle() {
    const titleEl = document.querySelector('h1');
    return titleEl ? titleEl.textContent.trim() : '';
  }

  function findEpisodeTitle(element) {
    const titleEl = element.querySelector('h3');
    return titleEl ? titleEl.textContent.trim() : '';
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
      browser.runtime.sendMessage({
        type: 'REQUEST_PLAYER',
        url: url
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
        const name = guessRangeName(c, i, none.length, duration ? duration / 1000 : Infinity);
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

    menu.addEventListener('click', function (e) { e.stopPropagation(); });
    const close = function (e) {
      menu.remove();
      document.removeEventListener('click', close);
    };
    document.addEventListener('click', close);
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
    okBtn.focus();
  }

  function decorateItems() {
    const items = document.querySelectorAll('.itemModule');
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
    const observer = new MutationObserver(debounce(decorateItems, DOP_STORE_DEBOUNCE_MS));
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
