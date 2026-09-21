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
・共有（任意機能）：プレイリストを共有URLとして公開・取り込み。同意した場合のみ有効です

【使い方】
1. dアニメストアの作品ページを開く
2. エピソードの「OP/ED」ボタンをクリック → OPとEDを連続再生
3. プレイヤー画面の「♪」ボタン → プレイリストに追加
4. ツールバーアイコンからプレイリスト再生・管理

【プライバシー】
すべてのデータはブラウザのローカルストレージに保存されます。共有機能は任意で、オプションまたは取り込み画面で明示的に同意した場合のみ、公開・取り込みの操作時に公式サーバーと通信します。自動送信・自動同期は行いません。詳細はプライバシーポリシーをご確認ください。

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
・Share (optional): Publish playlists as shareable URLs and import shared playlists. Enabled only after explicit consent.

[How to Use]
1. Open a title page on d-Anime Store.
2. Click the OP/ED button for an episode to play the OP and ED continuously.
3. Click the ♪ button on the player screen to add it to your playlist.
4. Manage and play your playlists from the toolbar icon.

[Privacy]
All data is saved in your browser's local storage. The optional Share feature communicates with the official server only during explicit publish/import actions after you grant consent. No automatic sending or sync. Please check the privacy policy for details.

[Note]
A d-Anime Store account is required. This extension is not affiliated with the official d-Anime Store.
```

---

## 権限の説明（ストア審査用）

| 権限 | 使用理由 |
|---|---|
| `storage` | ユーザーが作成したプレイリスト、再生位置、設定、共有機能の同意状態をブラウザのローカルストレージ（`chrome.storage.local`）に保存するために必要です。 |
| `tabs` | プレイリストの連続再生時に、dアニメストア本来のプレイヤー画面を新しいタブで開くために必要です。また、設定に応じて既存タブの再利用・フォーカス制御にも使用します。ユーザーのタブ内容の読み取りや監視は行いません。 |
| （備考）ポップアップ再生 | `browser.windows.create` / `windows.get` は宣言不要の API で、ポップアップウィンドウでの再生に使用します。`windows` 権限はマニフェストに宣言していません。設定でタブ再生に切り替えることも可能です。 |
| ホスト権限 (`animestore.docomo.ne.jp`, `anime.dmkt-sp.jp`) | dアニメストアの作品一覧ページおよびプレイヤーページ上に、OP/ED選択ボタン、プレイリスト操作UI、シークバーマーカーなどの拡張機能UIを追加するために必要です。dアニメストア以外のサイトでは一切動作しません。 |
| ホスト権限 (`d-op.sasnews.dev`) | 任意の共有機能でのみ使用します。ユーザーが共有機能に明示的に同意し、公開・更新・削除・状態確認・共有プレイリストの取り込みを行ったときだけ、この固定オリジンと通信します（Cookie・認証情報は送信しません）。同意しない限り通信は発生しません。 |

---

## プライバシーへの取り組み（Chrome Web Store 審査項目）

### 単一用途の説明

本拡張機能の単一用途は「dアニメストアの動画からOP/ED区間を抽出し、プレイリスト化して連続再生すること」です。これによりユーザーは、各エピソードのオープニング・エンディングだけを効率的に視聴できます。

### 権限の正当化

- **`storage`**: プレイリスト、再生状態、ユーザー設定、共有機能の同意状態をブラウザのローカルストレージに永続化するため。全データは端末内にのみ保存されます。
- **`tabs`**: プレイリストの連続再生時に、次に再生するエピソードのプレイヤーページを新しいタブで開くため。`tabs` API はタブの作成・更新・フォーカス制御に限定して使用し、タブのURLや内容の読み取りは行いません。
- **ポップアップ再生**: `browser.windows` のウィンドウ作成・取得 API（宣言不要）を、再生中の動画をdアニメストア本来のポップアッププレイヤーと同じ挙動で新規ウィンドウ表示するために使用します。`windows` 権限は宣言していません。ユーザー設定によりタブ表示への切り替えも可能です。

### ホスト権限の正当化

ホスト権限は `animestore.docomo.ne.jp`、`anime.dmkt-sp.jp`（dアニメストアの正規ドメイン）と `d-op.sasnews.dev`（本拡張機能の共有サーバー）に限定しています。

dアニメストア向け権限の目的は以下の通りです：

- 作品一覧ページに OP/ED 選択ボタンを追加する
- 動画プレイヤーページにプレイリスト操作UIとシークバーマーカーを追加する
- プレイヤー制御用スクリプトをページへ注入する

`d-op.sasnews.dev` 向け権限の目的は、共有機能の API 通信（公開・更新・削除・状態確認・共有プレイリストの取得・匿名の取り込み通知）のみです。この通信はユーザーが共有機能に同意し、明示的に操作した場合にのみ発生します。同意前・無効化後・通常利用時にこのオリジンへの通信は行われません。

上記以外のサイトでは一切動作しません。

### リモートコード

本拡張機能はリモートコードを一切使用していません。すべてのJavaScript、CSS、HTMLは拡張機能パッケージ内に同梱されており、外部サーバーからのコード読み込みや実行は行いません。

### データ使用に関する表明

本拡張機能は、Google のデベロッパー プログラム ポリシーに準拠しています。

- 収集するユーザーデータ：プレイリスト情報（作品名、エピソード名、再生区間の開始・終了時間）、再生状態、ユーザー設定、共有機能の同意状態。これらはすべて `chrome.storage.local` に保存されます。
- 外部送信は、ユーザーが共有機能に明示的に同意し、公開・取り込みなどの共有操作を行った場合に限ります。送信内容は公開用スナップショット（タイトル・説明・公開者名・タグ・クリップ情報）と匿名の取り込み通知（ランダムなイベントIDのみ）に限定されます。
- 個人情報・認証情報・閲覧履歴・端末識別子の収集は一切行いません。
- データの第三者提供・販売は一切行いません。
- データの暗号化は Chrome ブラウザの標準ストレージ保護機構に依存しています。
- 詳細は同梱の [PRIVACY.md](PRIVACY.md) および公開中のプライバシーポリシー（https://d-op.sasnews.dev/privacy）を参照してください。

### Firefox のデータ収集に関する表明（`data_collection_permissions`）

Firefox 版マニフェストの `browser_specific_settings.gecko.data_collection_permissions` には以下を宣言しています。

- **`required: ["none"]`** — 通常利用（プレイリスト管理・再生）は完全にローカルで完結し、必須のデータ収集はありません。
- **`optional: ["websiteContent", "personallyIdentifyingInfo", "technicalAndInteraction"]`** — 任意の共有機能でのみ送信されるデータに対応します：
  - `websiteContent` — 公開スナップショットには、ユーザーがプレイリストにまとめたdアニメページの作品タイトル・話数・IDが含まれます。
  - `personallyIdentifyingInfo` — 公開者名・説明は自由入力欄のため、ユーザー自身が入力した識別可能な文字列が含まれる場合があります。
  - `technicalAndInteraction` — 取り込み通知（ランダムなイベントIDのみの匿名集計）は拡張機能の利用状況のシグナルに該当します。

これらのカテゴリは共有機能を使う場合にのみ関連し、Firefox のデータ収集同意に対応するバージョンではネイティブの同意プロンプトが表示されます。拒否または後から取り消した場合、共有通信は停止し、ローカル機能はすべて利用可能なままです。

---

---

## テスト手順（ストア審査用）

> **注意**: dアニメストアはログイン時に2段階認証（SMSまたはメール認証コード）が必須のため、テスト用アカウントの認証情報を静的に提供することが物理的に不可能です。以下の手順はログインなしで確認可能な範囲に絞っています。

### 1. 作品ページでの OP/ED ボタン確認
dアニメストアの作品ページはログインなしでも一部表示され、拡張機能のコンテンツスクリプトが動作します。

1. 以下の作品ページを開く
   `https://animestore.docomo.ne.jp/animestore/ci_pc?workId=27008`
