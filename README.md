# 動画・音声→AI文書生成アプリ

WebAssembly (FFmpeg.wasm) とGemini AIを使用して、動画・音声から自動的に文書を生成するアプリケーションです。動画→音声の変換はブラウザ内で行い、Gemini の呼び出しは自社サーバ (`POST /api/generate`) が行います (API キーはブラウザに出ません)。

## ✨ 主な機能

### 🔐 認証・ユーザー管理
- **ゲストモード**: ログイン不要で即座に利用開始
  - ゲスト共有のプロンプトと文書
  - デフォルトプロンプトが自動生成
- **ユーザーモード**: アカウント作成でデータを個別管理
  - 自分専用のプロンプトと文書
  - ログイン時に自動的にデフォルトプロンプト生成
  - 他のユーザーやゲストのデータは非表示
- **認証方法**: 
  - メールアドレス＋パスワード
  - Googleアカウント
- **アカウント管理**:
  - パスワード変更
  - アカウント削除（すべてのデータを完全削除）
- **管理者機能** (`superuser`):
  - 監査ログ閲覧
  - システム設定（サイズ上限変更）
  - ユーザー一覧

### 👥 チーム管理
- **部下タブ**
  - 部下一覧と申請一覧を閲覧
  - 申請を承認/拒否して関係を管理
  - 部下を選択すると、そのユーザーのプロンプト/生成文書を閲覧用モーダルで確認（編集不可）
- **上司タブ**
  - 上司一覧と申請状況を表示
  - メールアドレスで上司を申請し、承認されると自分のデータを閲覧可能に
- **Firestore Security Rules**
  - メールアドレス検索は 1 件・完全一致に制限し、最小限の権限で上司申請を実現

### 🖥️ 画面構成
- **ホーム `/home`**: ファイルアップロード、プロンプト管理、処理ステータス、デバッグオプションをまとめたメインワークスペース。
- **文書 `/documents`**: 左サイドバー＋右ペインで構成され、`DocumentDetailPanel` を使って Markdown 表示・編集・ダウンロードを一体化。
- **チーム `/team`**: AppHeader のドロップダウンから部下/上司ビューを切り替え、リレーション申請や閲覧専用モーダルを提供。
- **管理 `/admin`**: superuser 専用。監査ログ、システム設定、ユーザー一覧を参照・操作。

### 🎵 動画・音声変換
- **クライアントサイド変換**: 動画→音声の変換処理はブラウザ内で完結 (元の動画ファイルはどこにも送られない)
- **音声だけを送る**: 変換後の音声を Firebase Storage (自分のディレクトリ) に上げ、サーバがそこから読んで Gemini に渡す
- **対応形式**: 
  - **動画**: MP4, MOV, AVI, MKV, WebM
  - **音声**: MP3, WAV, M4A, AAC, OGG, FLAC（変換スキップで高速処理）
- **カスタマイズ可能な音質**:
  - ビットレート: 128k / 192k / 256k / 320k
  - サンプルレート: 44.1kHz / 48kHz / 96kHz
- **リアルタイム進捗表示**: 音声変換の進捗を%で表示

### 🎬 動画直接送信機能（試験的）
- **音声変換をスキップ**: 動画を直接Gemini APIに送信して文書を生成
- **高速処理**: FFmpegによる音声変換が不要
- **注意事項**:
  - ファイルサイズが大きいと失敗する可能性があります
  - 試験的な機能のため、標準の音声変換方式を推奨
- **簡単に無効化可能**: コード内の🎬絵文字でマークされた部分をコメントアウトまたは削除するだけで機能を除去できます

### 🤖 AI文書生成（Gemini 2.5〜3.7モデル）
- **複数のGeminiモデルに対応**:
  - Gemini 3.7 Flash: 現行フラッグシップFlash（既定モデル）
  - Gemini 3.5 Flash / 3.5 Flash Lite: 高性能・軽量の3.5世代
  - Gemini 3.1 Pro (Preview): 最高難度の推論向け
  - Gemini 2.5 Flash / Flash Lite / Pro: 安定・低コストの旧世代
- **プロンプトごとのモデル選択**: 各プロンプトに最適なモデルを個別に指定可能
- **カスタマイズ可能なプロンプト**:
  - デフォルト4種類（詳細な文字起こし、議事録形式、要約のみ、学習ノート形式）
  - プロンプトの新規作成・編集・削除が自由に可能
  - ファイルごとに複数のプロンプトを選択可能（1ファイルで複数形式の文書を同時生成）
