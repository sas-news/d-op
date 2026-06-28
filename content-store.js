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

  function playEpisode(partId, rangeType, episodeTitle) {
    try {
      const workTitle = findWorkTitle();
      const params = new URLSearchParams();
      params.set('partId', partId);
      params.set('dopRangeType', rangeType);
      params.set('dopTitle', workTitle);
      params.set('dopEpisodeTitle', episodeTitle);
      const url = `https://animestore.docomo.ne.jp/animestore/sc_d_pc?${params.toString()}`;
      const newTab = window.open(url, '_blank');
      if (!newTab) {
        showError('ポップアップがブロックされました。');
      }
    } catch (err) {
      console.error('[d-op store] playEpisode failed', err);
      showError('再生の準備に失敗しました: ' + err.message);
    }
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

      const opBtn = document.createElement('button');
      opBtn.className = 'd-op-store-btn';
      opBtn.textContent = 'OP';
      opBtn.title = 'この話のOPを再生';
      opBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        playEpisode(partId, 'op', episodeTitle);
      });

      const edBtn = document.createElement('button');
      edBtn.className = 'd-op-store-btn';
      edBtn.textContent = 'ED';
      edBtn.title = 'この話のEDを再生';
      edBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        playEpisode(partId, 'ed', episodeTitle);
      });

      controls.appendChild(opBtn);
      controls.appendChild(edBtn);
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
