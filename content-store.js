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

  async function playEpisode(partId, rangeType) {
    const workTitle = findWorkTitle();
    const episodeTitle = findEpisodeTitle();
    const url = `https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=${partId}`;

    await dopSetPending({
      partId,
      rangeType,
      title: workTitle,
      episodeTitle,
      url
    });

    location.href = url;
  }

  function decorateItems() {
    const items = document.querySelectorAll('.itemModule, .itemList > li, .seriesEpisodeList > li, [class*="Episode"]');
    items.forEach((item) => {
      if (item.dataset.dopDecorated) return;
      const partId = findPartId(item);
      if (!partId) return;

      const controls = document.createElement('div');
      controls.className = 'd-op-store-controls';

      const opBtn = document.createElement('button');
      opBtn.className = 'd-op-store-btn';
      opBtn.textContent = 'OP';
      opBtn.title = 'この話のOPを再生';
      opBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        playEpisode(partId, 'op');
      });

      const edBtn = document.createElement('button');
      edBtn.className = 'd-op-store-btn';
      edBtn.textContent = 'ED';
      edBtn.title = 'この話のEDを再生';
      edBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        playEpisode(partId, 'ed');
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
