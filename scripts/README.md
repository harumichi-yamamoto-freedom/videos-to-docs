# 管理スクリプト

このディレクトリには、本番 Firestore を firebase-admin で直接操作する運用スクリプトが入っています。**すべて本番データを書き換えます。** 実行前に `docs/ops-runbook.md` (§2.5 手動エクスポート・§3 資格情報) を読んでください。

## スクリプト一覧

| スクリプト | 用途 | 資格情報の読み方 (現状) | dry-run |
|---|---|---|---|
| `create-admin.ts` | 初回管理者 (`superuser: true`) の付与 | `./serviceAccountKey.json` 固定 | 無し (即書込) |
| `migrate-existing-data.ts` | `ownerType`/`ownerId` 無しの旧データ移行 | `./serviceAccountKey.json` 固定 | 無し (即書込) |
| `create-system-notification.ts` | お知らせ (`systemNotifications`) の作成 | `./serviceAccountKey.json` 固定 | 無し (即書込) |
| `migrate-text-to-transcription.mjs` | `text` → `transcription` の二段階移行 | `./serviceAccountKey.json` 固定 | 既定 (plan JSONL)。`--apply` に `--confirm` 等が必須 |
| `ops-gemini37-rollout.mjs` | Gemini 3.7 ロールアウト (model リセット + お知らせ) | ADC / `GOOGLE_APPLICATION_CREDENTIALS` | 既定。`--apply --project-id <id>` |

新しく書くスクリプトは `ops-gemini37-rollout.mjs` の形 (既定 dry-run・`--apply` + `--project-id` 一致検査・書き込み前の backup JSONL) に揃えてください。破壊的なものは `migrate-text-to-transcription.mjs` と同じく `--confirm` を要求してください。

## 使用方法

### 1. 必要なパッケージ

`tsx` と `firebase-admin` は devDependencies に入っています (`npm ci` で入ります)。

### 2. 資格情報 (サービスアカウント鍵) の置き方

**鍵はリポジトリの外に置き、`GOOGLE_APPLICATION_CREDENTIALS` で指します。リポジトリ直下には置きません** (このリポジトリは public です)。

1. [Firebase Console](https://console.firebase.google.com/) → プロジェクトを選択
2. ⚙️ **プロジェクト設定** > **サービスアカウント** > 「**新しい秘密鍵の生成**」
3. ダウンロードした `<project>-firebase-adminsdk-xxxxx-xxxxxxxxxx.json` を `~/.config/gcloud/keys/` へ移動

```bash
mkdir -p ~/.config/gcloud/keys && chmod 700 ~/.config/gcloud/keys
mv ~/Downloads/<project>-firebase-adminsdk-*.json ~/.config/gcloud/keys/<project>-admin.json
chmod 600 ~/.config/gcloud/keys/<project>-admin.json
export GOOGLE_APPLICATION_CREDENTIALS=~/.config/gcloud/keys/<project>-admin.json
```

鍵をダウンロードせずに済む方法 (推奨): `gcloud auth application-default login --impersonate-service-account=<SA>`。firebase-admin は ADC を自動で使います。

⚠️ `.gitignore` の `serviceAccountKey.json` / `*-firebase-adminsdk-*.json` は誤って置いたときの保険であり、置いてよい理由ではありません。

ℹ️ 本番サーバ (`/api/generate`) が Vercel で使う `FIREBASE_SERVICE_ACCOUNT_JSON` は、ここで使う運用スクリプト用の鍵とは**別の専用サービスアカウント** (読取中心の最小権限) です。混ぜないでください。作り方は `docs/ops-runbook.md` §5.6。

#### `./serviceAccountKey.json` 固定のスクリプトを動かすとき

`create-admin.ts` / `migrate-existing-data.ts` / `create-system-notification.ts` / `migrate-text-to-transcription.mjs` は、現状ではカレントディレクトリの `serviceAccountKey.json` しか読みません。改修されるまでは、**実行の直前にシンボリックリンクを張り、直後に外して**ください (鍵の実体はリポジトリ外のまま)。

```bash
ln -s "$GOOGLE_APPLICATION_CREDENTIALS" serviceAccountKey.json
npx tsx scripts/create-admin.ts YOUR_USER_UID
rm serviceAccountKey.json
git status --short   # 鍵が出ないことを目視
```

### 3. 実行前・実行後

- 実行前: `docs/ops-runbook.md` §2.5 の手動エクスポートを取る。dry-run のあるスクリプトは必ず dry-run で件数を見る。
- 実行後: `gcloud auth application-default revoke` で ADC を失効し、`unset GOOGLE_APPLICATION_CREDENTIALS`、シンボリックリンクを削除する。

```bash
# プロジェクトルートで実行
npx tsx scripts/migrate-existing-data.ts
```

## 注意事項

⚠️ **本番環境で実行する前に:**
1. `docs/ops-runbook.md` §2.5 の手順で Firestore をエクスポートする (バックアップ)
2. テスト環境 (Firestore エミュレータ) で動作確認を行う
3. dry-run の無いスクリプトは既存のデータを即座に変更します (元に戻すには §2.7 の復旧手順が必要)

## `migrate-existing-data.ts` の動作

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
npm ci
```

### エラー: "serviceAccountKey.json が見つかりません"

上記「`./serviceAccountKey.json` 固定のスクリプトを動かすとき」のシンボリックリンクを張ってください。

### 権限エラー

サービスアカウントに Firestore の書き込み権限 (Firebase Admin SDK の既定 SA なら付与済み) があることを確認してください。

---

## `create-admin.ts`: 初回管理者の作成

### 概要

Firebase Authentication でアカウントを作成した後、そのユーザーに管理者権限 (`superuser: true`) を付与します。管理者への昇格はこのスクリプト (firebase-admin) 専任で、アプリの UI からは行えません。

### 使用方法

#### 1. 管理者にしたいユーザーでサインアップ

アプリで通常通りアカウントを作成します。

#### 2. Firebase Authentication で UID を確認

1. [Firebase Console](https://console.firebase.google.com/) > **Authentication**
2. ユーザー一覧で対象ユーザーを見つける
3. **UID** (ユーザー識別子) をコピー

例: `ylSoKJnLhQPgxcjdodQSOyqO5ym1`

#### 3. スクリプトを実行

```bash
ln -s "$GOOGLE_APPLICATION_CREDENTIALS" serviceAccountKey.json
npx tsx scripts/create-admin.ts YOUR_USER_UID
rm serviceAccountKey.json
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

→ 上記のシンボリックリンク手順が必要です。
