/**
 * サーバ経由の文書生成 API (`POST /api/generate`) の契約。
 *
 * 背景 (#4 / S1-2): これまでブラウザが Gemini を直接呼び、API キーが公開 JS に埋め込まれていた。
 * 本契約以降、ブラウザは音声を Firebase Storage に上げてから「どのファイルをどのプロンプトで」だけを
 * サーバに頼み、サーバが認証・所有権・時間あたり上限を確認して Gemini を呼ぶ。キーはサーバ専用。
 *
 * このファイルは型と定数だけ (実装は持たない)。サーバ (src/app/api/generate, src/server/*) と
 * クライアント (src/lib/gemini.ts, src/hooks/useVideoProcessing.ts) の両方がここを import する。
 */
import type { GeminiThinkingLevel } from '@/constants/geminiThinking';

export const GENERATE_API_PATH = '/api/generate';

/** サーバが受け付ける入力メディアの MIME (Storage 上の contentType ではなく、元ファイルの種別) */
export const GENERATE_ALLOWED_MIME_PREFIXES = ['audio/', 'video/'] as const;

/** Storage 上のファイルサイズ上限 (storage.rules の 100MB と一致させる) */
export const GENERATE_MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export interface GenerateRequestPrompt {
    /** 監査ログ・エラー文言用の表示名 */
    name: string;
    /** プロンプト本文 */
    content: string;
    /** 保存表現 ('default' センチネル可)。サーバ側で resolveGeminiModel する */
    model: string;
    /** 保存表現 ('default' 可)。サーバ側で resolveThinkingLevelForModel する */
    thinkingLevel: GeminiThinkingLevel;
}

export interface GenerateRequestBody {
    /**
     * Firebase Storage 上のパス。`audio/{ownerId}/{name}` 形式で、
     * ログイン時は ownerId が自分の uid、未ログイン時は 'GUEST' でなければ 403。
     */
    storagePath: string;
    /** 元ファイル名 (ログとエラー文言用) */
    fileName: string;
    /** 元ファイルの MIME (audio/* か video/*)。Gemini へ渡す種別 */
    mimeType: string;
    prompt: GenerateRequestPrompt;
}

/** サーバが実際に使った送信経路 */
export type GenerateTransport = 'inline' | 'files_api';

export interface GenerateUsage {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
}

export interface GenerateResponseBody {
    text: string;
    /** 実際に使ったモデル ID (センチネル解決後) */
    usedModel: string;
    /** 実際に使った思考レベル ('LOW' | 'MEDIUM' | 'HIGH' | 'NONE' 相当の文字列) */
    thinkingLevel: string;
    transport: GenerateTransport;
    usage: GenerateUsage;
    /** サーバ側の処理時間 (ms)。観測用 */
    elapsedMs: number;
}

/**
 * エラー応答。HTTP ステータスと対で使う:
 *   400 invalid_request   入力不正 (パス形式・MIME・本文欠落)
 *   401 unauthorized      ID トークンが無効/期限切れ (未ログインは 401 ではなく GUEST 扱い)
 *   403 forbidden         storagePath の所有者が呼び出し主体と一致しない
 *   404 media_not_found   Storage にファイルが無い
 *   413 media_too_large   GENERATE_MAX_MEDIA_BYTES 超
 *   429 rate_limited      時間あたり上限 (adminSettings.rateLimit.documentsPerHour) 超。retryAfterSec あり
 *   502 upstream_error    Gemini 側のエラー (メッセージは利用者向けに読み替え済み)
 *   503 not_configured    サーバに GEMINI_API_KEY / 管理資格情報が無い
 *   504 upstream_timeout  Gemini/Files API の待ち時間超過
 */
export type GenerateErrorCode =
    | 'invalid_request'
    | 'unauthorized'
    | 'forbidden'
    | 'media_not_found'
    | 'media_too_large'
    | 'rate_limited'
    | 'upstream_error'
    | 'not_configured'
    | 'upstream_timeout';

export interface GenerateErrorBody {
    error: GenerateErrorCode;
    /** 利用者にそのまま見せてよい日本語文 (次に何をすべきかを含む) */
    message: string;
    /** 429 のとき: 何秒後に再試行できるか */
    retryAfterSec?: number;
}

/** 認証ヘッダ: ログイン時は `Authorization: Bearer <Firebase ID token>`。未ログインは付けない。 */
export const GENERATE_AUTH_HEADER = 'authorization';

/**
 * 未ログイン (GUEST) の時間あたり上限は uid が無いので「送信元アドレスのハッシュ」を主体にする。
 * サーバはこのプレフィックスで rateLimits/{subject} を分ける。
 */
export const GUEST_RATE_LIMIT_SUBJECT_PREFIX = 'guest:';
