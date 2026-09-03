/**
 * 文書生成 API (`POST /api/generate`) のブラウザ側クライアント。
 *
 * #4: 以前はここで @google/genai を直接呼び、API キーが公開 JS に埋め込まれていた。
 * 今はブラウザは Firebase Storage に上げた音声/動画のパスとプロンプトだけをサーバへ渡し、
 * inline / Files API の経路選択・モデルのセンチネル解決・Gemini 呼び出しはすべてサーバが行う。
 * このファイルは Gemini SDK も API キーも持たない。
 */
import type { GeminiThinkingLevel } from '../constants/geminiThinking';
import { auth } from './firebase';
import { createLogger } from './logger';
import {
    GENERATE_API_PATH,
    GENERATE_AUTH_HEADER,
    type GenerateErrorBody,
    type GenerateErrorCode,
    type GenerateRequestBody,
    type GenerateResponseBody,
    type GenerateTransport,
    type GenerateUsage,
} from './generateApiContract';

const geminiLogger = createLogger('gemini');

export interface TranscriptionResult {
    success: boolean;
    text?: string;
    error?: string;
    usedModel?: string;
    usedThinkingLevel?: string;
    /** サーバが実際に使った送信経路 (観測用) */
    transport?: GenerateTransport;
    /** サーバ側の処理時間 (ms・観測用) */
    elapsedMs?: number;
}

export interface GenerateDocumentInput {
    /** Storage 上のパス (`audio/{ownerId}/{name}`)。所有権はサーバが検査する */
    storagePath: string;
    /** 元ファイル名 (ログとエラー文言用) */
    fileName: string;
    /** 元ファイルの MIME (audio/* か video/*)。Gemini へ渡す種別 */
    mimeType: string;
    prompt: {
        name: string;
        content: string;
        model: string;
        thinkingLevel?: GeminiThinkingLevel;
    };
    /** 中止用。fetch に渡す (サーバ側の処理は継続し得る) */
    signal?: AbortSignal;
}

/** サーバが契約どおりのエラー本文を返したとき。利用者向け文言は message に入っている */
export class GenerateApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: GenerateErrorCode | 'unknown',
        message: string,
        readonly retryAfterSec?: number,
    ) {
        super(message);
        this.name = 'GenerateApiError';
    }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GeminiClientOptions {
    /** テスト用。既定は globalThis.fetch */
    fetchImpl?: FetchLike;
    /** テスト用。既定は auth.currentUser?.getIdToken() (未ログインなら null) */
    getIdToken?: () => Promise<string | null>;
}

const defaultGetIdToken = async (): Promise<string | null> => {
    const user = auth.currentUser;
    if (!user) return null;
    return user.getIdToken();
};

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** 契約外の応答 (Vercel のゲートウェイエラー・HTML など) に対する状態別の既定文言 */
const fallbackMessageForStatus = (status: number): string => {
    if (status === 401) return 'ログインの有効期限が切れています。ログインし直してから、もう一度お試しください。';
    if (status === 403) return 'このファイルを処理する権限がありません。ログイン状態を確認してから、もう一度お試しください。';
    if (status === 404) return 'アップロードした音声/動画がサーバで見つかりませんでした。音声変換からやり直してください。';
    if (status === 413) return '音声/動画が大きすぎます。ビットレートを下げるか、ファイルを分割してください。';
    if (status === 429) return '短時間に処理できる件数の上限に達しました。しばらく待ってから、もう一度お試しください。';
    if (status === 503) return 'サーバの文書生成機能が準備できていません。管理者にお問い合わせください。';
    if (status === 504) return '文書生成が時間内に終わりませんでした。ファイルを短くするか、しばらくしてから再試行してください。';
    return `文書生成サーバがエラーを返しました（HTTP ${status}）。しばらくしてから、もう一度お試しください。`;
};

/** 429 の retryAfterSec を利用者向け文言に含める */
const describeRetryAfter = (message: string, retryAfterSec: number | undefined): string => {
    if (retryAfterSec === undefined || !Number.isFinite(retryAfterSec)) return message;
    const seconds = Math.max(1, Math.ceil(retryAfterSec));
    const wait = seconds >= 120 ? `約${Math.ceil(seconds / 60)}分後` : `約${seconds}秒後`;
    return `${message}（${wait}に再試行できます）`;
};

const isErrorBody = (value: unknown): value is GenerateErrorBody =>
    typeof value === 'object'
    && value !== null
    && typeof (value as GenerateErrorBody).error === 'string'
    && typeof (value as GenerateErrorBody).message === 'string';

const isResponseBody = (value: unknown): value is GenerateResponseBody =>
    typeof value === 'object'
    && value !== null
    && typeof (value as GenerateResponseBody).text === 'string'
    && typeof (value as GenerateResponseBody).usedModel === 'string';

