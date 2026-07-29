/**
 * d-OP ポータルサイト
 * クライアント側スクリプト
 *
 * 役割:
 *   1. X シェアボタン押下時に intent/tweet の URL を動的生成して別タブ起動
 *   2. (将来)マシュマロ埋め込みの遅延ロード — 現バージョンは静的リンクのみ
 *
 * 設計メモ:
 *   - ライブラリ・トラッキングは一切使わない
 *   - IIFE でグローバル汚染を避ける
 *   - DOMContentLoaded 後にバインド
 */
(function () {
  "use strict";

  const SHARE_TEXT = "d-OP | dアニメストアでOPだけ再生する拡張機能";
  const SHARE_HASHTAGS = [];
  const SHARE_URL = "https://d-op.sasnews.dev/";

  /**
   * X シェア用 URL を構築する。
   * @returns {string}
   */
  function buildShareUrl() {
    const params = new URLSearchParams();
    params.set("text", SHARE_TEXT);
    params.set("url", SHARE_URL);
    if (SHARE_HASHTAGS.length > 0) {
      params.set("hashtags", SHARE_HASHTAGS.join(","));
    }
    return "https://x.com/intent/post?" + params.toString();
  }

  /**
   * クリックハンドラ: 新しいタブで X の投稿画面を開く。
   * ポップアップがブロックされた場合は現在のタブには遷移しない
   * (元のページに留まる)。
   * @param {MouseEvent} event
   */
  function onShareClick(event) {
    event.preventDefault();
    const url = buildShareUrl();
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function bindShare() {
    const btn = document.getElementById("shareBtn");
    if (!btn) return;
    btn.addEventListener("click", onShareClick);
  }

  /**
   * ギャラリー + ライトボックス制御
   */
  const GALLERY_INTERVAL_MS = 4000;

  function initGallery(root) {
    const slides = Array.from(root.querySelectorAll('[data-slide]'));
    const thumbs = Array.from(root.querySelectorAll('[data-gallery-thumb]'));
    const prevBtn = root.querySelector('[data-gallery-prev]');
    const nextBtn = root.querySelector('[data-gallery-next]');
    if (slides.length === 0) return;

    let activeIndex = slides.findIndex((s) => s.classList.contains('is-active'));
    if (activeIndex < 0) activeIndex = 0;
    let timerId = null;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function show(next) {
      const n = slides.length;
      activeIndex = ((next % n) + n) % n;
      slides.forEach((slide, i) => slide.classList.toggle('is-active', i === activeIndex));
      thumbs.forEach((thumb, i) => {
        const on = i === activeIndex;
        thumb.classList.toggle('is-active', on);
        thumb.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    function startAuto() { stopAuto(); if (reduceMotion || slides.length < 2) return; timerId = window.setInterval(() => show(activeIndex + 1), GALLERY_INTERVAL_MS); }
    function stopAuto() { if (timerId !== null) { window.clearInterval(timerId); timerId = null; } }
    if (prevBtn) prevBtn.addEventListener('click', () => { show(activeIndex - 1); startAuto(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { show(activeIndex + 1); startAuto(); });
    thumbs.forEach((thumb, i) => thumb.addEventListener('click', () => { show(i); startAuto(); }));
    root.addEventListener('mouseenter', stopAuto);
    root.addEventListener('mouseleave', startAuto);
    root.addEventListener('focusin', stopAuto);
    root.addEventListener('focusout', startAuto);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); show(activeIndex - 1); startAuto(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); show(activeIndex + 1); startAuto(); }
    });
    root.querySelectorAll('[data-lightbox-trigger]').forEach((btn) => {
      btn.addEventListener('click', () => openLightbox(root, activeIndex));
    });
    show(activeIndex);
    startAuto();
  }

  let activeLightbox = null;

  function openLightbox(galleryRoot, startIndex) {
    if (activeLightbox) return;
    const slides = Array.from(galleryRoot.querySelectorAll('[data-slide]'));
    if (slides.length === 0) return;

    const overlay = document.createElement('div');
    overlay.className = 'lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '画像ビューア');

    const img = document.createElement('img');
    img.className = 'lightbox-img';
    img.alt = '';
    overlay.appendChild(img);

    const counter = document.createElement('div');
    counter.className = 'lightbox-counter';
    overlay.appendChild(counter);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'lightbox-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '閉じる');
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" focusable="false" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    overlay.appendChild(closeBtn);

    const prevBtn = document.createElement('button');
    prevBtn.className = 'lightbox-prev';
    prevBtn.type = 'button';
    prevBtn.setAttribute('aria-label', '前の画像');
    prevBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" focusable="false" aria-hidden="true"><path d="M15 4 L7 12 L15 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    overlay.appendChild(prevBtn);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'lightbox-next';
    nextBtn.type = 'button';
    nextBtn.setAttribute('aria-label', '次の画像');
    nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" focusable="false" aria-hidden="true"><path d="M9 4 L17 12 L9 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    overlay.appendChild(nextBtn);

    document.body.appendChild(overlay);
    document.body.classList.add('has-lightbox');

    let idx = ((startIndex % slides.length) + slides.length) % slides.length;
    function getImgSrc(i) { const im = slides[i] && slides[i].querySelector('img'); return im ? im.getAttribute('src') : ''; }
    function getImgAlt(i) { const im = slides[i] && slides[i].querySelector('img'); return im ? im.getAttribute('alt') : ''; }
    function render() { img.src = getImgSrc(idx); img.alt = getImgAlt(idx); counter.textContent = (idx + 1) + ' / ' + slides.length; }
    function close() { document.body.classList.remove('has-lightbox'); overlay.remove(); document.removeEventListener('keydown', onKey); activeLightbox = null; }
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') { idx = (idx - 1 + slides.length) % slides.length; render(); }
      else if (e.key === 'ArrowRight') { idx = (idx + 1) % slides.length; render(); }
    }
    closeBtn.addEventListener('click', close);
    prevBtn.addEventListener('click', () => { idx = (idx - 1 + slides.length) % slides.length; render(); });
    nextBtn.addEventListener('click', () => { idx = (idx + 1) % slides.length; render(); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    activeLightbox = { close };
    render();
    requestAnimationFrame(() => overlay.classList.add('is-open'));
  }

  function bindGallery() { document.querySelectorAll('[data-gallery]').forEach(initGallery); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { bindGallery(); bindShare(); }, { once: true });
  } else {
    bindGallery();
    bindShare();
  }
})();
