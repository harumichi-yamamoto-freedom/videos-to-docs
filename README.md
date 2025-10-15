# 動画→MP3変換 & AI文書生成アプリ

WebAssembly (FFmpeg.wasm) を使用して、ブラウザ内で動画をMP3に変換し、Gemini AIで音声から自動的に文書を生成するアプリケーションです。

## ✨ 主な機能

### 🎵 動画→音声変換
- **完全クライアントサイド処理**: すべての変換処理がブラウザ内で完結
- **プライバシー保護**: ファイルがサーバーにアップロードされることはありません
- **対応形式**: MP4, MOV, AVI, MKV, WebM など主要な動画形式
- **カスタマイズ可能な音質**:
  - ビットレート: 128k / 192k / 256k / 320k
  - サンプルレート: 44.1kHz / 48kHz / 96kHz

### 🤖 AI文書生成（強化版）
- **Gemini 2.5 Flash**: 音声ファイルから自動で文字起こし（最新モデル）
- **カスタマイズ可能なプロンプト**: 
  - 詳細な文字起こし、議事録形式、要約のみ、学習ノート形式など
  - プロンプトの新規作成・編集・削除が可能
  - ファイルごとに複数のプロンプトを選択可能
- **並列処理**: 複数ファイルと複数プロンプトを同時処理
- **詳細な進捗表示**: 音声変換フェーズと文書生成フェーズを明確に表示
- **Firestore保存**: 生成された文書をクラウドに保存
- **履歴管理**: 過去の文書を一覧表示・プロンプト名で識別・削除

## 🚀 技術スタック

- **フロントエンド**: Next.js 15 (App Router) + React 19 + TypeScript
- **スタイリング**: Tailwind CSS v4
- **動画変換**: FFmpeg.wasm (WebAssembly)
- **AI処理**: Google Gemini 1.5 Flash
- **データベース**: Firebase Firestore
- **アイコン**: Lucide React

## 📋 必要な環境

- Node.js 20以上
- npm または yarn
- Firebase プロジェクト
- Google Gemini API キー

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

### 3. 環境変数の設定

プロジェクトルートに `.env.local` ファイルを作成し、以下の環境変数を設定してください：

```bash
# Firebase設定
NEXT_PUBLIC_FIREBASE_API_KEY=your_firebase_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project_id.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project_id.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_firebase_app_id

# Gemini API設定
NEXT_PUBLIC_GEMINI_API_KEY=your_gemini_api_key
```

詳しい設定手順は [ENV_SETUP.md](./ENV_SETUP.md) を参照してください。

### 4. 開発サーバーの起動

```bash
npm run dev
```

ブラウザで [http://localhost:3000](http://localhost:3000) を開きます。

## 📖 使い方

### 基本的な流れ

1. **プロンプト設定**（初回のみ）: 
   - 「プロンプト管理を開く」で使用するプロンプトを確認・編集
   - デフォルトプロンプト4種類が用意済み
2. **デフォルトプロンプトを選択**: ファイル追加前に使用するプロンプトを選択
3. **ファイルを選択**: 動画ファイルをドラッグ&ドロップ、またはクリックして選択
4. **ファイルごとのプロンプト調整**: 必要に応じて各ファイルのプロンプトをカスタマイズ
5. **設定を調整**: ビットレートとサンプルレートを選択
6. **変換・文書生成開始**: ボタンをクリックして処理を開始
   - 音声変換と文書生成が自動的に実行されます
   - 複数ファイルは並列処理されます
7. **文書を確認**: 「生成された文書」セクションで生成された文書を確認

### 推奨設定

- **普段使い**: 192 kbps / 44.1 kHz
- **高音質**: 256 kbps / 48 kHz
- **最高品質**: 320 kbps / 48 kHz

## 📁 プロジェクト構造

```
src/
├── app/              # Next.js App Router
│   ├── page.tsx      # メインページ（大幅リニューアル）
│   ├── layout.tsx    # レイアウト
│   └── globals.css   # グローバルスタイル
├── components/       # Reactコンポーネント
│   ├── FileDropZone.tsx           # ファイルドロップエリア
│   ├── ConversionSettings.tsx     # 変換設定パネル
│   ├── PromptManager.tsx          # プロンプト管理UI（新規）
│   ├── FilePromptSelector.tsx     # ファイル別プロンプト選択（新規）
│   └── TranscriptionList.tsx      # 文書一覧表示
└── lib/              # ユーティリティ・ロジック
    ├── ffmpeg.ts     # FFmpeg.wasm処理
    ├── gemini.ts     # Gemini API クライアント
    ├── prompts.ts    # プロンプト管理（新規）
    ├── firebase.ts   # Firebase初期化
    └── firestore.ts  # Firestore操作
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

## 🔒 セキュリティについて

- すべての動画変換処理はブラウザ内で実行され、サーバーにアップロードされません
- 音声ファイルはGemini APIに送信されますが、文書生成後は保持されません
- `.env.local` ファイルはGitにコミットされません
- 本番環境では、Firestoreのセキュリティルールを適切に設定してください

## 📝 ライセンス

MIT

## 🙏 謝辞

- [FFmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) - ブラウザでのFFmpeg実行
- [Google Gemini](https://ai.google.dev/) - AI文書生成
- [Firebase](https://firebase.google.com/) - クラウドデータベース
- [Next.js](https://nextjs.org/) - Reactフレームワーク
