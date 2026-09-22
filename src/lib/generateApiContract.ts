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

/** Storage 上のファイルサイズ上限 (storage.rules の 500MB と一致させる)。アップロードの可否はこれで決まる */
export const GENERATE_MAX_MEDIA_BYTES = 500 * 1024 * 1024;

/**
 * 同期の文書生成 (`POST /api/generate`) **だけ**に効く上限。
 *
 * 🔴 この経路はメディアを丸ごとサーバのメモリに載せる (Storage から Buffer で取得 → Blob 化 →
 *    inline か Files API へ送信)。ピーク常駐はファイルサイズの数倍になり、関数のメモリ上限
 *    (1〜2GB) を超えると OOM で落ちる。上限はこの経路が積むメモリで決める。
 * 🔴 GENERATE_MAX_MEDIA_BYTES (500MB) は **アップロード/Storage 側**の上限で、非同期の全文文字起こし
 *    (署名 URL を Azure に渡すだけで、サーバは本文を読まない) のために引き上げたもの。
 *    この経路の上限ではない。500MB をそのまま持ち込むと 1.5GB 前後を積んで落ちる。
 * 200MB なら、ピークがサイズの 2 倍になっても 400MB 程度で収まる。
 *
 * 🔴 超えても**アップロードと全文文字起こしはそのまま使える**。止まるのは文書生成だけなので、
 *    利用者向けの文言を「アップロードできない」と読ませないこと (mediaSource.syncGenerateTooLargeMessage)。
 */
export const GENERATE_SYNC_MAX_MEDIA_BYTES = 200 * 1024 * 1024;

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
    /**
     * `storagePath` に置いたデータの MIME (audio/* か video/*)。Gemini へ渡す種別と、既定プロンプトの
     * 音声/動画の選択 (server/geminiServer.ts defaultPromptFor) に使う。
     * 🔴 「元ファイルの MIME」ではない。動画をブラウザで mp3 に変換して上げたときは `audio/mpeg`
     *    (元の名前は `fileName` に残る)。動画直送のときだけ `video/*`。決めるのは
     *    hooks/useVideoProcessing.ts resolveMediaMimeType。
     */
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
 *   413 media_too_large   GENERATE_SYNC_MAX_MEDIA_BYTES 超 (同期経路はメモリに載せるので Storage 上限より低い)
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