async function parseJsonSafely(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return undefined;
    }
}

function logGeminiUsage(
    model: string,
    thinkingLevel: string,
    transport: GenerateTransport,
    usage: GenerateUsage | undefined,
): void {
    geminiLogger.info('Gemini API usage', {
        model,
        thinkingLevel,
        transport,
        promptTokenCount: usage?.promptTokenCount,
        candidatesTokenCount: usage?.candidatesTokenCount,
        thoughtsTokenCount: usage?.thoughtsTokenCount,
        totalTokenCount: usage?.totalTokenCount,
    });
}

/** fetch 自体の失敗 (接続不可・DNS・CORS) を利用者向けに読み替える */
const describeNetworkFailure = (error: unknown): string => {
    const raw = error instanceof Error ? error.message : String(error);
    geminiLogger.error('文書生成 API へ接続できませんでした', error);
    if (/fetch|network|offline/i.test(raw)) {
        return 'ネットワークエラー: インターネット接続を確認してください。';
    }
    return `文書生成サーバへ接続できませんでした: ${raw}`;
};

export class GeminiClient {
    private readonly fetchImpl: FetchLike;
    private readonly getIdToken: () => Promise<string | null>;

    constructor(options: GeminiClientOptions = {}) {
        this.fetchImpl = options.fetchImpl ?? defaultFetch;
        this.getIdToken = options.getIdToken ?? defaultGetIdToken;
    }

    /**
     * Storage 上のメディアとプロンプトをサーバに渡して文書を生成する。
     * 失敗は `{ success: false, error }` で返す (文言はそのまま利用者に見せてよい)。
     * 中止 (signal) だけは例外として投げ直し、呼び出し側が「失敗」と区別できるようにする。
     */
    async generateDocument(input: GenerateDocumentInput): Promise<TranscriptionResult> {
        const { storagePath, fileName, mimeType, prompt, signal } = input;

        const body: GenerateRequestBody = {
            storagePath,
            fileName,
            mimeType,
            prompt: {
                name: prompt.name,
                content: prompt.content,
                model: prompt.model,
                thinkingLevel: prompt.thinkingLevel ?? 'default',
            },
        };

        geminiLogger.info('文書生成 API を呼び出し', {
            fileName,
            storagePath,
            mimeType,
            promptName: prompt.name,
            promptLength: prompt.content.length,
            model: prompt.model,
            thinkingLevel: body.prompt.thinkingLevel,
        });

        let token: string | null;
        try {
            token = await this.getIdToken();
        } catch (error) {
            geminiLogger.error('ID トークンの取得に失敗', error, { fileName });
            return {
                success: false,
                error: 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。',
            };
        }

        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (token) {
            headers[GENERATE_AUTH_HEADER] = `Bearer ${token}`;
        }

        let response: Response;
        try {
            response = await this.fetchImpl(GENERATE_API_PATH, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                ...(signal && { signal }),
            });
        } catch (error) {
            if (signal?.aborted) {
                throw signal.reason instanceof Error ? signal.reason : new Error('処理が中止されました。');
            }
            return { success: false, error: describeNetworkFailure(error) };
        }

        const payload = await parseJsonSafely(response);

        if (!response.ok) {
            const apiError = isErrorBody(payload)
                ? new GenerateApiError(
                    response.status,
                    payload.error,
                    response.status === 429
                        ? describeRetryAfter(payload.message, payload.retryAfterSec)
                        : payload.message,
                    payload.retryAfterSec,
                )
                : new GenerateApiError(response.status, 'unknown', fallbackMessageForStatus(response.status));

            geminiLogger.error('文書生成 API がエラーを返却', apiError, {
                fileName,
                status: apiError.status,
                code: apiError.code,
                retryAfterSec: apiError.retryAfterSec,
            });
            return { success: false, error: apiError.message };
        }

        if (!isResponseBody(payload)) {
            geminiLogger.error('文書生成 API の応答が契約と異なる', undefined, { fileName, payload });
            return {
                success: false,
                error: '文書生成サーバの応答を読み取れませんでした。しばらくしてから、もう一度お試しください。',
            };
        }

        logGeminiUsage(payload.usedModel, payload.thinkingLevel, payload.transport, payload.usage);
        geminiLogger.info('文書生成が成功', {
            fileName,
            modelName: payload.usedModel,
            transport: payload.transport,
            elapsedMs: payload.elapsedMs,
            generatedTextLength: payload.text.length,
        });

        return {
            success: true,
            text: payload.text,
            usedModel: payload.usedModel,
            usedThinkingLevel: payload.thinkingLevel,
            transport: payload.transport,
            elapsedMs: payload.elapsedMs,
        };
    }
}
