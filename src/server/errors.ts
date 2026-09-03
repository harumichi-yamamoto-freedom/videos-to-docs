import type { GenerateErrorBody, GenerateErrorCode } from '@/lib/generateApiContract';

/** 契約のエラーコード → HTTP ステータス (generateApiContract.ts のコード表と対) */
export const GENERATE_ERROR_STATUS: Record<GenerateErrorCode, number> = {
    invalid_request: 400,
    unauthorized: 401,
    forbidden: 403,
    media_not_found: 404,
    media_too_large: 413,
    rate_limited: 429,
    upstream_error: 502,
    not_configured: 503,
    upstream_timeout: 504,
};

/**
 * サーバ各層 (auth / mediaSource / rateLimit / geminiServer) が投げる、利用者向け文言つきのエラー。
 * ルートはこれを捕まえて `GenerateErrorBody` + 対応ステータスに写す。
 * Gemini 等の生英文はここに入れず、logger にだけ残す。
 */
export class GenerateApiError extends Error {
    readonly code: GenerateErrorCode;
    readonly status: number;
    readonly retryAfterSec?: number;

    constructor(code: GenerateErrorCode, message: string, options: { retryAfterSec?: number; cause?: unknown } = {}) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = 'GenerateApiError';
        this.code = code;
        this.status = GENERATE_ERROR_STATUS[code];
        this.retryAfterSec = options.retryAfterSec;
    }

    toBody(): GenerateErrorBody {
        return {
            error: this.code,
            message: this.message,
            ...(this.retryAfterSec !== undefined && { retryAfterSec: this.retryAfterSec }),
        };
    }
}

export const isGenerateApiError = (error: unknown): error is GenerateApiError =>
    error instanceof GenerateApiError;
