# 処理フローと並列処理の詳細

## 📋 概要

このアプリケーションは、複数ファイルの処理を効率化するために、以下の3つのレベルで並列処理を実装しています：

1. **ファイルレベルの並列処理**
2. **プロンプトレベルの並列処理**
3. **Firestore保存の並列処理**

---

## 🔄 処理の全体フロー

### 1. エントリーポイント: `handleStartProcessing()`

```typescript
await Promise.all(
  selectedFiles.map((file, index) => processFile(file, index))
);
```

**動作：**
- 選択されたすべてのファイルを**並列で**処理開始
- 各ファイルは独立して処理される

**例：** 3つのファイル（A, B, C）を選択した場合
```
ファイルA: processFile(A, 0) ┐
ファイルB: processFile(B, 1) ├─ 並列実行
ファイルC: processFile(C, 2) ┘
```

---

## 📁 ファイルごとの処理フロー: `processFile()`

各ファイルは以下の**順次処理**で進行します：

### フェーズ1: 音声変換 (0-50%)

```typescript
const result = await converterRef.current!.convertToMp3(file.file, {
  bitrate,
  sampleRate,
  onProgress: (progress) => {
    // 進捗の0-50%を音声変換に割り当て
    setProgress(progress.ratio * 0.5);
  }
});
```

**動作：**
- FFmpeg.wasmを使用してMP3に変換
- **順次処理**（1ファイルずつ変換）
- リアルタイムで進捗を更新（0-50%）

**注意：** 
- FFmpegインスタンスは1つのため、内部的には順次処理される可能性があるが、
  JavaScriptのPromiseレベルでは並列にリクエストされる

---

### フェーズ2: 文書生成 (50-100%)

```typescript
await Promise.all(
  selectedPrompts.map(async (prompt) => {
    // 各プロンプトで並列に文書生成
    const result = await geminiClient.transcribeAudio(...);
    await saveTranscription(...); // Firestoreに保存
  })
);
```

**動作：**
- 選択されたプロンプトごとに**並列で**文書生成
- Gemini APIへのリクエストは並列実行
- Firestore保存も並列実行

**例：** 3つのプロンプト（詳細、議事録、要約）を選択した場合
```
プロンプト1（詳細）: Gemini API → Firestore ┐
プロンプト2（議事録）: Gemini API → Firestore ├─ 並列実行
プロンプト3（要約）: Gemini API → Firestore ┘
```

**進捗計算：**
```typescript
const progress = 0.5 + (completedPrompts / totalPrompts) * 0.5;
```
- 音声変換完了時点で50%
- プロンプトが完了するごとに残りの50%を分配

---

## 🔢 具体的な処理例

### シナリオ: 2ファイル × 3プロンプト

**選択内容：**
- ファイル: `video1.mp4`, `video2.mp4`
- プロンプト: P1（詳細）, P2（議事録）, P3（要約）

**処理の流れ：**

```
時刻 | ファイル1 (video1.mp4)              | ファイル2 (video2.mp4)
-----|---------------------------------------|---------------------------------------
t0   | 【開始】                             | 【開始】
     | ↓                                    | ↓
t1   | 🔵 音声変換中 (0-50%)                | 🔵 音声変換中 (0-50%)
     | FFmpeg.wasm で MP3 に変換             | FFmpeg.wasm で MP3 に変換
     | ↓                                    | ↓
t2   | 🟣 文書生成中 (50-100%)              | 🔵 音声変換中 (25%)
     | ├─ P1: Gemini API 呼び出し ─┐       | （並列で進行中）
     | ├─ P2: Gemini API 呼び出し ─┼─並列   |
     | └─ P3: Gemini API 呼び出し ─┘       |
     | ↓                                    | ↓
t3   | 🟣 文書生成中 (75%)                  | 🔵 音声変換完了 (50%)
     | P1 完了 → Firestore保存              | ↓
     | P2, P3 まだ処理中                    | 🟣 文書生成開始
     |                                      | ├─ P1: Gemini API 呼び出し ─┐
     |                                      | ├─ P2: Gemini API 呼び出し ─┼─並列
     |                                      | └─ P3: Gemini API 呼び出し ─┘
     | ↓                                    | ↓
t4   | 🟢 完了 (100%)                       | 🟣 文書生成中 (66%)
     | すべてのプロンプト完了                | P1, P2 完了、P3 処理中
     |                                      | ↓
t5   |                                      | 🟢 完了 (100%)
     |                                      | すべてのプロンプト完了
```

**ポイント：**
1. ファイル1とファイル2は**完全に独立して並列処理**
2. 各ファイル内では「音声変換」→「文書生成」の順次処理
3. 文書生成フェーズでは複数プロンプトが並列実行
4. Firestore保存は文書生成完了後すぐに実行（並列）

