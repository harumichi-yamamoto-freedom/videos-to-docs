# 運用手順書 (ops runbook)

商談くんミニ (videos-to-docs) の本番運用手順。対象 issue: #12 (S2-7 CI とリリースゲート)・#14 (S2-9 バックアップ/PITR/復旧)・#15 (S2-10 資格情報の運用)。

**この文書は手順書であり、ここに書いたコマンドを機械的に実行する仕組みは無い。** 本番プロジェクトに対する操作は、実行者が内容を読んでから 1 行ずつ手で実行する。

## 0. 前提 (本番の構成)

| 項目 | 値 |
|---|---|
| Firebase / GCP プロジェクト | `hy-docs-generated-from-audio` (`.firebaserc` の default) |
| Firestore データベース | `(default)` (アプリは `getFirestore(app)` = database id 指定なし) |
| Storage バケット | `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` の値 (以下 `$BUCKET` と表記)。音声は `audio/{ownerId}/{timestamp}_{name}.mp3` |
| ホスティング | Vercel の git 統合。**`main` への push = 即本番** (ステージング無し) |
| GitHub | `harumichi-yamamoto-freedom/videos-to-docs`。**public リポジトリ** (鍵の混入は即時公開と同義) |
| 配備対象ファイル | `firestore.rules` / `firestore.indexes.json` / `storage.rules` (`firebase.json` に 3 つとも登録済み) |
| ローカル CLI | `firebase` (firebase-tools), `gcloud`, `gh`, Node 20 |

以下、コマンド中の `$PROJECT` は `hy-docs-generated-from-audio`、`$BUCKET` は `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` の値を指す。

```bash
export PROJECT=hy-docs-generated-from-audio
export BUCKET=<NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET の値>   # 例: gs:// を付けずに指定
```

---

## 1. リリースゲート (S2-7 / #12)

### 1.1 現状
- `.github/workflows/ci.yml` (tsc → lint → vitest) をリポジトリに置いた。ジョブ名は `check`。
- GitHub Actions は組織側の事情で停止していることがある。**Actions が止まっていても Vercel のビルドは走る**ので、まず 1.2 の即効策を入れる。
- main にブランチ保護・ruleset は無い (2026-09-03 時点で 404 / `[]`)。

### 1.2 即効策: Vercel の Build Command でテストを走らせる (Actions 停止中でも効く)
Vercel ダッシュボード → Project → **Settings → Build & Development Settings → Build Command** を Override して:

```
npm test && npm run build
```

- `npm test` は `vitest run` (約 1,000 件・10 秒前後)。赤ならビルドが止まり、**本番は前のデプロイのまま**残る。
- lint も止めたいなら `npm run lint && npm test && npm run build`。(Next 16 は `next build` で lint を走らせない。)
- 注意: Vercel の環境変数に `NODE_ENV=production` を**手で入れない**こと。入れると devDependencies (vitest / eslint / typescript) がインストールされず、このコマンド自体が失敗する。
- 確認: 保存後に空コミットを push するか Vercel の Redeploy を押し、Deployment のビルドログに `Test Files … passed` が出ることを見る。

### 1.3 復旧後の恒久策: PR 必須 + status check 必須
Actions が動くようになったら (`gh run list` で `check` が走っているのを確認してから):

1. workflow の初回成功を 1 回作る (PR を 1 本開けば `pull_request` で走る)。
2. main のブランチ保護を入れる:

```bash
cat > /tmp/main-protection.json <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["check"] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
gh api -X PUT repos/harumichi-yamamoto-freedom/videos-to-docs/branches/main/protection \
  --input /tmp/main-protection.json
```

- `required_approving_review_count` は 0 でも **PR 経由が必須**になる (直接 push は拒否)。レビュアーが常時いる体制になったら 1 に上げる。
- `contexts` の `check` は `ci.yml` の job 名。job 名を変えたらここも変える。
- 確認: `gh api repos/harumichi-yamamoto-freedom/videos-to-docs/branches/main/protection` が 200 で返り、`git push origin main` が直接 push で拒否される。
- Vercel 側は変更不要 (PR ブランチは Preview、main は Production のまま)。

