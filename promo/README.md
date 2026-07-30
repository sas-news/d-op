# d-OP プロモーション動画

X 向けの縦型ショートプロモーション動画です。  
Remotion + Bun で作成しています。

## 仕様

- 尺: 18 秒
- アスペクト比: 9:16（1080×1920）
- FPS: 30
- 総フレーム数: 540

## シーン構成

| 時間 | 内容 |
|---|---|
| 0.0〜1.5s | インパクトのあるフック「OPスキップ機能、要りません。」 |
| 1.5〜3.5s | 問題提起「dアニメにOPスキップが来た。アニメ好きはOPを飛ばさない。」 |
| 3.5〜7.0s | FEATURE 01: 作品一覧からOP/EDを一発再生 |
| 7.0〜10.5s | FEATURE 02: 好きなOP/EDをプレイリスト化 |
| 10.5〜14.0s | FEATURE 03: 複数作品のOP/EDを連続再生 |
| 14.0〜18.0s | CTA: Chrome / Firefox 対応、無料、公式URL |

## 開発

```bash
# 依存インストール
bun install

# Remotion Studio でプレビュー
bun run dev
```

## レンダリング

```bash
bun run render
```

出力: `dist/promo.mp4`

### BGM について

`public/music.mp3` を差し替えることで BGM を追加できます。  
現在は無音のダミーファイルが配置されています。  
音源は著作権フリーのものをご用意ください。

### Windows 環境での注意

一部の Windows 環境では、Remotion 同梱の ffmpeg が `Documents` 配下などに出力ファイルを書き込めないことがあります。  
その場合は一時的に出力先を変更してください:

```bash
bunx remotion render src/index.ts PromoVideo C:\temp\promo.mp4
```

その後、生成された `promo.mp4` を `dist/` 配下に移動してください。