- **最適化された並列・直列処理**:
  - 音声変換: 直列処理（FFmpegの制約）
  - 文書生成: 並列処理（複数ファイル・複数プロンプトを同時実行）
- **Firestore保存**: 生成された文書をクラウドに自動保存
- **履歴管理**: 過去の文書を一覧表示・プロンプト名で識別・削除・手動更新

### 🔄 エラーハンドリング & 再開機能
- **個別ファイル再開**: エラーが発生したファイルのみを個別に再開可能
- **インテリジェントな再開処理**:
  - 音声変換済みの場合: 文書生成のみを再実行
  - 未完了のプロンプトのみを処理（完了済みはスキップ）
  - 音声変換エラー: 他のファイル処理後にキューで順次再開
  - 文書生成エラー: 即座に並列再開
- **ネットワークエラー検出**: WiFi切断時などに適切なエラーメッセージを表示
- **詳細なエラー情報**: エラー箇所（音声変換 or 文書生成）と進捗状況を明示

### 🐛 開発者向け機能
- **デバッグモード**（開発環境のみ表示）:
  - 意図的にFFmpegエラーを発生させるオプション
  - 意図的にGemini APIエラーを発生させるオプション
  - エラーを起こすファイルのインデックス指定
  - 再開機能のテストが容易に

## 🚀 技術スタック

- **フロントエンド**: Next.js 16 (App Router) + React 19 + TypeScript
- **サーバ**: Next.js Route Handler `POST /api/generate` (Node ランタイム・firebase-admin) - 認証・所有権・時間あたり上限の確認と Gemini 呼び出し。契約は `src/lib/generateApiContract.ts`、説明は `docs/api-generate.md`
- **スタイリング**: Tailwind CSS v4
- **動画変換**: FFmpeg.wasm (WebAssembly) - ブラウザ内で動画から音声を抽出
- **AI処理**: Google Gemini 2.5〜3.7モデル - 音声認識と文書生成
  - Gemini 3.7 Flash: 現行フラッグシップFlash（既定）
  - Gemini 3.5 Flash / Flash Lite: 高性能・軽量
  - Gemini 3.1 Pro (Preview) / 2.5系: 高精度・低コストの選択肢
- **認証**: Firebase Authentication - メール/パスワード、Google認証
- **データベース**: Firebase Firestore - 文書・プロンプト・ユーザー管理
- **ストレージ**: Firebase Storage - 変換後の音声の一時置き場 (サーバが読む)
- **アイコン**: Lucide React
- **デプロイ**: Vercel対応

## 📋 必要な環境

- Node.js 20以上
- npm または yarn
- Firebase プロジェクト (Authentication / Firestore / Storage)
- Google Gemini API キー (サーバ専用。ブラウザには配らない)
- 本番 (Vercel) では Firebase サービスアカウント JSON (サーバが ID トークン検証と Storage 読取に使う)

## 🔧 セットアップ

### 1. リポジトリのクローン

```bash
git clone <repository-url>
cd videos-to-docs
```

### 2. 依存関係のインストール

```bash
npm install
```

### 3. Firebase プロジェクトの作成と設定

#### 3.1 Firebase プロジェクトを作成