### 1.4 補足
- リポジトリは public。public リポジトリの Actions 分は無料枠なので、組織の spending limit 枯渇の影響を受けない可能性がある。復旧の判定は推測せず `gh run list` で実測する。
- ローカルで CI と同じ手順を再現する: `npm ci && npx tsc --noEmit && npm run lint && npm run test`。

---

## 2. バックアップ / PITR / 復旧 (S2-9 / #14)

### 2.1 現状と方針
- アプリには「一括削除」が 3 系統ある (退会時の `writeBatch` 全消し・ゲスト共通プロンプトの全削除再作成・移行スクリプト)。Firestore は既定では削除の取り消しができない (版の保持は 1 時間だけ)。
- 方針: **PITR (7 日) + 日次スケジュールバックアップ (14 日保持) + 削除保護** を Firestore に、**soft delete + versioning** を Storage に入れる。いずれも設定 1 回で継続する。
- 2026-09-03 に読み取り専用で確認した時点では、PITR 無効・バックアップスケジュール無し・削除保護無効だった (実行前に 2.2 の確認コマンドで再確認する)。

### 2.2 いまの状態を確認する (読み取り専用)

```bash
gcloud firestore databases describe --database='(default)' --project "$PROJECT"
#   pointInTimeRecoveryEnablement / versionRetentionPeriod / deleteProtectionState を見る
gcloud firestore backups schedules list --database='(default)' --project "$PROJECT"
gcloud storage buckets describe "gs://$BUCKET" --format='yaml(versioning,softDeletePolicy,lifecycle)'
```

firebase CLI しか認証が生きていない場合の代替: `firebase firestore:databases:get "(default)" --project "$PROJECT"`。

### 2.3 Firestore: PITR と削除保護を有効化 (1 回)

```bash
# PITR (有効化後、7 日分の版が保持される。有効化以前の時点へは戻れない)
gcloud firestore databases update --database='(default)' --project "$PROJECT" --enable-pitr

# データベース自体の誤削除を防ぐ
gcloud firestore databases update --database='(default)' --project "$PROJECT" --delete-protection

# 確認
gcloud firestore databases describe --database='(default)' --project "$PROJECT" \
  --format='value(pointInTimeRecoveryEnablement,versionRetentionPeriod,deleteProtectionState)'
#   期待: POINT_IN_TIME_RECOVERY_ENABLED  604800s  DELETE_PROTECTION_ENABLED
```

費用: PITR は保持する版の分だけストレージ課金が増える (このアプリのデータ量では小額)。

### 2.4 Firestore: 日次スケジュールバックアップ (1 回)

```bash
# 日次・14 日保持
gcloud firestore backups schedules create --database='(default)' --project "$PROJECT" \
  --recurrence=daily --retention=14d

# 任意: 週次・8 週保持を重ねる (長期の巻き戻し用)
gcloud firestore backups schedules create --database='(default)' --project "$PROJECT" \
  --recurrence=weekly --day-of-week=SUN --retention=8w

# 確認 (翌日以降、実際のバックアップが並ぶ)
gcloud firestore backups schedules list --database='(default)' --project "$PROJECT"
gcloud firestore backups list --project "$PROJECT"
```

### 2.5 Firestore: 危険な操作の直前に手動エクスポート
移行スクリプトや Rules 変更など、後戻りしにくい操作の**直前**に取る。エクスポート先の GCS バケットは初回だけ作る。

```bash
# 初回のみ: エクスポート専用バケット (音声バケットとは分ける)
gcloud storage buckets create "gs://$PROJECT-firestore-exports" --project "$PROJECT" \
  --location=asia-northeast1 --uniform-bucket-level-access

# 毎回
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
gcloud firestore export "gs://$PROJECT-firestore-exports/manual/$STAMP" \
  --database='(default)' --project "$PROJECT"
echo "$STAMP"   # 作業記録に残す
```

