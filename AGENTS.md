# AGENTS.md — d-op ポータルサイト

`gh-pages` ブランチで配信される d-OP 拡張機能のポータルサイト。

## 構成

- 単一ページ構成。フレームワーク・ビルドステップは使わず、純粋な HTML + CSS + バニラ JS のみ
- 画像素材: `assets/` 配下に集約。拡張機能リポジトリの `assets/` から流用
- デザインシステム: 拡張機能本体の `styles.css` / `styles-store.css` と共通のトークン（黒ベース + d-OP レッド `#e60012`）

## 編集時の注意

- 拡張機能本体は `dev` ブランチで管理。**`gh-pages` には拡張機能のソースを絶対に混ぜない**
- マシュマロの `data-mallow-id` などのアカウント ID は `index.html` に直書き。更新時は ID を再確認する
- X シェア URL は `script.js` の `buildShareUrl()` で動的生成。シェア文言を変更する場合はここを編集
- OGP 画像 `assets/ogp.png` (1200x630) を更新したときは、Twitter/Facebook のクローラに反映されるまで最大 7 日かかる