2. エピソード一覧の各行に **「OP/ED」ボタン** が表示されることを確認
3. 「OP/ED」ボタンをクリック → 新規ウィンドウ（またはタブ）が開くことを確認

### 2. ポップアップUIの確認
拡張機能のツールバーアイコンをクリックして以下を確認：

- **空状態**: プレイリスト未作成時は「♪ プレイリストがありません。」と「管理画面で作成」ボタンが表示されること
- **「管理」ボタン**: クリック → オプションページが開くこと
- **バージョン表示**: フッターに `d-OP v1.0.0` が表示されること
- **表示崩れがないこと**

### 3. オプションページの確認（プレイリスト管理）
ポップアップの「管理」ボタン、または拡張機能アイコン右クリック → オプションで開く。

#### 3-1. JSONインポート
`test/sample_playlist.json` をダウンロードし、「JSONインポート」から読み込み。
→ 2つのサンプルプレイリスト（「お気に入りOP集」「EDコレクション」）が表示されること。

#### 3-2. プレイリスト一覧の操作
- **展開/折りたたみ**: プレイリスト名クリック → アイテム一覧が展開/折りたたみ
- **曲数・合計時間**: 「N件 / MM:SS」形式で表示されること
- **名前編集**: プレイリスト名をインライン編集できること
- **▶ 再生**: 再生ボタンでプレイリスト再生がリクエストされること
- **削除**: 削除ボタン → 確認ダイアログ → 削除されること