location はデータベースと同じリージョンにする (`gcloud firestore databases describe` の `locationId`)。

### 2.6 Storage: soft delete と versioning (1 回)

```bash
# 削除しても 30 日間は復元できる
gcloud storage buckets update "gs://$BUCKET" --soft-delete-duration=30d

# 上書きの旧版を残す (同名再アップロード対策)
gcloud storage buckets update "gs://$BUCKET" --versioning

# 旧版が無限に溜まらないよう lifecycle で上限 (非現行版は 3 世代 or 30 日で削除)
cat > /tmp/lifecycle.json <<'EOF'
{ "rule": [
  { "action": {"type": "Delete"}, "condition": {"numNewerVersions": 3, "isLive": false} },
  { "action": {"type": "Delete"}, "condition": {"daysSinceNoncurrentTime": 30, "isLive": false} }
] }
EOF
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file=/tmp/lifecycle.json

# 確認
gcloud storage buckets describe "gs://$BUCKET" --format='yaml(versioning,softDeletePolicy,lifecycle)'
```

補足: 現在のアプリコードは Storage の音声を削除しない (S1-3 で削除経路を足す予定)。削除経路を足した後も、この設定があれば 30 日は取り戻せる。

### 2.7 復旧手順: Firestore の誤削除・誤更新

**手順の順番が重要。先に被害を止め、次に「いつの状態に戻すか」を決めてから触る。**

1. **止血**: 原因の操作を止める (スクリプトなら kill。アプリ経由なら該当機能の告知/停止を判断)。事故時刻 `T_bad` (UTC) を記録する。
2. **範囲の特定**: 影響コレクションと doc id の範囲を決める (`auditLogs` コレクション、スクリプトの backup JSONL / plan ファイル、Vercel/ブラウザのログ)。
3. **戻し先の選択**
   - `T_bad` から 7 日以内で PITR が有効 → **PITR** (分単位で時刻を選べる)。
   - それより前、または PITR が無効だった期間 → **スケジュールバックアップ** か **2.5 の手動エクスポート**。
4. **別データベースへ復元する** (本番 `(default)` を直接上書きしない)

```bash
# PITR から: T_bad の直前の時刻を指定
gcloud firestore databases restore --project "$PROJECT" \
  --source-database='(default)' --snapshot-time='2026-09-03T01:23:00Z' \
  --destination-database='restore-20260903'

# バックアップから: gcloud firestore backups list で name を取る
gcloud firestore databases restore --project "$PROJECT" \
  --source-backup='projects/'"$PROJECT"'/locations/<location>/backups/<backup-id>' \
  --destination-database='restore-20260903'
```

5. **復元 DB から本番へ戻す** (コレクション単位。import は同 id の doc を上書きし、無い doc は消さない)

```bash
# 復元 DB を GCS へ書き出し (必要なコレクションだけ)
gcloud firestore export "gs://$PROJECT-firestore-exports/restore/20260903" \
  --database='restore-20260903' --project "$PROJECT" \
  --collection-ids=prompts,transcriptions

# 本番へ import。--collection-ids を必ず付け、範囲外を触らない
gcloud firestore import "gs://$PROJECT-firestore-exports/restore/20260903" \
  --database='(default)' --project "$PROJECT" \
  --collection-ids=prompts,transcriptions
```

   - 数件だけ戻す場合は、import ではなく firebase-admin で復元 DB (`getFirestore(app, 'restore-20260903')`) から読み、`(default)` へ書く小スクリプトにする (dry-run 既定 + `--confirm`。§3.3 の方針)。
   - **注意**: import は事故後に作られた新しい doc を消さない。事故後に「消されるべきだった / 変更された」doc がある場合は、手順 2 で特定した id 集合との差分を先に取る。
