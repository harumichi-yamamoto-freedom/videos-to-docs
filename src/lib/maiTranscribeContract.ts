/**
 * `MAI-Transcribe-2` (Azure Speech / Microsoft Foundry) の定数と応答の形。
 *
 * 🔴 **主エンジンはこちら、Gemini はフォールバック**（設計 §3.7・2026-09-04 東野裁定）。
 * Gemini では用語集が話者分離・単語タイムスタンプと排他だが (§1.5)、MAI は 3 つ同時に成立する。
 * 対照群つきで実測済み: 用語集なし「青井建設」→ `phraseList.phrases` ありで「アオイ建設」。
 *
 * ⚠️ **public preview で SLA が無い**。逐語:
 * "This preview is provided without a service-level agreement, and is not recommended for
 *  production workloads." だからこそフォールバックを必ず持つ。
 */

/** 同期の文字起こしエンドポイント。`{endpoint}` はリソースのカスタムドメイン */
export const MAI_TRANSCRIBE_PATH = '/speechtotext/transcriptions:transcribe';

export const MAI_API_VERSION = '2025-10-15';

export const MAI_API_KEY_HEADER = 'Ocp-Apim-Subscription-Key';

export const MAI_MODEL = 'MAI-Transcribe-2';

/** Gemini 側 (`ja-JP`) と揃える。MAI は 2 文字コード */
export const MAI_LOCALES = ['ja'] as const;

/**
 * 🔴 相槌・言い直しを落とさない。Gemini 側の `verbatim` と揃えるため。
 * `clean` にすると読みやすくなるが、商談の記録としては削られたことが分からない。
 */
export const MAI_TRANSCRIBE_STYLE = 'verbatim';

/** 単語単位の時刻。話者ラベルは注釈経由でしか使えないので必須 */
export const MAI_TIMESTAMPS = 'word';

/**
 * 🔴 同期 API はサーバ側で **約 120 秒**で打ち切られる (実測: 408 になった走の所要が
 * 全走 121.7〜122.0 秒で揃っていた)。10 分チャンクの実測は 85〜116 秒で、
 * これがそのまま上限に近い。**チャンク長を伸ばすときは必ず測り直すこと。**
 * ここはそれより短く切って、我々の側で先に諦めてフォールバックへ回す。
 */
export const MAI_REQUEST_TIMEOUT_MS = 115 * 1000;

/** 音声ファイルの上限 (公式: less than 300 MB) */
export const MAI_MAX_AUDIO_BYTES = 300 * 1024 * 1024;

/** どのエンジンが起こしたか。文書の記録と計器に必ず残す */
export type TranscribeEngine = 'mai' | 'gemini';

/** `phrases[].words[]` の 1 語 */
export interface MaiWord {
    text?: unknown;
    offsetMilliseconds?: unknown;
    durationMilliseconds?: unknown;
}

/** `phrases[]` の 1 句。`speaker` は話者分離が有効なときだけ付く */
export interface MaiPhrase {
    speaker?: unknown;
    offsetMilliseconds?: unknown;
    durationMilliseconds?: unknown;
    text?: unknown;
    words?: unknown;
}

export interface MaiTranscribeResponse {
    durationMilliseconds?: unknown;
    combinedPhrases?: unknown;
    phrases?: unknown;
}
