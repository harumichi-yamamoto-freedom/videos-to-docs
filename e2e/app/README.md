# e2e/app — デプロイ前の画面通し検査（Playwright + Firebase エミュレータ）

本番に触れずに、利用者の操作を最初から最後まで通す。**main へマージする前・Vercel の Production を昇格する前に回す。**

## 何を守るか

| spec | 守る不変条件 |
|---|---|
| `smoke.spec.ts` | 全画面が desktop / mobile で描画される。console error・pageerror・横スクロール・axe の critical/serious が無い。**ブラウザ SDK がエミュレータに向いている**（本番に触れない tripwire） |
| `guest-generate.spec.ts` | ゲストが mp3 → プロンプト → 生成 → 保存 → 文書一覧まで通る。サーバへ渡す `storagePath` / MIME / プロンプト / 認証ヘッダが契約どおり。複数プロンプトは並列で件数分保存される |
| `video-conversion.spec.ts` | ブラウザ内 FFmpeg.wasm の実経路。core は同一オリジン。**動画と音声を同時に入れても両方完了する（PR #62 の回帰）**。音声無し動画の文言。中止 → 再開 |
| `generate-errors.spec.ts` | 503 / 429 / 413 / 契約外 502 / ネットワーク断が、契約の文言のまま利用者に届き、次の手（再開・再変換）が出る |
| `auth.spec.ts` | アカウント作成 → ゲストの文書が見えない → ログイン中の生成は自分の所有 + 認証ヘッダ → ログアウトで戻る |
| `prompts.spec.ts` | 空 DB の初回訪問で自動生成された既定プロンプトが選択肢にも出る（2026-09-22 に直した不整合の回帰）。新規作成が即反映 |

外部 API（Gemini / Azure）は `page.route` で差し替える。鍵は要らない。サーバ側の分類・認可は vitest（`src/app/api/**`, `src/server/**`）が守る。

## 使い方

```bash
# 初回
brew install ffmpeg           # テスト用メディアの生成に使う (無ければメディアを使う spec は skip)
brew install openjdk          # Firebase エミュレータに Java が要る (PATH に /opt/homebrew/opt/openjdk/bin)
cd e2e/app && npm i && npm run install-browser

# 実行 (エミュレータと next dev を自動起動。既に動いていれば再利用)
cd e2e/app && npm test
npm test -- tests/smoke.spec.ts      # 1 本だけ
npm run report                       # 失敗時の trace / screenshot
```

リポジトリ直下からは `npm run e2e:app`。

## 前提と罠

- ブラウザ側 SDK をエミュレータへ向けるのは `NEXT_PUBLIC_FIREBASE_USE_EMULATOR=1`（`src/lib/firebase.ts`）。`playwright.config.ts` の `webServer.env` が `.env.local` より優先されるので、開発者の `.env.local` に本番の値があっても本番へは書かない。**ただし既に別の `next dev` が同じポートで動いていると再利用される**ので、その dev がどの env で起動したかは自分で確かめること。`smoke.spec` の tripwire はそのための検査。
- エミュレータの状態は spec 間で共有する。各 spec の `beforeAll` で `resetEmulators()` してから種をまく。並列にしない（`workers: 1`）。
- 動画変換は wasm 実機なので 1 本 1〜2 分かかる。`timeout` は 180 秒。
- CI では回していない（Java・ffmpeg・数分の実行時間）。GitHub Actions に載せるなら `ubuntu-latest` に `temurin` と `ffmpeg` を入れ、`npx playwright install --with-deps chromium` を足す。
