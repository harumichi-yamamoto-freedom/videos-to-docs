# `POST /api/generate` — サーバ経由の文書生成 API

契約の正は `src/lib/generateApiContract.ts` (型と定数のみ)。この文書はその人間向けの説明で、契約と食い違ったら契約側が正。対象 issue: #4 (S1-2 Gemini 呼び出しのサーバ経由化)。

## 1. 目的

以前はブラウザが Gemini API を直接呼んでいたため、API キー (`NEXT_PUBLIC_GEMINI_API_KEY`) が公開 JS に埋め込まれ、誰でも取り出して使えた (課金暴走の経路)。

本 API 以降:

- ブラウザは音声/動画を **Firebase Storage に上げるだけ**。Gemini を直接呼ばない。
- ブラウザは自社サーバ (Next.js Route Handler) に「**どの Storage ファイルを、どのプロンプトで**」だけ頼む。
- サーバが **認証・所有権・時間あたり上限** を確認してから Storage を読み、Gemini を呼ぶ。
- Gemini API キーは **サーバ専用の環境変数 `GEMINI_API_KEY`** にだけ置く。`NEXT_PUBLIC_` は付けない = ブラウザのバンドルには入らない。

## 2. 流れ

1. ブラウザ: (動画なら FFmpeg.wasm で音声に変換し) `audio/{ownerId}/{timestamp}_{name}.mp3` として Firebase Storage にアップロード (`storage.rules` で 100MB・`audio/*` に制限)。
2. ブラウザ: `POST /api/generate` に JSON (下記 3.1) を送る。ログイン中なら `Authorization: Bearer <Firebase ID token>` を付ける。未ログインなら付けない。
3. サーバ (`src/app/api/generate/route.ts`):
   1. ヘッダにトークンがあれば firebase-admin で検証して uid を得る。無ければ GUEST として扱う。トークンがあって無効なら **401**。
   2. `storagePath` が `audio/{ownerId}/{name}` 形式で、ownerId が「自分の uid」(ログイン) または `GUEST` (未ログイン) と一致するか確認。不一致は **403**。
   3. Firestore `adminSettings/config` の `rateLimit.documentsPerHour` を読み、`rateLimits/{subject}` の固定窓カウンタをトランザクションで更新。超過は **429**。
   4. firebase-admin の Storage からファイルを読む。無ければ **404**、100MB 超なら **413**。
   5. サイズが inline 予算 (16MiB = `src/lib/inlineMediaBudget.ts` の `INLINE_REQUEST_BUDGET_BYTES`) 以内なら `inlineData` で、超えれば Files API (upload → ACTIVE 待ち → 生成 → 削除) で Gemini を呼ぶ。
   6. 成功したら本文と使用モデル・トークン使用量を返し、観測ログを 1 行出す (下記 8)。
4. ブラウザ: 返ってきた `text` を Firestore `transcriptions` に保存する (ここは従来どおりクライアント側)。

サーバは Firestore への文書保存を行わない。生成結果の保存・履歴は従来どおりブラウザの責務。

## 3. リクエスト

- メソッド/パス: `POST /api/generate` (`GENERATE_API_PATH`)
- `Content-Type: application/json`
- 認証ヘッダ: `Authorization: Bearer <Firebase ID token>` (ログイン時のみ。`GENERATE_AUTH_HEADER`)

### 3.1 本文 (`GenerateRequestBody`)

| フィールド | 型 | 説明 |
|---|---|---|
| `storagePath` | `string` | Firebase Storage 上のパス。`audio/{ownerId}/{name}` 形式。ownerId は自分の uid (ログイン) か `GUEST` (未ログイン) |
| `fileName` | `string` | 元ファイル名。ログとエラー文言用 |
| `mimeType` | `string` | 元ファイルの MIME。`audio/*` か `video/*` (`GENERATE_ALLOWED_MIME_PREFIXES`)。Gemini にこの種別で渡す |
| `prompt` | `GenerateRequestPrompt` | 下記 |

`GenerateRequestPrompt`:

