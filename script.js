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

  const SHARE_TEXT = "dアニメストアのOP/EDを連続再生できるブラウザ拡張機能「d-OP」が便利すぎる。プレイリストも作れる。";
  const SHARE_HASHTAGS = ["dアニメストア", "dアニメ", "ブラウザ拡張"];
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
    return "https://twitter.com/intent/tweet?" + params.toString();
  }

  /**
   * クリックハンドラ: ポップアップブロックを回避するため
   * ユーザー操作の中で同期的に window.open する。
   * @param {MouseEvent} event
   */
  function onShareClick(event) {
    event.preventDefault();
    const url = buildShareUrl();
    const win = window.open(url, "_blank", "noopener,noreferrer,width=600,height=560");
    if (!win) {
      // ポップアップブロックされた場合は現在のタブで遷移
      window.location.href = url;
    }
  }

  function bindShare() {
    const btn = document.getElementById("shareBtn");
    if (!btn) return;
    btn.addEventListener("click", onShareClick);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindShare, { once: true });
  } else {
    bindShare();
  }
})();