# d-op ポータルサイト

`d-op.sasnews.dev` で配信される、d-Anime Store 向けブラウザ拡張機能 **d-OP** の
公式ポータルサイトのソースです。GitHub Pages の `gh-pages` ブランチから配信されます。

## 公開方法

- 配信元ブランチ: `gh-pages` のみ
- 配信先: <https://d-op.sasnews.dev/>
- カスタムドメイン: `d-op.sasnews.dev`（`CNAME` ファイルに記載）
- DNS 設定: `d-op` の `CNAME` レコードを `sas-news.github.io.` に向ける
- HTTPS: GitHub Pages ダッシュボードの「Enforce HTTPS」を ON

## ディレクトリ構成

```
.
├── CNAME              # カスタムドメイン
├── .nojekyll          # Jekyll 処理の無効化
├── index.html         # ポータル単一ページ
├── styles.css         # ポータル専用スタイル
├── script.js          # マシュマロ動的ロード + X シェア URL 生成
└── assets/            # 画像素材
```

## ローカルプレビュー

```sh
# リポジトリルートで
python -m http.server 8000
# → http://localhost:8000/ をブラウザで開く
```

## 拡張機能本体について

拡張機能本体のソースは `dev` ブランチにあります。ポータルに関する変更は
`gh-pages` ブランチのみへ Pull Request してください。