6. **検証**: 本番アプリで該当ユーザーの文書一覧・プロンプト一覧を開き、件数と最新更新時刻を確認。`auditLogs` に復旧作業の記録 (誰が・いつ・何を・どの backup から) を残す。
7. **後片付け**: 復元 DB は確認が終わったら削除する (課金対象)。

```bash
gcloud firestore databases delete --database='restore-20260903' --project "$PROJECT"
```

### 2.8 復旧手順: Storage の誤削除

```bash
# soft delete 中のオブジェクトを探す
gcloud storage ls --soft-deleted --recursive "gs://$BUCKET/audio/<ownerId>/"

# 復元 (generation 付きで指定)
gcloud storage restore "gs://$BUCKET/audio/<ownerId>/<file>.mp3#<generation>"

# 上書きされた旧版を戻す (versioning)
gcloud storage ls --all-versions "gs://$BUCKET/audio/<ownerId>/<file>.mp3"
gcloud storage cp "gs://$BUCKET/audio/<ownerId>/<file>.mp3#<generation>" \
                  "gs://$BUCKET/audio/<ownerId>/<file>.mp3"
```

Firestore 側 `transcriptions.audioStoragePath` が指すパスと一致していることを確認する。

### 2.9 Rules / indexes / storage.rules の配備

`firebase.json` に 3 種すべてが登録されているため、**引数無しの `firebase deploy` は 3 種を同時に配備する**。必ず `--only` で対象を 1 つに限定する。

```bash
# 配備前: いま本番で動いている Rules を退避 (巻き戻し用)
TOKEN=$(gcloud auth print-access-token)
REL=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://firebaserules.googleapis.com/v1/projects/$PROJECT/releases/cloud.firestore" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["rulesetName"])')
curl -s -H "Authorization: Bearer $TOKEN" "https://firebaserules.googleapis.com/v1/$REL" \
  > "rules-live-$(date -u +%Y%m%d).json"
# (gcloud が失効している場合は Firebase Console → Firestore → ルール → 履歴 で前版を控える)

# 配備前: ローカルの錠を回す (firestore.rules の構造テスト)
npx vitest run src/lib/firestoreRules.team.test.ts

# Firestore Rules だけ
firebase deploy --only firestore:rules --project "$PROJECT"

# Storage Rules だけ
firebase deploy --only storage --project "$PROJECT"

# インデックスだけ。⚠ firestore.indexes.json に無い既存インデックスは削除対象になる。
#   対話プロンプトで削除の可否を聞かれるので、--force や非対話で流さない。
firebase deploy --only firestore:indexes --project "$PROJECT"
```

配備後の確認:
- Rules: 未ログイン (ゲスト) と本人ログインで、`/home` のプロンプト一覧と `/documents` が開けること。未ログインで他人の文書が list できないことを SDK 経路で 1 回確認 (REST `:runQuery` は Rules を評価しないので確認には使えない)。
- 巻き戻し: Firebase Console → Firestore → ルール → 履歴 から前版を選んで公開、または退避した JSON の `source.files[].content` を `firestore.rules` に戻して再配備。

### 2.10 Vercel の環境変数 (7 種)
アプリが読む環境変数は次の 7 つだけ (`src/lib/firebase.ts` と `src/lib/gemini.ts`)。すべて `NEXT_PUBLIC_` = **クライアントバンドルに埋め込まれ、閲覧者から見える**。

| 変数 | 用途 | 秘密か |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase Web API key | 公開前提 (Rules と API 制限で守る) |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Auth ドメイン | 公開 |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | プロジェクト id | 公開 |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | 音声バケット | 公開 |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Firebase 設定 | 公開 |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebase 設定 | 公開 |
| `NEXT_PUBLIC_GEMINI_API_KEY` | Gemini API key | **本来は秘密**。現行設計ではクライアント露出 (S1-2 でサーバ経由化予定)。Google AI Studio 側で HTTP リファラ制限と日次上限を必ず設定する |