1. [Firebase Console](https://console.firebase.google.com/) にアクセス
2. 「プロジェクトを追加」をクリック
3. プロジェクト名を入力して作成

#### 3.2 Firestore Database を有効化

1. Firebase Console の左メニューから「**Firestore Database**」を選択
2. 「**データベースの作成**」をクリック
3. セキュリティルールを「**本番環境モード**」で開始
4. リージョンを選択（**asia-northeast1** 推奨）

#### 3.3 Firebase Authentication を有効化

1. Firebase Console の左メニューから「**Authentication**」を選択
2. 「**始める**」をクリック
3. 「**ログイン方法**」タブで以下を有効化：
   - ✅ **メール/パスワード**
   - ✅ **Google**（オプション）

#### 3.4 ウェブアプリを追加

1. プロジェクト設定（⚙️アイコン）を開く
2. 「**マイアプリ**」セクションで「**ウェブ**」を選択
3. アプリのニックネームを入力
4. 表示される設定情報（API Key等）をメモ

### 4. Gemini API キーの取得

1. [Google AI Studio](https://aistudio.google.com/app/apikey) にアクセス
2. Googleアカウントでログイン
3. 「**Create API Key**」をクリック
4. 既存のGoogle Cloud プロジェクトを選択、または新規作成
5. 生成されたAPIキーをコピー
6. 本番用のキーは Google Cloud Console → 認証情報 で「API の制限 = Generative Language API のみ」と 1 日あたりの割当上限を設定する (`docs/ops-runbook.md` §5.5)。サーバから呼ぶので HTTP リファラ制限は使えない

### 5. 環境変数の設定

`.env.example` をコピーして `.env.local` を作り、値を埋めます (`.env*.local` は `.gitignore` に含まれており、Gitにコミットされません):

```bash
cp .env.example .env.local
```

| 変数 | 種別 | 説明 |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` / `_AUTH_DOMAIN` / `_PROJECT_ID` / `_STORAGE_BUCKET` / `_MESSAGING_SENDER_ID` / `_APP_ID` | 公開 (ブラウザに埋め込まれる) | ステップ 3.4 で取得した Firebase Web 設定 6 種 |
| `GEMINI_API_KEY` | **サーバ専用** | ステップ 4 で取得。`/api/generate` だけが読む。`NEXT_PUBLIC_` が付かないので **ブラウザのバンドルには出ない** |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | **サーバ専用** | サービスアカウント JSON (1 行 JSON か base64)。`/api/generate` が ID トークン検証・Storage 読取・上限カウンタ更新に使う。**ローカルでは省略可** (未設定なら ADC かエミュレータにフォールバック)。本番 (Vercel) では必須 |
| `FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` / `FIREBASE_STORAGE_EMULATOR_HOST` | ローカルのみ | Firebase エミュレータを使うときだけ。Vercel には設定しない |

⚠️ **`NEXT_PUBLIC_GEMINI_API_KEY` は廃止**されました。コードは読みません。以前この変数を設定していた環境 (Vercel・`.env.local`) からは削除し、そのキーは公開 JS に載っていたので Google AI Studio で失効させてください (`docs/ops-runbook.md` §5.4)。

サーバ専用の変数は `src/app/api/generate` と `src/server/` だけが `process.env` 経由で読みます。ブラウザに配られる変数は `NEXT_PUBLIC_` 接頭辞のものだけです。

### 6. Firestore セキュリティルールの設定

Firebase Console で Firestore のセキュリティルールを設定：

1. [Firestore ルール](https://console.firebase.google.com/project/your-project/firestore/rules) を開く
2. プロジェクトの `firestore.rules` ファイルの内容をコピー
3. Firebase Console にペースト
4. 「**公開**」をクリック

**主な機能**:
- ゲストモード: 未ログインユーザーは共有データを使用
- ユーザーモード: ログインユーザーは専用データを所有
- 管理者機能: `superuser` ユーザーのみアクセス可能

### 7. Firestore インデックスの作成

アプリを使用すると、Firestore から必要なインデックスのエラーが表示されます。
エラーメッセージのリンクをクリックして、以下のインデックスを自動作成してください：

**必要なインデックス**:
- `prompts`: `ownerType` + `createdAt`
- `prompts`: `ownerId` + `createdAt`
- `transcriptions`: `ownerType` + `createdAt`
- `transcriptions`: `ownerId` + `createdAt`
- `auditLogs`: `timestamp`
- `users`: `createdAt`

### 8. 開発サーバーの起動

```bash
npm run dev
```

ブラウザで [http://localhost:3000](http://localhost:3000) を開きます。

文書生成 (`/api/generate`) をローカルで動かすには、サーバが Firebase にアクセスできる資格情報が必要です。次のどちらか:

- **Firebase エミュレータ** (推奨): `firebase emulators:start --only auth,firestore,storage` を別ターミナルで起動し、`.env.local` の `FIRESTORE_EMULATOR_HOST` 等のコメントを外す。本番データに触れません。
- **ADC**: `gcloud auth application-default login` (作業後は `gcloud auth application-default revoke`。`docs/ops-runbook.md` §3)。

いずれの場合も `GEMINI_API_KEY` には本番と別の開発用キーを使います。詳細は `docs/api-generate.md` §11。

### 9. 初回管理者の作成（オプション）

管理者機能を使用する場合は、以下の手順で初回管理者を作成します：

#### ステップ1: サービスアカウントキーを取得

1. [Firebase Console](https://console.firebase.google.com/) > プロジェクト設定 > **サービスアカウント**
2. 「**新しい秘密鍵の生成**」をクリック
3. ダウンロードした JSON ファイルを **リポジトリの外** (`~/.config/gcloud/keys/`) に移動し、`GOOGLE_APPLICATION_CREDENTIALS` で指す (このリポジトリは public のため、プロジェクトルートには置かない)

```bash
mkdir -p ~/.config/gcloud/keys && chmod 700 ~/.config/gcloud/keys
mv ~/Downloads/<project>-firebase-adminsdk-*.json ~/.config/gcloud/keys/<project>-admin.json
chmod 600 ~/.config/gcloud/keys/<project>-admin.json
export GOOGLE_APPLICATION_CREDENTIALS=~/.config/gcloud/keys/<project>-admin.json
```

詳細 (impersonation で鍵を持たない方法・作業後の `gcloud auth application-default revoke`) は `docs/ops-runbook.md` §3 と `scripts/README.md`。

#### ステップ2: firebase-admin をインストール

```bash
npm install -D tsx firebase-admin
```

#### ステップ3: アカウントを作成してUIDを確認

1. アプリでアカウントを作成
2. [Firebase Console](https://console.firebase.google.com/) > **Authentication**
3. 作成したユーザーの **UID** をコピー

#### ステップ4: 管理者権限を付与

`create-admin.ts` は現状カレントディレクトリの `serviceAccountKey.json` しか読まないため、実行の直前にシンボリックリンクを張り、直後に外します (鍵の実体はリポジトリ外のまま):

```bash
ln -s "$GOOGLE_APPLICATION_CREDENTIALS" serviceAccountKey.json
npx tsx scripts/create-admin.ts YOUR_USER_UID
rm serviceAccountKey.json
```

**例**:
```bash
npx tsx scripts/create-admin.ts ylSoKJnLhQPgxcjdodQSOyqO5ym1
```

#### ステップ5: 管理者画面にアクセス

1. アプリにログイン
2. ヘッダーに「🛡️ 管理者画面」ボタンが表示される
3. クリックして `/admin` にアクセス

**管理者機能**:
- 📊 監査ログ閲覧（全操作履歴）
- ⚙️ システム設定（サイズ上限変更）
- 👥 ユーザー一覧

## 📖 使い方

### 初回起動時

1. **ゲストとして開始**: ログイン不要で即座に利用可能
   - ゲスト共有のデフォルトプロンプトが自動生成される
2. **アカウント作成（オプション）**: データを個別管理したい場合
   - 右上の「ログイン / アカウント作成」をクリック
   - メールアドレスまたはGoogleアカウントで登録
   - ログイン後、自分専用のデフォルトプロンプトが自動生成される

### 基本的な流れ

1. **プロンプト選択**: 
   - 左サイドバーでプロンプト一覧を確認
   - デフォルトプロンプト4種類から選択、または新規作成
2. **ファイルを選択**: 動画または音声ファイルをドラッグ&ドロップ
   - 動画ファイル: 音声変換 → 文書生成
   - 音声ファイル: 文書生成のみ（高速）
3. **プロンプト選択**: ファイルごとに使用するプロンプトを選択（複数選択可能）
4. **処理開始**: 「変換・文書生成開始」ボタンをクリック
   - 音声変換: 直列処理（一度に1ファイル）
   - 文書生成: 並列処理（複数ファイル・複数プロンプトを同時実行）
5. **文書を確認**: 左下の「生成された文書」で確認・ダウンロード・削除

### アカウント管理

ログイン後、右上のメールアドレスをクリックすると以下が可能：

- **パスワード変更**（メール認証の場合）
- **ログアウト**
- **アカウント削除**（すべてのデータを完全削除）

### エラー発生時の再開機能

処理中にエラーが発生した場合：

1. エラーが発生したファイルに**🔄再開ボタン**が表示されます
2. エラー箇所と進捗状況が表示されます：
   - ❌ エラーが発生しました (音声変換) / (文書生成)
   - ✓ 完了したプロンプト数
   - ✓ 音声変換済みかどうか
3. **再開ボタンをクリック**すると：
   - **音声変換エラーの場合**: 他のファイルの音声変換が終わった後で再開
   - **文書生成エラーの場合**: 即座に未完了のプロンプトのみ再開
   - 音声変換済みの場合は変換をスキップ
4. 成功したファイルは自動的にスキップされます

### デバッグモード（開発環境のみ）

開発環境（`npm run dev`）では、右側の設定パネルに「🐛 デバッグモード」が表示されます：

- **FFmpegエラーを発生させる**: 音声変換で意図的にエラーを起こす
- **Geminiエラーを発生させる**: 文書生成で意図的にエラーを起こす
- **エラーを起こすファイル**: どのファイルでエラーを起こすかを指定

これにより、再開機能のテストが簡単に行えます。

### 処理フロー

#### 動画ファイルの場合
```
動画選択 → 音声変換（直列、進捗表示）→ Storage アップロード → /api/generate（並列）→ Firestore保存
```

#### 音声ファイルの場合
```
音声選択 → Storage アップロード → /api/generate（並列、変換スキップ）→ Firestore保存
```

#### 複数ファイル・複数プロンプトの場合
```
[音声変換フェーズ - 直列処理]
ファイルA: ████████████ (完了) ──┐
ファイルB:              ████████  │ (待機後に処理)
ファイルC:                       ████████ (待機後に処理)

[文書生成フェーズ - 並列処理]
                    ┌─ 変換完了次第、即座に並列開始
                    │
ファイルA:           ├─ プロンプト1 ████
                    ├─ プロンプト2 ████  (同時実行)
                    └─ プロンプト3 ████
                    
                    ┌─ 変換完了次第、即座に並列開始
                    │
ファイルB:           ├─ プロンプト1 ████
                    ├─ プロンプト2 ████  (同時実行)
                    └─ プロンプト3 ████

結果: 複数ファイル×複数プロンプト = 高速な並列処理
```

### 推奨設定

- **普段使い**: 192 kbps / 44.1 kHz
- **高音質**: 256 kbps / 48 kHz
- **最高品質**: 320 kbps / 48 kHz

## 🎯 このアプリの特徴

### 1. **柔軟なファイル処理**
- 動画と音声ファイルを混在して選択可能
- 音声ファイルは変換をスキップして高速処理
- ファイルごとに異なるプロンプトを設定可能

### 2. **強力なエラーリカバリー**
- ファイルごとに個別の再開ボタン
- 処理済みの部分は自動的にスキップ
- 処理中でも再開ボタンを押せる（バックグラウンド実行）
- 音声変換済みの場合は再変換しない（高速再開）

### 3. **最適化された並列処理**
- 音声変換: 直列処理（FFmpegの制約に対応）
- 文書生成: 並列処理（複数ファイル・プロンプトを同時実行）
- パイプライン処理: 変換完了次第、次のフェーズを開始

### 4. **開発者フレンドリー**
- デバッグモードで意図的にエラーを発生させてテスト可能
- 詳細なエラーメッセージ（エラー箇所と進捗状況を明示）
- TypeScriptによる型安全性

## 🏗️ アーキテクチャ (文書生成の経路)

```
ブラウザ                                   自社サーバ (Vercel)                      Google
─────────────────────────────────────────  ──────────────────────────────────────  ─────────────
動画 ─FFmpeg.wasm→ 音声 (mp3)
   │
   ├─ Firebase Storage へアップロード ──────────────────────────────────────────→ Storage
   │    audio/{uid or GUEST}/{timestamp}_{name}.mp3   (storage.rules: 100MB・audio/*)
   │
   └─ POST /api/generate ─────────────────→ src/app/api/generate/route.ts
        { storagePath, fileName,              ├ Authorization: Bearer <ID token> を firebase-admin で検証 (無ければ GUEST)
          mimeType, prompt }                  ├ storagePath の ownerId が自分か確認 (403)
        Authorization: Bearer <ID token>      ├ adminSettings.rateLimit.documentsPerHour を rateLimits/{subject} で強制 (429)
                                              ├ Storage からファイルを読む (404 / 413)
                                              └ 16MiB 以内なら inlineData、超えれば Files API ──→ Gemini API
   ←─ { text, usedModel, transport, usage, elapsedMs } ─┘                          (GEMINI_API_KEY はここだけ)
   │
   └─ Firestore transcriptions に保存 (従来どおりブラウザ)
```

- Gemini API キーはサーバの環境変数 `GEMINI_API_KEY` にだけ存在し、ブラウザには配られません。
- 未ログイン (GUEST) の利用は維持されます。上限は送信元アドレスのハッシュ単位で数えます。
- 契約 (型・エラーコード・定数) は `src/lib/generateApiContract.ts`、人間向けの説明は `docs/api-generate.md`。

## 📁 プロジェクト構造

```
src/
├── app/
│   ├── (dashboard)/
│   │   ├── layout.tsx
│   │   ├── home/page.tsx
│   │   ├── documents/page.tsx
│   │   └── team/page.tsx
│   ├── admin/page.tsx
│   ├── api/generate/route.ts  # POST /api/generate (サーバ経由の文書生成・Node ランタイム・maxDuration 300)
│   ├── page.tsx               # ルート（/homeへリダイレクト）
│   └── globals.css
├── components/
│   ├── AppHeader.tsx / AuthModal系
│   ├── FileDropZone.tsx / BulkPromptSelector.tsx / FilePromptSelector.tsx
│   ├── PromptListSidebar.tsx / prompts/PromptModals.tsx
│   ├── DocumentListSidebar.tsx / DocumentDetailPanel.tsx / ContentEditModal.tsx
│   ├── team/TeamPanel.tsx
│   └── admin/AuditLogPanel.tsx, SettingsPanel.tsx, UsersPanel.tsx
├── hooks/
│   ├── useAuth.ts / useAdmin.ts
│   ├── usePromptManagement.ts / useFileManagement.ts
│   ├── useVideoProcessing.ts / useProcessingWorkflow.ts
│   └── 他ユーティリティフック
├── lib/
│   ├── firebase.ts / auth.ts
│   ├── firestore.ts / prompts.ts / relationships.ts
│   ├── userManagement.ts / adminSettings.ts / auditLog.ts
│   ├── accountDeletion.ts / promptPermissions.ts
│   ├── ffmpeg.ts / videoConversionService.ts / storage.ts
│   ├── gemini.ts              # /api/generate を呼ぶクライアント (Gemini SDK は使わない)
│   ├── generateApiContract.ts # /api/generate の契約 (型・定数)。サーバとクライアントが共有
│   ├── inlineMediaBudget.ts   # inline / Files API の切替判定 (サーバとクライアントが共有)
│   └── constants・utils
└── server/                    # サーバ専用 (firebase-admin・Gemini SDK・rate limit)。ブラウザには bundle されない
    ├── firebaseAdmin.ts / auth.ts / mediaSource.ts
    ├── geminiServer.ts / rateLimit.ts
    └── (テストは同階層)

scripts/                       # 管理スクリプト (本番 Firestore を直接操作。scripts/README.md 参照)
├── create-admin.ts            # 初回管理者作成
├── create-system-notification.ts  # お知らせ作成
├── migrate-existing-data.ts   # 旧データ移行
├── migrate-text-to-transcription.mjs  # text→transcription 二段階移行 (dry-run 既定)
└── ops-gemini37-rollout.mjs   # Gemini 3.7 ロールアウト (dry-run 既定)

docs/
├── ops-runbook.md             # 運用手順書 (リリースゲート・バックアップ/復旧・配備・資格情報・Gemini キーのサーバ移行)
└── api-generate.md            # POST /api/generate の説明 (流れ・リクエスト/レスポンス・エラー表・上限)

.env.example                   # 環境変数の雛形 (実値は書かない)
.github/workflows/ci.yml       # CI (tsc / lint / vitest)
firestore.rules                # Firestore セキュリティルール
firestore.indexes.json         # Firestore 複合インデックス
storage.rules                  # Storage セキュリティルール
```

## 🛠️ ビルド

### 本番ビルド

```bash
npm run build
```

### 本番サーバー起動

```bash
npm run start
```

## 🚦 リリースゲートと運用

`main` は Vercel の git 統合で **push した瞬間に本番** になります (ステージング無し)。壊れたコードが本番に出ないよう、次の 2 段でゲートします。詳細は `docs/ops-runbook.md` §1。

1. **Vercel の Build Command を `npm test && npm run build` にする** (Settings → Build & Development Settings)。テストが赤ならビルドが止まり、本番は前のデプロイのまま残ります。GitHub Actions が停止していても効く即効策です。
2. **CI workflow + ブランチ保護**: `.github/workflows/ci.yml` が push / PR (main 宛) で `npm ci` → `npx tsc --noEmit` → `npm run lint` → `npm run test` を Node 20 で走らせます (job 名 `check`)。Actions が動く状態になったら、main を **PR 必須 + status check `check` 必須** にします (手順とコマンドは runbook §1.3)。

ローカルで CI と同じ検査を回す:

```bash
npm ci && npx tsc --noEmit && npm run lint && npm run test
```

バックアップ (Firestore PITR / 日次バックアップ / Storage soft delete) と誤削除からの復旧、Rules・indexes の配備コマンド、Vercel 環境変数の一覧、資格情報の扱い、Gemini キーのサーバ移行とローテーションは `docs/ops-runbook.md` にまとめています。

## 🔒 セキュリティとプライバシー

### データの保護
- **クライアントサイド変換**: 動画→音声の変換処理はブラウザ内で実行され、元の動画ファイルはどこにも送信されません
- **音声データの扱い**: 
  - 変換後の音声 (MP3) だけが Firebase Storage の自分のディレクトリ (`audio/{uid or GUEST}/`) に上がります (Storage Rules で本人と管理者のみ読める。GUEST は共有)
  - 自社サーバ (`/api/generate`) が Storage から読んで Gemini API に送ります。16MiB を超える場合は Gemini の Files API を経由し、生成後に削除します (失敗しても 48 時間で自動削除)
  - Gemini API は文書生成後、音声データを保持しません
- **Gemini API キーはサーバ専用**: `GEMINI_API_KEY` は Vercel のサーバ側環境変数にだけあり、ブラウザに配られる JS には含まれません。サーバは呼び出しごとに認証・所有権・時間あたり上限を確認します (`docs/api-generate.md`)

### アクセス制御
- **Firestore Security Rules**: データベースレベルでアクセス制御
  - ゲスト共有データ: 全員が読み書き可能
  - ユーザー専有データ: 本人のみ読み書き可能
  - 所有者情報（`ownerType`, `ownerId`）: 更新で変更不可
  - ゲスト共有のデフォルトプロンプト: 編集・削除不可
- **プロンプト利用権限**: 文書生成前に利用権限を自動チェック
- **管理者機能**: `superuser` フィールドによる管理者識別
  - 監査ログ閲覧（管理者のみ）
  - システム設定変更（管理者のみ）
  - ユーザー一覧表示（管理者のみ）

### 監査とセキュリティ機能
- **監査ログ**: すべての重要操作を自動記録
  - プロンプト・文書の作成/更新/削除
  - ユーザーのログイン/ログアウト/アカウント削除
  - 管理者操作
- **サイズ制限**: プロンプトと文書のサイズ上限（管理者が変更可能）
  - プロンプト: 50KB（デフォルト）
  - 文書: 500KB（デフォルト）
- **再認証**: アカウント削除などの重要操作は再認証が必要
- **環境変数の保護**: `.env.local` ファイルはGitにコミットされません
- **サービスアカウント鍵**: リポジトリ外 (`~/.config/gcloud/keys/`) に置き `GOOGLE_APPLICATION_CREDENTIALS` で指す。`.gitignore` の `serviceAccountKey.json` / `*-firebase-adminsdk-*.json` は誤配置時の保険 (`docs/ops-runbook.md` §3)

## 🔧 トラブルシューティング

### 処理中にエラーが発生した場合

1. **エラーメッセージを確認**: エラー箇所（音声変換 or 文書生成）が表示されます
2. **進捗状況を確認**: 
   - ✓ 完了したプロンプト数
   - ✓ 音声変換済みかどうか
3. **🔄再開ボタンをクリック**: エラーが発生したファイルのみを再処理
4. **必要に応じて設定を変更**: ビットレートを下げるなど

### よくあるエラーと対処法

| エラー | 原因 | 対処法 |
|--------|------|--------|
| `ネットワークエラー: インターネット接続を確認してください` | WiFi切断、ネットワーク障害 | WiFi接続を確認して再開ボタンをクリック |
| `サーバの設定が完了していません` (HTTP 503 `not_configured`) | サーバに `GEMINI_API_KEY` / `FIREBASE_SERVICE_ACCOUNT_JSON` が無い | ローカルは `.env.local`、本番は Vercel の環境変数を確認し再デプロイ (`docs/ops-runbook.md` §5) |
| `時間あたりの上限に達しました` (HTTP 429 `rate_limited`) | 1 時間あたりの生成件数が上限超 | 表示された秒数の後に再試行。上限は管理画面の設定 |
| `ファイルが見つかりません` (HTTP 404) / 権限エラー (HTTP 403) | Storage への上げ直しが必要、または別ユーザーのファイル | ファイルを選び直して再開。ログイン状態を確認 |
| `音声変換に失敗しました` | 動画ファイルの形式が非対応 | 別の形式の動画ファイルを試す |
| `プロンプトが一つも選択されていません` | プロンプト未選択 | 最低1つのプロンプトを選択 |
| `Missing or insufficient permissions` | Firestore Rules未設定 | Firebase ConsoleでRulesをデプロイ |
| `プロンプトのサイズが上限を超えています` | プロンプトが大きすぎる | プロンプトを短くするか、管理者が上限を変更 |
| `auth/requires-recent-login` | アカウント削除時 | 再認証モーダルでパスワード入力 |

### 認証関連のトラブルシューティング

#### ユーザーデータが作成されない
1. ブラウザのコンソール（F12）でエラーを確認
2. Firestore Rules がデプロイされているか確認
3. アカウントを作成後、一度ログアウト→再ログイン

#### ログイン後もゲストデータが表示される
1. ブラウザのハードリフレッシュ（Cmd+Shift+R または Ctrl+Shift+R）
2. 一度ログアウト→再ログイン
3. Firestore でデータに `ownerType`, `ownerId` フィールドがあるか確認

#### 管理者画面にアクセスできない
1. Firebase Console > Firestore > `users/{uid}` で `superuser: true` を確認
2. 一度ログアウト→再ログイン
3. ブラウザのキャッシュをクリア

#### アカウント削除後にエラーが出る
1. 正常な動作です（削除されたユーザーのデータを読み込もうとしている）
2. ブラウザをリロードすれば解消されます

### パフォーマンス最適化のヒント

- **音声ファイルを直接使う**: 既にMP3がある場合は動画変換をスキップして高速化
- **プロンプトの選択**: 必要なプロンプトのみを選択して処理時間を短縮
- **ビットレートの調整**: 文字起こし用途なら128kbpsでも十分

## 🆕 最近のアップデート

### v3.1.0 - マルチモデル対応と動画直接送信
- ✅ 複数のGeminiモデルに対応（2.5 Flash、2.5 Flash Lite、3 Pro Preview）
- ✅ プロンプトごとのモデル選択機能
- ✅ 動画直接送信機能（試験的）- 音声変換をスキップして高速処理
- ✅ デフォルトプロンプトの追加機能（選択式で連番付き）

### v3.0.0 - 認証・管理者機能
- ✅ Firebase Authentication 統合（メール/パスワード、Google）
- ✅ ゲストモード・ユーザーモードの実装
- ✅ ユーザー専用データの分離
- ✅ 監査ログシステム（全操作履歴を記録）
- ✅ サイズ制限機能（プロンプト50KB、文書500KB）
- ✅ 管理者機能（監査ログ閲覧、設定変更、ユーザー一覧）
- ✅ アカウント管理（パスワード変更、完全削除）
- ✅ Firestore Security Rules による厳格なアクセス制御

### v2.0.0 - エラーリカバリーと音声ファイル対応
- ✅ 音声ファイル（MP3, WAV, M4A, AAC, OGG, FLAC）の直接選択に対応
- ✅ ファイルごとの個別再開機能を実装
- ✅ 処理中でも再開ボタンを押せるように改善
- ✅ 音声変換済みデータのキャッシュによる高速再開
- ✅ ネットワークエラー検出の改善
- ✅ デバッグモードの追加（開発環境のみ）

### v1.0.0 - 初期リリース
- 動画からMP3への変換
- Gemini AIによる文書生成
- プロンプト管理システム
- 並列処理の実装

## 📝 ライセンス

MIT

## 📚 ドキュメント

- **セットアップガイド**: このREADME（上記）
- **文書生成 API** (`POST /api/generate` の流れ・リクエスト/レスポンス・エラー表・上限): `docs/api-generate.md`
- **運用手順書** (リリースゲート・バックアップ/復旧・Rules 配備・資格情報・Gemini キーのサーバ移行/ローテーション): `docs/ops-runbook.md`
- **スクリプト使用方法**: `scripts/README.md`
- **環境変数の雛形**: `.env.example`

## 🙏 謝辞

- [FFmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) - ブラウザでのFFmpeg実行
- [Google Gemini](https://ai.google.dev/) - AI文書生成
- [Firebase](https://firebase.google.com/) - 認証とクラウドデータベース
- [Next.js](https://nextjs.org/) - Reactフレームワーク
- [Tailwind CSS](https://tailwindcss.com/) - ユーティリティファーストCSS
- [Lucide](https://lucide.dev/) - 美しいアイコンセット