#### 3-3. アイテム操作（プレイリスト展開時）
- **▶ 個別再生**: 各アイテムの再生ボタン
- **編集**: 「編集」→ 範囲名・開始時間・終了時間のインライン編集 → 「保存」「キャンセル」
- **コピー**: 「コピー」→ コピー先プレイリスト選択ダイアログ → コピー
- **削除**: 「削除」→ 確認ダイアログ → 削除
- **ドラッグ＆ドロップ並び替え**: グリップハンドル（≡）をドラッグ → アイテム順序入れ替え

#### 3-4. JSONエクスポート
「JSONエクスポート」→ 全プレイリストを含むJSONファイルがダウンロードされること。

#### 3-5. 設定
「新規ウィンドウ」「新規タブ」ラジオボタンで再生時の開き方を切り替えられること。

#### 3-6. 共有機能（同意）
「共有機能」セクションに同意状態と「有効にする / 利用しない」ボタンが表示されること。未選択または「利用しない」状態では外部通信が発生しないこと（送信は共有操作時のみ）。「無効にする」でいつでも取り消せること。

#### 3-7. フッター
GitHub / プライバシー / お問い合わせ / @sas_shinbun リンク、およびバージョン表示があること。

### Chrome Web Store ダッシュボード入力内容

> dアニメストアは2段階認証必須のため、テスト用アカウントの認証情報提供が物理的に不可能です。以下は認証情報なしで確認可能な手順です。

**認証情報 → ユーザー名**: （空欄 — 2段階認証必須のため提供不可）

**認証情報 → パスワード**: （空欄）

**認証情報 → 追加の手順**:
```
1. https://animestore.docomo.ne.jp/animestore/ci_pc?workId=27008 を開く
   → エピソード行にOP/EDボタン表示、クリックで新規ウィンドウ/タブ起動を確認
2. ツールバーアイコン → 空状態（プレイリストがありません）＋管理ボタン → オプション
3. オプション: test/sample_playlist.json をJSONインポート
   → 展開/折りたたみ、曲数・合計時間表示、名前編集
   → アイテムの編集（範囲名・時間）/ コピー / 削除 / D&D並び替え
   → JSONエクスポート / 新規ウィンドウ・タブ設定切替
   → 「共有機能」セクションの同意状態表示と有効化/無効化ボタン
リモートコード不使用。全コード同梱。
https://github.com/sas-news/d-op/blob/dev/test/sample_playlist.json
```

---

## カテゴリ

`Fun`（エンターテインメント・動画再生補助のため）

## 言語

日本語