- 設定場所: Vercel → Project → Settings → Environment Variables (Production / Preview 両方)。
- 変更は**再デプロイしないと反映されない** (ビルド時に埋め込まれる)。
- Gemini key のローテーション: AI Studio で新キー作成 → Vercel の値を更新 → Redeploy → 本番で 1 件生成して疎通確認 → 旧キーを削除。
- サーバ側の秘密 (サービスアカウント鍵) は Vercel に**置かない** (現行アプリにサーバ層は無い)。

---

## 3. 資格情報の運用 (S2-10 / #15)

### 3.1 原則
1. **サービスアカウント鍵はリポジトリの外**に置く。置き場所は `~/.config/gcloud/keys/` (パーミッション 600)。リポジトリ直下には置かない (public リポジトリなので `git add -A` 一発で公開される)。
2. スクリプトへは **`GOOGLE_APPLICATION_CREDENTIALS`** で渡す。
3. 鍵をダウンロードせず済むなら **ADC + サービスアカウント impersonation** を優先する (鍵ファイルが存在しない状態が最も安全)。
4. 作業が終わったら **ADC を revoke** する。この Mac の ADC が本番に書けるままだと、`--project-id` 一致だけで本番を書き換えるスクリプトが動いてしまう。
5. 本番を変更するスクリプトは **dry-run 既定 + `--apply` + `--confirm`** (3.3)。

### 3.2 鍵の置き方

```bash
mkdir -p ~/.config/gcloud/keys && chmod 700 ~/.config/gcloud/keys
# Firebase Console → プロジェクト設定 → サービスアカウント → 新しい秘密鍵の生成 でダウンロードした
# <project>-firebase-adminsdk-xxxxx-xxxxxxxxxx.json を移動する (リポジトリ内に一度も置かない)
mv ~/Downloads/hy-docs-generated-from-audio-firebase-adminsdk-*.json \
   ~/.config/gcloud/keys/hy-docs-generated-from-audio-admin.json
chmod 600 ~/.config/gcloud/keys/hy-docs-generated-from-audio-admin.json

# 使うシェルでだけ export (~/.zshrc に恒久設定しない)
export GOOGLE_APPLICATION_CREDENTIALS=~/.config/gcloud/keys/hy-docs-generated-from-audio-admin.json
```

鍵を使わない代替 (推奨):

```bash
gcloud auth application-default login \
  --impersonate-service-account=firebase-adminsdk-<id>@$PROJECT.iam.gserviceaccount.com
# → firebase-admin は ADC を自動で拾う。作業後は 3.4 で revoke
```

`.gitignore` には `serviceAccountKey.json` と `*-firebase-adminsdk-*.json` を入れてあるが、これは**誤って置いたときの保険**であり、置いてよい理由にはならない。

### 3.3 スクリプト側の現状と実行ルール

| スクリプト | 資格情報の読み方 (現状) | dry-run | 確認値 |
|---|---|---|---|
| `scripts/ops-gemini37-rollout.mjs` | ADC / `GOOGLE_APPLICATION_CREDENTIALS` | 既定 | `--apply --project-id <id>` (資格情報の project と一致必須) |
| `scripts/migrate-text-to-transcription.mjs` | `./serviceAccountKey.json` 固定 | 既定 (plan JSONL 生成) | `--apply --plan-sha256 --expected-count --confirm <値>` |
| `scripts/create-admin.ts` | `./serviceAccountKey.json` 固定 | **無し (即書込)** | 無し |
| `scripts/migrate-existing-data.ts` | `./serviceAccountKey.json` 固定 | **無し (即書込)** | 無し |
| `scripts/create-system-notification.ts` | `./serviceAccountKey.json` 固定 | **無し (即書込)** | 無し |

運用ルール:
- **新規/改修するスクリプトは `ops-gemini37-rollout.mjs` の形に揃える**: 既定 dry-run・`--apply` には `--project-id` 明示と資格情報 project の一致検査・書き込み前に旧値を backup JSONL へ全件保存・`FIRESTORE_EMULATOR_HOST` の有無を出力に明記。破壊的な (削除・全件更新) スクリプトは `migrate-text-to-transcription.mjs` と同じく plan の SHA-256 と件数、`--confirm <plan 由来の値>` を要求する。
- `./serviceAccountKey.json` 固定のスクリプトを、それらが `GOOGLE_APPLICATION_CREDENTIALS` を読むよう改修されるまで使う場合は、**実行の直前にシンボリックリンクを張り、直後に外す**:

