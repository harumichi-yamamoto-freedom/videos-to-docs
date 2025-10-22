# データ移行スクリプト

このディレクトリには、既存データを認証対応に移行するためのスクリプトが含まれています。

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

