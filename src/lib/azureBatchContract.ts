/**
 * Azure Speech **Batch transcription** (`transcriptions:submit`) の定数と応答の形。
 *
 * 🔴 なぜバッチか（2026-09-05 裁定）: 同期方式（MAI/Gemini をチャンク毎に 300 秒以内で回す）は、
 *    タイムアウト予算 595 秒 > Vercel 300 秒・MAI が 10 分チャンクで 0/3・無音チャンクで全滅・
 *    ブラウザ分割の ffmpeg メモリ肥大と並走クロストークなど、土台そのものに由来する障害が重なっていた。
 *    バッチは音声を**分割せず丸ごと**非同期で投げるので、これらがまとめて消える。
 *
 * ⚠️ トレードオフ（一次ソースで確認済み・L3 調査）:
 * - バッチは **標準モデル**のみ。`MAI-Transcribe-2` も Gemini も指定できない（Submit の要求本文に
 *   `enhancedMode` プロパティが無い）。用語集(phraseList)も無い（結合後の表記統一で代替・設計 §5.1）。
 * - "The service schedules batch transcription jobs on a best-effort basis. At peak hours, it might take
 *    up to 30 minutes for a transcription job to start processing and up to 24 hours to complete."
 *   実測（合成 23 分・2026-09-05）は提出→完了 9 分（実時間の 0.39 倍）。1〜2 時間で 20〜50 分の見込み。
 *   → **対話的に「その場で待つ」UX ではなく、「完了後に反映」型**にする。
 */

/** 非同期バッチの提出エンドポイント。`{endpoint}` はリソースのカスタムドメイン */
export const AZURE_BATCH_SUBMIT_PATH = '/speechtotext/transcriptions:submit';

/**
 * 🔴 Speech CLI は v3.2 のみだが REST は 2024-11-15 以降が正。料金ページ逐語:
 * "To take advantage of this new Batch Transcription pricing you need to use Speech to text REST API
 *  V3.2 or later versions." 2024-11-15 は `diarization`(enabled/maxSpeakers) を受け付ける新系。
 */
export const AZURE_BATCH_API_VERSION = '2024-11-15';

export const AZURE_BATCH_API_KEY_HEADER = 'Ocp-Apim-Subscription-Key';

/** バッチは BCP-47（`ja-JP`）。同期 MAI の 2 文字コードとは別。 */
export const AZURE_BATCH_LOCALE = 'ja-JP';

/** 話者分離の上限。商談は通常 2〜4 名。多すぎると過分割するので控えめに。 */
export const AZURE_BATCH_MAX_SPEAKERS = 4;

/**
 * 🔴 `timeToLiveHours` は **6 以上が必須**（実測: 未指定/6 未満は 400
 * "'properties.timeToLiveHours' must be greater than or equal to '6'"）。
 * 結果を取り終えたらこちらから削除するので長くは要らない。取り逃しの保険で 12。
 */
export const AZURE_BATCH_TTL_HOURS = 12;

/**
 * 音声の上限（話者分離有効時）。逐語: "When this property is selected, source audio length can't
 * exceed 240 minutes per file." サイズは 1 GB（Quotas 表）。
 */
export const AZURE_BATCH_MAX_AUDIO_SEC = 240 * 60;
export const AZURE_BATCH_MAX_AUDIO_BYTES = 1024 * 1024 * 1024;

/** ジョブの終端状態。`NotStarted`/`Running` は継続、`Succeeded`/`Failed` で確定。 */
export type AzureBatchStatus = 'NotStarted' | 'Running' | 'Succeeded' | 'Failed';

export const isTerminalBatchStatus = (s: string | undefined): s is 'Succeeded' | 'Failed' =>
    s === 'Succeeded' || s === 'Failed';

/** 提出時に組み立てる `properties`。1 か所でしか作らない（リテラルを散らさない）。 */
export const buildBatchProperties = (): Record<string, unknown> => ({
    diarization: { enabled: true, maxSpeakers: AZURE_BATCH_MAX_SPEAKERS },
    wordLevelTimestampsEnabled: true,
    displayFormWordLevelTimestampsEnabled: true,
    // 相槌・言い直しを落とさない。同期側の verbatim と揃える意図。
    punctuationMode: 'DictatedAndAutomatic',
    profanityFilterMode: 'None',
    timeToLiveHours: AZURE_BATCH_TTL_HOURS,
});

// --- 応答の形（緩く受ける。欠けたフィールドは読めなかったものとして扱う） ---

/** `recognizedPhrases[].nBest[].displayWords[]` の 1 語 */
export interface AzureBatchWord {
    displayText?: unknown;
    offsetMilliseconds?: unknown;
    durationMilliseconds?: unknown;
}

/** `recognizedPhrases[].nBest[]` の候補（先頭だけ使う） */
export interface AzureBatchNBest {
    display?: unknown;
    confidence?: unknown;
    displayWords?: unknown;
}

/** `recognizedPhrases[]` の 1 句 */
export interface AzureBatchPhrase {
    offsetMilliseconds?: unknown;
    durationMilliseconds?: unknown;
    speaker?: unknown;
    recognitionStatus?: unknown;
    nBest?: unknown;
}

/** 結果ファイル（`links.files` の kind==='Transcription'） */
export interface AzureBatchResult {
    durationMilliseconds?: unknown;
    combinedRecognizedPhrases?: unknown;
    recognizedPhrases?: unknown;
}