```bash
ln -s "$GOOGLE_APPLICATION_CREDENTIALS" serviceAccountKey.json   # 鍵の実体はリポジトリ外のまま
npx tsx scripts/create-admin.ts <uid>
rm serviceAccountKey.json
git status --short   # serviceAccountKey.json が出ないこと (ignore 済みでも目視)
```

- dry-run の無い 3 本 (`create-admin.ts` / `migrate-existing-data.ts` / `create-system-notification.ts`) を本番に対して使う前に、§2.5 の手動エクスポートを取る。
- 本番を変更するスクリプトは、実行者・時刻・コマンド行・出力ファイル名を作業記録 (issue または `auditLogs`) に残す。

### 3.4 作業後の後片付け (毎回)

```bash
gcloud auth application-default revoke      # ADC を失効 (~/.config/gcloud/application_default_credentials.json が消える)
unset GOOGLE_APPLICATION_CREDENTIALS
rm -f serviceAccountKey.json                # 3.3 のシンボリックリンクを張った場合
ls ~/.config/gcloud/application_default_credentials.json 2>/dev/null && echo "まだ ADC が残っている"
```

`firebase` CLI のログインも不要になったら `firebase logout`。

### 3.5 鍵の棚卸しとローテーション (四半期ごと)

```bash
# 存在する鍵を列挙 (作成日が古いもの・用途不明のものを消す)
gcloud iam service-accounts keys list \
  --iam-account="firebase-adminsdk-<id>@$PROJECT.iam.gserviceaccount.com" --project "$PROJECT"
gcloud iam service-accounts keys delete <KEY_ID> \
  --iam-account="firebase-adminsdk-<id>@$PROJECT.iam.gserviceaccount.com" --project "$PROJECT"
```

### 3.6 鍵をコミットしてしまったときの対応 (順番が重要)
1. **先に GCP 側で鍵を削除する** (3.5 の `keys delete`)。履歴を消しても push 済みの鍵は既に取得され得る。
2. 次に履歴から除去する (`git filter-repo` 等) → force push → 関係者に再 clone を依頼。
3. `auditLogs` と Cloud Audit Logs で鍵削除までの間に不審な操作が無いか確認する。
4. 発生経緯と再発防止 (`.gitignore` 追加・pre-commit 検査) を issue に記録する。

---

## 4. チェックリスト

### 本番を触る作業の前
- [ ] `gcloud config get-value project` / `--project` の明示が `hy-docs-generated-from-audio` を指している
- [ ] §2.5 の手動エクスポートを取り、`STAMP` を記録した
- [ ] スクリプトを dry-run で流し、対象件数を目視した
- [ ] 鍵の実体がリポジトリ外にある (`git status --short` に鍵が出ない)

### 本番を触る作業の後
- [ ] アプリ (ゲスト + ログイン) で該当画面を開いて確認した
- [ ] `gcloud auth application-default revoke` を実行した
- [ ] `serviceAccountKey.json` のシンボリックリンクを消した
- [ ] 作業記録を issue / `auditLogs` に残した

### 初回だけ (このリポジトリの現状から)
- [ ] §1.2 Vercel Build Command を `npm test && npm run build` に変更
- [ ] §2.3 PITR + 削除保護
- [ ] §2.4 日次スケジュールバックアップ
- [ ] §2.6 Storage soft delete + versioning + lifecycle
- [ ] §1.3 Actions 復旧後にブランチ保護 (PR 必須 + `check` 必須)
- [ ] `NEXT_PUBLIC_GEMINI_API_KEY` の HTTP リファラ制限と日次上限 (Google AI Studio)
