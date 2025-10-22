# 管理スクリプト

このディレクトリには、データ移行と管理者作成のためのスクリプトが含まれています。

## スクリプト一覧

1. `migrate-existing-data.ts` - 既存データの移行
2. `create-admin.ts` - 初回管理者の作成

## 使用方法

### 1. 必要なパッケージのインストール

```bash
npm install -D tsx firebase-admin
```

### 2. サービスアカウントキーの取得

1. [Firebase Console](https://console.firebase.google.com/) にアクセス
2. プロジェクトを選択
3. ⚙️ **プロジェクト設定** > **サービスアカウント**
4. 「**新しい秘密鍵の生成**」をクリック
5. ダウンロードした JSON ファイルをプロジェクトルートに配置
6. ファイル名を `serviceAccountKey.json` に変更

```
videos-to-docs/
├── serviceAccountKey.json  ← ここに配置
├── scripts/
│   └── migrate-existing-data.ts
...
```

⚠️ **重要**: `serviceAccountKey.json` は `.gitignore` に追加されており、Git には含まれません。

### 3. スクリプトの実行

```bash
# プロジェクトルートで実行
npx tsx scripts/migrate-existing-data.ts
```

## 注意事項

⚠️ **本番環境で実行する前に:**
1. Firebase Console でデータベースのバックアップを取ってください
2. テスト環境で動作確認を行ってください
3. スクリプトは既存のデータを変更します（元に戻せません）

## スクリプトの動作

このスクリプトは以下の処理を行います：

1. `prompts` コレクションのすべてのドキュメントをスキャン
2. `ownerType` フィールドがないドキュメントに以下を追加:
   - `ownerType: 'guest'`
   - `ownerId: 'GUEST'`
   - `createdBy: 'GUEST'`
   - `updatedAt: serverTimestamp()`

3. `transcriptions` コレクションについても同様の処理を実行

## トラブルシューティング

### エラー: "Cannot find module 'tsx'"

```bash
npm install -D tsx
```

### エラー: "Firebase configuration is missing"

`.env.local` ファイルに以下の環境変数が設定されているか確認:
- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- など

### 権限エラー

Firebase Console で Firestore の書き込み権限があることを確認してください。

---

## スクリプト2: 初回管理者の作成

### 概要

Firebase Authentication でアカウントを作成した後、そのユーザーに管理者権限（`superuser: true`）を付与します。

### 使用方法

#### 1. 管理者にしたいユーザーでサインアップ

アプリで通常通りアカウントを作成します。

#### 2. Firebase Authentication で UID を確認

1. [Firebase Console](https://console.firebase.google.com/) > **Authentication**
2. ユーザー一覧で対象ユーザーを見つける
3. **UID**（ユーザー識別子）をコピー

例: `ylSoKJnLhQPgxcjdodQSOyqO5ym1`

#### 3. スクリプトを実行

```bash
npx tsx scripts/create-admin.ts YOUR_USER_UID
```

**実行例:**
```bash
npx tsx scripts/create-admin.ts ylSoKJnLhQPgxcjdodQSOyqO5ym1
```

#### 4. 確認

1. Firebase Console > Firestore Database > `users` コレクション
2. 対象ユーザーに `superuser: true` があることを確認
3. アプリにログインして `/admin` にアクセス
4. 管理者画面が表示されることを確認 ✅

### 出力例

```
🚀 管理者作成スクリプトを開始します...

対象UID: ylSoKJnLhQPgxcjdodQSOyqO5ym1

✅ Firebase Authentication でユーザーが見つかりました:
   - Email: admin@example.com
   - DisplayName: (未設定)

✅ 管理者権限の付与が完了しました！

📋 確認事項:
1. Firebase Console で users コレクションを確認
2. アプリにログインして /admin にアクセス
3. 管理者画面が表示されることを確認
```

### トラブルシューティング

#### エラー: "auth/user-not-found"

→ 指定した UID のユーザーが Firebase Authentication に存在しません。
→ Firebase Console > Authentication で UID を確認してください。

#### エラー: "serviceAccountKey.json が見つかりません"

→ 上記のデータ移行スクリプトと同じセットアップが必要です。

