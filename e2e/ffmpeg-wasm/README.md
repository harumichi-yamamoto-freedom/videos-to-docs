# e2e/ffmpeg-wasm — ブラウザ内 FFmpeg.wasm の実機検査

vitest では wasm を回せないので、本番と同じ `src/lib/ffmpeg.ts` / `src/lib/videoConversionService.ts` を
esbuild で束ね、Playwright の Chromium で実ファイルを流す。**CI では回さない**（数分・数 GB の入力が要る）。
`src/lib/ffmpeg.ts` か `videoConversionService.ts` を触ったら手で回す。

## 何を確かめるか（2026-09-22 の不具合）

- @ffmpeg/core 0.12.x は同一 worker で `exec` を約 65 回呼ぶと wasm が死ぬ（入力サイズ無関係、upstream #820）。
  旧実装の区間分割（1 本 = 62 回）は 2 本目で必ず崖を越え、「複数ファイルを入れると 2 本目がエラー」になっていた。
- 修正: 1 本 = probe 1 + 変換 1 の 2 exec、`FFMPEG_EXEC_BUDGET` で worker を作り直す、入力は WORKERFS でマウント
  （2GB 超が読める・レンダラのメモリ峰 2.4GB → 0.4GB）。

## 使い方

```bash
# リポジトリ直下
npm run copy-ffmpeg-core            # public/ffmpeg/ に core を置く（predev/prebuild でも走る）
npm run e2e:ffmpeg:build            # harness.ts → harness.js
cd e2e/ffmpeg-wasm && npm i && npm run install-browser

# 1. 本番と同じ経路で複数ファイルを連続変換（全部 OK になること）
node run.js real_x3 0 /path/a.mp4 /path/b.mp4 /path/c.mp4

# 2. 崖の再現（旧経路 convertSegmentToMp3 を 5 秒区間で 120 回。65 回目前後で必ず失敗する = 崖が在る証拠）
MODE=mount SEGLEN=5 node run.js cliff 0 /path/10min.mp4

# 3. 1 exec 変換の単体（進捗・時間・出力サイズ）
MODE=single node run.js single /path/a.mp4
```

結果は `results/<label>.json`（`results` は `OUT_DIR` で変えられる）。`rssPeakRendererMb` はレンダラ RSS の峰、
`consoleTail` はブラウザ console の末尾。

## 合格線

| 検査 | 期待 |
|---|---|
| 1 時間級の動画 3 本を連続（本番経路） | 3 本とも `ok: true`、`rssPeakRendererMb` < 1000 |
| 2GB 超の単一ファイル | `ok: true`（旧実装は `File could not be read` で 0 秒で落ちていた） |
| 崖の再現（旧経路 120 区間） | 60〜70 区間目で失敗する（崖の存在確認。ここが通るようになったら `FFMPEG_EXEC_BUDGET` を見直す） |

## 実測（2026-09-22、M1 系 Mac・Playwright Chromium）

| 入力 | 旧実装 | 修正後 |
|---|---|---|
| 3.6h/1.3GB → 2.0h/1.1GB（実録画） | 2 本目 区間 4 で `null function or function signature mismatch` | 両方 OK（`results/` 参照） |
| 6h/2.9GB 単体 | `File could not be read! Code=-1` | OK・207 秒・出力 258MB・RSS 0.46GB |
| 67MB を 5 秒区間 ×120（旧経路） | 65 回目で `memory access out of bounds` | 同じ（崖は core 側。作り直しで避ける） |

## ハーネス都合の差分

Next のバンドル外では @ffmpeg/ffmpeg の worker が module 型になり UMD の core を `importScripts` できないので、
`harness.ts` の `patchLoad` が coreURL だけ同版の ESM ビルド（unpkg）へ差し替える。wasm は同じ。
