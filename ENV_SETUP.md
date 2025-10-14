# 環境変数設定ガイド

このアプリケーションを動作させるには、Firebase と Gemini API の設定が必要です。

## 必要な環境変数

プロジェクトルートに `.env.local` ファイルを作成し、以下の環境変数を設定してください。

## 1. Firebase の設定

### 手順

1. [Firebase Console](https://console.firebase.google.com/) にアクセス
2. 新しいプロジェクトを作成（または既存のプロジェクトを選択）
3. プロジェクト設定から「ウェブアプリを追加」を選択
4. 表示される設定情報をコピー

### Firestore の有効化

1. Firebase Console の左メニューから「Firestore Database」を選択
2. 「データベースの作成」をクリック
3. セキュリティルールを「テストモードで開始」を選択（後で変更可能）
4. リージョンを選択（asia-northeast1 推奨）

### 環境変数の設定

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=your_firebase_api_key_here
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project_id.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project_id.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_firebase_app_id
```

## 2. Gemini API の設定

### 手順

1. [Google AI Studio](https://aistudio.google.com/app/apikey) にアクセス
2. Googleアカウントでログイン
3. 「Create API Key」または「APIキーを作成」をクリック
4. 既存のGoogle Cloud プロジェクトを選択、または新規作成
5. 生成されたAPIキーをコピー

**注意**: 最新のGemini 2.5モデルを使用します（音声・動画対応）

### 環境変数の設定

```bash
NEXT_PUBLIC_GEMINI_API_KEY=your_gemini_api_key_here
```

## .env.local ファイルの作成

プロジェクトルートに `.env.local` ファイルを作成し、以下のテンプレートを使用してください：

```bash
# Firebase設定
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSy...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=123456789
NEXT_PUBLIC_FIREBASE_APP_ID=1:123456789:web:abc123def456

# Gemini API設定
NEXT_PUBLIC_GEMINI_API_KEY=AIzaSy...
```

## 注意事項

⚠️ **セキュリティ**
- `.env.local` ファイルは `.gitignore` に含まれており、Gitにコミットされません
- APIキーは公開しないように注意してください
- 本番環境では、Firebaseのセキュリティルールを適切に設定してください

## Firestore セキュリティルールの設定（本番環境用）

開発後は、Firebase Console で以下のようなセキュリティルールを設定することを推奨します：

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 文書（transcriptions）コレクション
    match /transcriptions/{document=**} {
      // 読み取りは誰でも可能
      allow read: if true;
      // 書き込みは誰でも可能（テスト環境）
      // 本番環境では認証を追加: allow write: if request.auth != null;
      allow write: if true;
    }
    
    // プロンプト（prompts）コレクション
    match /prompts/{document=**} {
      // 読み取りは誰でも可能
      allow read: if true;
      // 書き込みは誰でも可能（テスト環境）
      // 本番環境では認証を追加: allow write: if request.auth != null;
      allow write: if true;
    }
  }
}
```

**重要**: テストモードの場合は、一定期間後に自動的に書き込み権限が無効になるため注意してください。

### コレクション構造

このアプリケーションでは以下の2つのコレクションを使用します：

1. **transcriptions**: 生成された文書を保存
   - fileName: ファイル名
   - transcription: 生成された文書内容
   - promptName: 使用したプロンプト名
   - originalFileType: 元のファイルタイプ（video/audio）
   - bitrate, sampleRate: 変換設定
   - createdAt: 作成日時

2. **prompts**: カスタムプロンプトを保存
   - name: プロンプト名
   - content: プロンプト内容
   - isDefault: デフォルトプロンプトかどうか
   - createdAt, updatedAt: タイムスタンプ

## 動作確認

環境変数を設定後、開発サーバーを再起動してください：

```bash
npm run dev
```

正しく設定されていれば、動画変換後に文書が自動生成され、Firestoreに保存されます。