| フィールド | 型 | 説明 |
|---|---|---|
| `name` | `string` | 表示名 (監査ログ・エラー文言用) |
| `content` | `string` | プロンプト本文 |
| `model` | `string` | 保存表現。`'default'` センチネル可。サーバ側で `resolveGeminiModel` する |
| `thinkingLevel` | `GeminiThinkingLevel` | `'default' \| 'low' \| 'medium' \| 'high'`。サーバ側で `resolveThinkingLevelForModel` する |

「動画を直接送信する (試験的)」の場合、Storage には `audio/mpeg` の contentType で上がっているが、`mimeType` には `video/mp4` 等の元種別を渡す。サーバは Storage の contentType ではなくこの値を Gemini に渡す。

例:

```json
{
  "storagePath": "audio/GUEST/1725340000000_meeting.mp3",
  "fileName": "meeting.mp4",
  "mimeType": "audio/mpeg",
  "prompt": {
    "name": "議事録形式",
    "content": "以下の音声を議事録にしてください…",
    "model": "default",
    "thinkingLevel": "default"
  }
}
```

## 4. レスポンス (200)

`GenerateResponseBody`:

| フィールド | 型 | 説明 |
|---|---|---|
| `text` | `string` | 生成された文書 (Markdown) |
| `usedModel` | `string` | 実際に使ったモデル ID (センチネル解決後) |
| `thinkingLevel` | `string` | 実際に使った思考レベル (`LOW` / `MEDIUM` / `HIGH` / `NONE` 相当) |
| `transport` | `'inline' \| 'files_api'` | 実際に使った送信経路 (`GenerateTransport`) |
| `usage` | `GenerateUsage` | `promptTokenCount` / `candidatesTokenCount` / `thoughtsTokenCount` / `totalTokenCount` (いずれも任意) |
| `elapsedMs` | `number` | サーバ側の処理時間 (ms) |

## 5. エラー (`GenerateErrorBody`)

本文は `{ error, message, retryAfterSec? }`。`message` は利用者にそのまま見せてよい日本語で、「次に何をすべきか」を含む。Gemini の生の英文はサーバのログにだけ残す。

| HTTP | `error` (`GenerateErrorCode`) | 意味 | 利用者が次にすること |
|---|---|---|---|
| 400 | `invalid_request` | 入力不正 (パス形式・MIME・本文欠落) | 画面を再読み込みしてやり直す。続くなら不具合報告 |
| 401 | `unauthorized` | ID トークンが無効/期限切れ (未ログインは 401 ではなく GUEST 扱い) | ログインし直す |
| 403 | `forbidden` | `storagePath` の所有者が呼び出し主体と一致しない | 自分のファイルを選び直す。ログイン状態を確認 |
| 404 | `media_not_found` | Storage にファイルが無い | もう一度アップロードからやり直す |
| 413 | `media_too_large` | `GENERATE_MAX_MEDIA_BYTES` (100MB) 超 | ビットレートを下げるかファイルを分割 |
| 429 | `rate_limited` | 時間あたり上限 (`adminSettings.rateLimit.documentsPerHour`) 超。`retryAfterSec` あり | `retryAfterSec` 秒後に再試行 |
| 502 | `upstream_error` | Gemini 側のエラー (利用者向けに読み替え済み) | しばらくして再試行。続くなら管理者へ |
| 503 | `not_configured` | サーバに `GEMINI_API_KEY` / 管理資格情報が無い | 管理者が Vercel の環境変数を確認 (runbook §5) |
| 504 | `upstream_timeout` | Gemini / Files API の待ち時間超過 | ファイルを小さくして再試行 |

## 6. 認証と所有権

| 呼び出し主体 | ヘッダ | 許される `storagePath` |
|---|---|---|
| ログインユーザー (uid) | `Authorization: Bearer <ID token>` | `audio/<uid>/…` のみ。`audio/GUEST/…` は 403 |
| 未ログイン (GUEST) | 無し | `audio/GUEST/…` のみ |
| トークン付きだが無効 | — | 401 (GUEST に格下げしない) |

未ログイン利用は製品仕様として維持する。GUEST ディレクトリは `storage.rules` でも誰でも読み書きできる共有領域なので、サーバ側の所有権チェックは「ログインユーザーが他人のディレクトリや GUEST を指せない」ことを担保する。

