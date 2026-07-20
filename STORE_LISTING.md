# Chrome Web Store 掲載情報

---

## 短い説明（日本語 / 132文字以内）

```
dアニメストアの動画からOP/EDを抽出して連続再生。劇中歌や好きなシーンのプレイリスト化にも対応しています！
```

## 短い説明（英語 / 132文字以内）

```
Extract and play OPs/EDs from d-Anime Store. You can also create playlists for insert songs and favorite scenes!
```

---

## 詳細な説明（日本語）

```
作品一覧からワンクリックでOP/ED区間を選択し、お気に入りの範囲だけを連続再生できます。

【主な機能】
・OP/EDスキップ再生：各エピソードの「OP/ED」ボタンからスキップ区間を選択して直接再生
・プレイリスト管理：OP/ED区間をプレイリストにまとめ、複数作品のOP/EDを連続再生
・カスタム範囲指定：任意の開始〜終了地点を指定して再生
・シークバーマーカー：プレイヤーのシークバーにOP/ED区間を色分け表示
・インポート/エクスポート：プレイリストをJSONで保存・移行
・新規ウィンドウ再生：dアニメ本来の再生画面に合わせたポップアップ表示（タブ切替も可）

【使い方】
1. dアニメストアの作品ページを開く
2. エピソードの「OP/ED」ボタンをクリック → OPとEDを連続再生
3. プレイヤー画面の「♪」ボタン → プレイリストに追加
4. ツールバーアイコンからプレイリスト再生・管理

【プライバシー】
すべてのデータはブラウザのローカルストレージに保存され、外部への送信は一切ありません。詳細はプライバシーポリシーをご確認ください。

【注意】
dアニメストアのアカウントが必要です。本拡張機能はdアニメストア公式のものではありません。
```

---

## 詳細な説明（英語）

```
You can select OP/ED segments from the episode list with a single click and play your favorite scenes in a continuous loop.

[Key Features]
・OP/ED Skip/Play: Select and play skip segments directly via the OP/ED buttons for each episode.
・Playlist Management: Group OP/ED segments into playlists to play them continuously across multiple series.
・Custom Range Selection: Specify custom start and end points for playback.
・Seek Bar Markers: Display OP/ED segments with color coding on the player's seek bar.
・Import/Export: Save and migrate playlists using JSON files.
・New Window Playback: Popup display tailored to the native d-Anime Store player (tab switching is also available).

[How to Use]
1. Open a title page on d-Anime Store.
2. Click the OP/ED button for an episode to play the OP and ED continuously.
3. Click the ♪ button on the player screen to add it to your playlist.
4. Manage and play your playlists from the toolbar icon.

[Privacy]
All data is saved in your browser's local storage; no data is sent to external servers. Please check the privacy policy for details.

[Note]
A d-Anime Store account is required. This extension is not affiliated with the official d-Anime Store.
```

---

## 権限の説明（ストア審査用）

| 権限 | 使用理由 |
|---|---|
| `storage` | ユーザーが作成したプレイリスト、再生位置、設定をブラウザのローカルストレージ（`chrome.storage.local`）に保存するために必要です。外部サーバーへのデータ送信は一切行いません。 |
| `tabs` | プレイリストの連続再生時に、dアニメストア本来のプレイヤー画面を新しいタブで開くために必要です。また、設定に応じて既存タブの再利用・フォーカス制御にも使用します。ユーザーのタブ内容の読み取りや監視は行いません。 |
| `windows` | dアニメストアのネイティブな再生体験に合わせ、動画プレイヤーをポップアップウィンドウ（新規ウィンドウ）で開くために必要です。設定でタブ再生に切り替えることも可能です。 |
| ホスト権限 (`animestore.docomo.ne.jp`, `anime.dmkt-sp.jp`) | dアニメストアの作品一覧ページおよびプレイヤーページ上に、OP/ED選択ボタン、プレイリスト操作UI、シークバーマーカーなどの拡張機能UIを追加するために必要です。dアニメストア以外のサイトでは一切動作しません。 |

---

## プライバシーへの取り組み（Chrome Web Store 審査項目）

### 単一用途の説明

本拡張機能の単一用途は「dアニメストアの動画からOP/ED区間を抽出し、プレイリスト化して連続再生すること」です。これによりユーザーは、各エピソードのオープニング・エンディングだけを効率的に視聴できます。

### 権限の正当化

- **`storage`**: プレイリスト、再生状態、ユーザー設定をブラウザのローカルストレージに永続化するため。全データは端末内にのみ保存され、外部送信は一切ありません。
- **`tabs`**: プレイリストの連続再生時に、次に再生するエピソードのプレイヤーページを新しいタブで開くため。`tabs` API はタブの作成・更新・フォーカス制御に限定して使用し、タブのURLや内容の読み取りは行いません。
- **`windows`**: 再生中の動画をdアニメストア本来のポップアッププレイヤーと同じ挙動で新規ウィンドウ表示するため。ユーザー設定によりタブ表示への切り替えも可能です。

