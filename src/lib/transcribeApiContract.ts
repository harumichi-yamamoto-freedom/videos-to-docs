/**
 * チャンク単位の文字起こし (Interactions API) の契約。型と定数だけを持ち、実装は持たない。
 *
 * 背景 (P1): 長尺音声を 25 分前後のチャンクに割って `gemini-3.5-transcribe` に投げ、
 * 逐語テキストと語単位の注釈 (話者・タイムスタンプ) を取り出す。
 * サーバ (src/server/transcribeChunk.ts, src/app/api/*) と品質ゲート (src/lib/transcriptQuality.ts) が
 * 共通で参照する。
 *
 * 🔴 このファイルが「1 か所」である理由:
 *   `diarization_mode` と `timestamp_granularities` は API 側で値が検証されない (silent fail-open)。
 *   綴りを間違えても 400 にならず、話者ラベルが全部 null / 注釈 0 件のまま HTTP 200 が返る。
 *   よってこれらの文字列リテラルをコード中に散らさず、必ずここの定数を import して使う。
 */

/** Interactions API のエンドポイント (Files API の uri を入力に取る) */
export const TRANSCRIBE_INTERACTIONS_URL =
    'https://generativelanguage.googleapis.com/v1beta/interactions';

/** 文字起こし専用モデル */
export const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';

/** 認証は Gemini API キーのヘッダ渡し (URL クエリには載せない) */
export const TRANSCRIBE_API_KEY_HEADER = 'x-goog-api-key';

/** 言語指定。配列で渡す (単一言語でも配列) */
export const TRANSCRIBE_LANGUAGE_CODES = ['ja-JP'] as const;

/**
 * 🔴 silent fail-open する 3 つの値。ここでしか綴らない。
 * - `type` は必須。無いと 400。`transcription_config` 直下に置いても 400 (`Unknown parameter 'type'`)。
 * - `diarization_mode` / `timestamp_granularities` は検証されない。誤綴りは 200 + 空の注釈で返る。
 */
export const TRANSCRIBE_MODE_TYPE = 'verbatim';
export const TRANSCRIBE_DIARIZATION_MODE = 'speaker';
export const TRANSCRIBE_TIMESTAMP_GRANULARITIES = ['word'] as const;

/** 入力音声は Files API 経由に固定 (インラインは実務上約 20MB/15 分が上限で、25 分チャンクは入らない) */
export type TranscribeTransport = 'files_api';

/** リクエスト JSON の形 (実測で通る形をそのまま型にしたもの) */
export interface TranscribeRequestBody {
    model: string;
    input: Array<{
        type: 'audio';
        uri: string;
        mime_type: string;
    }>;
    generation_config: {
        transcription_config: {
            language_codes: readonly string[];
            mode: {
                type: string;
                diarization_mode: string;
                timestamp_granularities: readonly string[];
            };
        };
    };
}

/**
 * 語単位の注釈。`start_index` / `end_index` は本文テキスト上の位置、
 * `start_offset` / `end_offset` は `"3.900s"` 形式の文字列。
 */
export interface RawTranscriptAnnotation {
    start_index?: number;
    end_index?: number;
    text?: string;
    start_offset?: string;
    end_offset?: string;
    speaker?: string | null;
    type?: string;
}

/** 呼び出し側 (品質ゲート) が使う形。オフセットは秒に直してある */
export interface TranscriptAnnotation {
    /** 連結後の本文テキスト上の開始位置 */
    startIndex?: number;
    /** 連結後の本文テキスト上の終了位置 */
    endIndex?: number;
    text?: string;
    /** 秒。`"3.900s"` を数値に直したもの。読めなければ undefined */
    startSec?: number;
    endSec?: number;
    /** `"spk:0"` など。話者分離が効いていなければ null/undefined */
    speaker?: string | null;
    type?: string;
}

/**
 * 文字起こし 1 チャンクの結果。品質ゲート (src/lib/transcriptQuality.ts) が必要とする形。
 * このモジュールはゲートを呼ばず、この形を返すところまでを担う。
 */
export interface TranscribeChunkResult {
    /** API の `status` をそのまま (`"completed"` / `"incomplete"` など)。無ければ `'unknown'` */
    status: string;
    /** `steps[].content[].text` を連結した本文 */
    text: string;
    /** `steps[].content[].annotations[]` を連結・秒変換したもの。0 件もそのまま 0 件 */
    annotations: TranscriptAnnotation[];
    /** チャンクの音声長 (秒)。呼び出し側指定が無ければ注釈の最大 `endSec` から導く。導けなければ undefined */
    audioSec?: number;
    /**
     * 🔴 出力トークン数。`usage.total_output_tokens` は上限到達時でも常に 0 を返すので使わない。
     * 正しい出所は `usage.model_invocation_token_counts[].candidates_tokens_details[]` のうち
     * `modality === 'text'` の `tokenCount` の合計。取れなければ undefined (0 に丸めない)。
     */
    outputTokens?: number;
    /** 暗黙キャッシュの検出用。`usage.total_cached_tokens` をそのまま。無ければ undefined */
    cachedTokens?: number;
    transport: TranscribeTransport;
}