## 7. 時間あたり上限 (rate limit)

- 上限値: Firestore `adminSettings/config` の `rateLimit.documentsPerHour` (管理画面で変更可)。読み取りに失敗したら既定値 **50/時** で通し、警告ログを出す (fail-closed にはしない)。
- 主体 (subject):
  - ログイン: `uid`
  - 未ログイン: `guest:<送信元アドレスの SHA-256 先頭 16 桁>` (`GUEST_RATE_LIMIT_SUBJECT_PREFIX`)
- 記録: Firestore `rateLimits/{subject}` に「1 時間の固定窓の開始時刻と件数」。firebase-admin のトランザクションで更新する。`firestore.rules` に `rateLimits` の match は無い = クライアントからは読めない・書けない (既定 deny)。
- 超過時: 429 + `retryAfterSec` (窓の終わりまでの秒数)。

## 8. inline / Files API の切替と時間の上限

| 条件 | 経路 (`transport`) | 挙動 |
|---|---|---|
| Base64 化したサイズ + プロンプトが 16MiB (`INLINE_REQUEST_BUDGET_BYTES`) 以内 | `inline` | `inlineData` で 1 回の `generateContent` |
| 超える | `files_api` | Files API に upload → 状態が ACTIVE になるまでポーリング → `generateContent` → upload したファイルを削除 (失敗しても 48 時間で自動削除) |

- Route Handler は `export const runtime = 'nodejs'`、`export const maxDuration = 300`。**Vercel Hobby の上限が 300 秒**なので、Files API の ACTIVE 待ちを含めて 300 秒以内に収まらない処理は 504 になる。長い動画は音声に変換してから送る (README の推奨設定)。
- ブラウザ側は `AbortController` で fetch を切れるが、**サーバ側の処理は継続し得る** (中止しても Gemini の課金・上限カウントは消費されることがある)。

## 9. 観測ログ

成功時、サーバは次の JSON を **1 行** で `console.log` する。Vercel → Project → Logs (runtime logs) で検索できる。サーバ側で初めて取れる計器なので、コスト/レイテンシの実測はここから始める。

```json
{"usedModel":"gemini-3.8-flash","transport":"inline","usage":{"promptTokenCount":12345,"candidatesTokenCount":2345,"thoughtsTokenCount":512,"totalTokenCount":15202},"elapsedMs":18420}
```

失敗時は `createLogger('api/generate')` 系のログにエラーコードと Gemini の生メッセージを残す (利用者には返さない)。

## 10. 環境変数 (サーバ専用)

| 変数 | 必須 | 説明 |
|---|---|---|
| `GEMINI_API_KEY` | 必須 | Gemini API キー。無ければ全リクエストが 503 `not_configured` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | 本番では必須 | サービスアカウント JSON を **そのまま 1 行** か **base64**。無ければ Application Default Credentials にフォールバック (ローカル開発・エミュレータ用) |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | 必須 | admin SDK の projectId (ブラウザと共用) |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | 必須 | サーバが読む Storage バケット (ブラウザと共用) |
| `FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` / `FIREBASE_STORAGE_EMULATOR_HOST` | ローカルのみ | 設定されていれば admin SDK は自動でエミュレータを向く。**Vercel には設定しない** |

一覧と例は `.env.example`。Vercel への設定手順・キーのローテーションは `docs/ops-runbook.md` §5。

## 11. ローカルでの動かし方 (エミュレータ)

```bash
# 別ターミナルで
firebase emulators:start --only auth,firestore,storage --project <NEXT_PUBLIC_FIREBASE_PROJECT_ID>

# .env.local に (.env.example のコメントを参照)
#   GEMINI_API_KEY=<開発用キー>
#   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
#   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
#   FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199
npm run dev

# 疎通 (GUEST・ファイルは事前にエミュレータの Storage に置く)
curl -s -X POST http://localhost:3000/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"storagePath":"audio/GUEST/x.mp3","fileName":"x.mp3","mimeType":"audio/mpeg","prompt":{"name":"t","content":"要約して","model":"default","thinkingLevel":"default"}}'
```

Gemini 自体はエミュレートできないので、`GEMINI_API_KEY` には開発用の (本番と別の) キーを使う。