---

## ⚡ 並列処理のメリット

### 1. ファイルレベルの並列化
```javascript
// 順次処理の場合: 60秒 + 60秒 = 120秒
// 並列処理の場合: max(60秒, 60秒) = 60秒
// → 50%の時間短縮
```

### 2. プロンプトレベルの並列化
```javascript
// 順次処理の場合: 20秒 + 20秒 + 20秒 = 60秒
// 並列処理の場合: max(20秒, 20秒, 20秒) = 20秒
// → 66%の時間短縮
```

### 3. 実際の処理時間（推定）

**シングルファイル + シングルプロンプト:**
- 音声変換: 30秒
- 文書生成: 20秒
- 合計: **50秒**

**3ファイル × 3プロンプト:**
- **順次処理の場合:** (30秒 + 20秒×3) × 3 = 270秒（4.5分）
- **現在の並列処理:** 約30秒 + 20秒 = **50秒** 
  - ファイルは並列、プロンプトも並列のため、ほぼ1ファイル分の時間
  - **約80%の時間短縮！**

---

## 🔧 技術的な詳細

### Promise.all の使用箇所

#### 1. ファイルレベル
```typescript
// src/app/page.tsx: Line 144-146
await Promise.all(
  selectedFiles.map((file, index) => processFile(file, index))
);
```

#### 2. プロンプトレベル
```typescript
// src/app/page.tsx: Line 201-241
await Promise.all(
  selectedPrompts.map(async (prompt) => {
    const result = await geminiClient.transcribeAudio(...);
    await saveTranscription(...);
  })
);
```

### 進捗管理の仕組み

**状態管理：**
```typescript
interface FileProcessingStatus {
  fileName: string;
  status: 'waiting' | 'converting' | 'transcribing' | 'completed' | 'error';
  phase: 'waiting' | 'audio_conversion' | 'text_generation' | 'completed';
  progress: number; // 0.0 - 1.0
  transcriptionCount?: number; // 完了したプロンプト数
  totalTranscriptions?: number; // 総プロンプト数
}
```

**進捗の更新：**
1. 音声変換: `progress = ratio * 0.5` （0-50%）
2. 文書生成: `progress = 0.5 + (count / total) * 0.5` （50-100%）

---

## 🚨 制限と注意事項

### FFmpeg.wasm の制限
- **共有インスタンス:** 1つのFFmpegインスタンスを使用
- **並列変換:** Promise.allで並列リクエストするが、内部的には順次処理される可能性あり
- **メモリ使用:** 大容量ファイルを複数処理する場合、ブラウザのメモリ制限に注意

### Gemini API の制限
- **レート制限:** 1分あたり15リクエスト（無料枠）
- **並列リクエスト:** 多数のプロンプトを選択すると制限に達する可能性
- **推奨:** 1ファイルあたり2-3プロンプト程度

### Firestore の制限
- **書き込み制限:** 1秒あたり1回の書き込み（コレクションごと）
- **並列保存:** 複数文書を同時に保存するため、制限に注意

---

## 📊 パフォーマンス最適化のポイント

### 現在の実装の強み
✅ ファイル間の完全な並列処理  
✅ プロンプト間の並列処理  
✅ リアルタイムの進捗表示  
✅ 各ファイルのステータス独立管理  

### 今後の改善案
💡 FFmpegインスタンスのプーリング（複数インスタンス）  
💡 Gemini APIのリトライロジック  
💡 キャッシュ機能（同じファイルの再処理時）  
💡 バックグラウンド処理のサポート  

---

## 🔍 デバッグとモニタリング

### コンソールログの確認
```javascript
// 各フェーズで出力されるログ:
console.log('処理エラー:', error);
console.log('文書生成エラー:', transcriptionResult.error);
console.log('ファイル ${file.file.name} の処理エラー:', error);
```

### ブラウザ開発者ツールでの確認
1. **Network タブ:** Gemini APIとFirestoreへのリクエストを確認
2. **Console タブ:** エラーログと進捗ログを確認
3. **Performance タブ:** 処理時間のプロファイリング

---

## 📝 まとめ

**3段階の並列処理：**
1. 🔵 **ファイルレベル** → 複数ファイルを並列処理
2. 🟣 **プロンプトレベル** → 1ファイル内で複数プロンプトを並列処理
3. 🟢 **保存レベル** → 複数文書をFirestoreに並列保存

**処理順序：**
```
各ファイル: [音声変換] → [文書生成 × N個並列] → [完了]
全体: すべてのファイルが並列で上記を実行
```

この設計により、複数ファイル×複数プロンプトのシナリオで、最大80%以上の時間短縮を実現しています。