### ホスト権限の正当化

ホスト権限は `animestore.docomo.ne.jp` および `anime.dmkt-sp.jp` の2ドメインに限定しています。これらのドメインはdアニメストアの正規ドメインであり、本拡張機能が機能を提供する唯一のサイトです。権限の目的は以下の通りです：

- 作品一覧ページに OP/ED 選択ボタンを追加する
- 動画プレイヤーページにプレイリスト操作UIとシークバーマーカーを追加する
- プレイヤー制御用スクリプト（`injected.js`）をページへ注入する

上記以外のサイトでは一切動作しません。

### リモートコード

本拡張機能はリモートコードを一切使用していません。すべてのJavaScript、CSS、HTMLは拡張機能パッケージ内に同梱されており、外部サーバーからのコード読み込みや実行は行いません。

### データ使用に関する表明

本拡張機能は、Google のデベロッバー プログラム ポリシーに準拠しています。

- 収集するユーザーデータ：プレイリスト情報（作品名、エピソード名、再生区間の開始・終了時間）、再生状態、ユーザー設定。これらはすべて `chrome.storage.local` に保存され、外部送信は一切ありません。
- 個人情報・認証情報の収集は一切行いません。
- データの第三者提供・販売は一切行いません。
- データの暗号化は Chrome ブラウザの標準ストレージ保護機構に依存しています。
- 詳細は同梱の [PRIVACY.md](PRIVACY.md) を参照してください。

---

---

## テスト手順（ストア審査用）

> **注意**: dアニメストアは有料サブスクリプションサービス（月額550円〜）のため、テスト用アカウントの認証情報を提供することは利用規約上できません。審査には dアニメストアの有料アカウントが別途必要です。以下の手順は、アカウントをお持ちの審査官がご自身のアカウントでテストするためのガイドです。

### 前提条件
- dアニメストアの有料アカウント（dアカウント）でのログインが必要です
- ログイン後、任意の作品ページにアクセスできる状態であること

### 認証情報（ダッシュボード入力欄）

- **ユーザー名**: （空欄 — dアニメストア有料アカウントが必要です。認証情報の共有は利用規約により制限されています）
- **パスワード**: （空欄）
- **追加の手順**: 本拡張機能は dアニメストア（https://animestore.docomo.ne.jp/）上でのみ動作します。テストには dアニメストアの有料会員アカウントが必要です。ログイン後、以下の手順でコア機能をお試しください。

### テスト手順（詳細）

#### 1. 作品一覧での OP/ED 再生テスト
1. dアニメストアにログイン後、任意の作品ページを開く（例: https://animestore.docomo.ne.jp/animestore/sc_d_pc?partId=任意のpartId）
2. 作品一覧ページに遷移し、各エピソード行に表示される **「OP/ED」ボタン** をクリック
3. OP区間・ED区間の選択肢がポップアップ表示されることを確認
4. いずれかの区間をクリック → プレイヤーページが開き、選択した区間の先頭から再生が始まることを確認

#### 2. プレイヤーページでのプレイリスト追加テスト
1. OP/ED区間再生中、プレイヤー下部のコントロールバーに **「♪」ボタン** が表示されることを確認
2. 「♪」ボタンをクリック → 「プレイリストに追加」画面が表示されることを確認
3. 任意のプレイリストを選択（または新規作成）して区間を追加
4. 追加後、シークバー上に追加した区間がマーカー表示されることを確認

#### 3. プレイリスト連続再生テスト
1. ツールバーの拡張機能アイコンをクリック → ポップアップが表示されることを確認
2. 作成したプレイリストを選択し再生開始
3. プレイヤー下部の **⏮ ⏭ ボタン** で前後の曲に移動できることを確認
4. プレイリスト内の全アイテムが自動で連続再生されることを確認

#### 4. 設定変更テスト
1. ツールバーアイコンを右クリック → 「オプション」を選択
2. 設定ページで「新規ウィンドウで開く」/「タブで開く」の切り替えが動作することを確認
3. プレイリストのインポート/エクスポートがJSONファイルで動作することを確認

### Chrome Web Store ダッシュボード入力内容

**認証情報 → ユーザー名**: 空欄（dアニメストア有料アカウント必須のため提供不可）

**認証情報 → パスワード**: 空欄

**認証情報 → 追加の手順**:
```
本拡張機能は dアニメストア（https://animestore.docomo.ne.jp/）上でのみ動作します。
テストには dアニメストアの有料会員アカウント（月額550円〜）が必要です。
dアカウントでログイン後、任意の作品ページにアクセスし、エピソード行の「OP/ED」ボタンからコア機能をお試しください。
詳細なテスト手順は STORE_LISTING.md の「テスト手順」セクションをご参照ください。
```

---

## カテゴリ

`Fun`（エンターテインメント・動画再生補助のため）

## 言語

日本語
