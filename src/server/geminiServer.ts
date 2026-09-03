/**
 * サーバ側の Gemini 呼び出し (src/lib/gemini.ts の generateDocument / uploadMedia / deleteUploadedMedia の移植)。
 * キーは `GEMINI_API_KEY` (サーバ専用)。無ければ 503 not_configured。
 * inline / Files API の選択は inlineMediaBudget.selectMediaTransport をそのまま使う。
 * Gemini の生英文は logger にだけ残し、利用者には契約のコード表に対応する日本語を返す。
 */
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { resolveGeminiModel } from '@/constants/geminiModels';
import { resolveThinkingLevelForModel, type GeminiThinkingLevel } from '@/constants/geminiThinking';
import type { GenerateTransport, GenerateUsage } from '@/lib/generateApiContract';
import {
    INLINE_REQUEST_BUDGET_BYTES,
    selectMediaTransport,
    utf8ByteLength,
} from '@/lib/inlineMediaBudget';
import { createLogger } from '@/lib/logger';
import { GenerateApiError } from './errors';

const logger = createLogger('server/gemini');

/** Files API のファイルが ACTIVE になるのを待つ間隔と上限。route の maxDuration (300s) 内に収める */
export const FILES_API_ACTIVATION_POLL_MS = 2_000;
export const FILES_API_ACTIVATION_TIMEOUT_MS = 4 * 60 * 1000;

const THINKING_LEVEL_ENUMS = {
    LOW: ThinkingLevel.LOW,
    MEDIUM: ThinkingLevel.MEDIUM,
    HIGH: ThinkingLevel.HIGH,
} as const;

const VIDEO_DEFAULT_PROMPT = `
以下の動画ファイルの内容を分析し、以下の形式でMarkdown文書を作成してください：

# タイトル
（動画の主題を簡潔に）

## 要約
（内容の要約を3-5文で）

## 詳細な内容
（話されている内容を詳しく記述）

## キーポイント
- （重要なポイント1）
- （重要なポイント2）
- （重要なポイント3）

動画が日本語の場合は日本語で、英語の場合は英語で文書を作成してください。
`.trim();

const AUDIO_DEFAULT_PROMPT = `
以下の音声ファイルの内容を分析し、以下の形式でMarkdown文書を作成してください：

# タイトル
（音声の主題を簡潔に）

## 要約
（内容の要約を3-5文で）

## 詳細な内容
（話されている内容を詳しく記述）

## キーポイント
- （重要なポイント1）
- （重要なポイント2）
- （重要なポイント3）

音声が日本語の場合は日本語で、英語の場合は英語で文書を作成してください。
`.trim();

export const defaultPromptFor = (mimeType: string): string =>
    mimeType.startsWith('video/') ? VIDEO_DEFAULT_PROMPT : AUDIO_DEFAULT_PROMPT;

const NOT_CONFIGURED_MESSAGE = 'サーバに Gemini API キーが設定されていません。管理者に連絡してください。';

export function getGeminiApiKey(): string {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || !apiKey.trim()) {
        logger.error('GEMINI_API_KEY が未設定');
        throw new GenerateApiError('not_configured', NOT_CONFIGURED_MESSAGE);
    }
    return apiKey;
}

/** 生成前に「キーが在るか」だけ確かめる (上限カウントを消費する前に 503 を返すため) */
export const assertGeminiConfigured = (): void => {
    getGeminiApiKey();
};

/**
 * Gemini/Files API の生エラー文を契約のコードと利用者向け日本語へ写す。
 * 分岐は現行 gemini.ts の translateGeminiError を踏襲し、サーバでは「.env.local を確認」ではなく「管理者に連絡」にする。
 */
export function classifyGeminiError(error: unknown, targetModel: string): GenerateApiError {
    if (error instanceof GenerateApiError) return error;
    const raw = error instanceof Error ? error.message : String(error);
    const lower = raw.toLowerCase();

    if (lower.includes('deadline') || lower.includes('timed out') || lower.includes('timeout') || lower.includes('abort')) {
        return new GenerateApiError('upstream_timeout',
            '文書の生成が時間内に終わりませんでした。ファイルを短くするか、しばらくしてから再試行してください。', { cause: error });
    }
    if (raw.includes('API_KEY_INVALID') || raw.includes('API key not valid') || raw.includes('API key expired')) {
        return new GenerateApiError('not_configured',
            'サーバの Gemini API キーが無効です。管理者に連絡してください。', { cause: error });
    }
    if (raw.includes('PERMISSION_DENIED')) {
        return new GenerateApiError('upstream_error',
            'Gemini API へのアクセスが拒否されました。管理者に連絡してください。', { cause: error });
    }
    if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429') || lower.includes('quota')) {
        return new GenerateApiError('upstream_error',
            'Gemini API の利用枠が一時的に上限に達しています。数分待ってから再試行してください。', { cause: error });
    }
    if (raw.includes('not found') || raw.includes('404') || raw.includes('NOT_FOUND')) {
        return new GenerateApiError('upstream_error',
            `指定されたモデルが見つかりません（${targetModel}）。プロンプト設定のモデルを「おまかせ」に変えて再試行してください。`, { cause: error });
    }
    if (lower.includes('too large') || lower.includes('payload')) {
        return new GenerateApiError('upstream_error',
            '音声・動画データが大きすぎて Gemini に送れませんでした。ビットレートを下げるか、ファイルを分割してください。', { cause: error });
    }
    if (lower.includes('fetch') || lower.includes('network') || lower.includes('econnreset') || lower.includes('unavailable')) {
        return new GenerateApiError('upstream_error',
            'Gemini API に接続できませんでした。しばらくしてから再試行してください。', { cause: error });
    }
    return new GenerateApiError('upstream_error',
        '文書の生成中にエラーが発生しました。しばらくしてから再試行してください。', { cause: error });
}

export interface ServerGenerateInput {
    bytes: Buffer;
    mimeType: string;
    fileName: string;
    prompt: {
        name: string;
        content: string;
        model: string;
        thinkingLevel: GeminiThinkingLevel;
    };
}

export interface ServerGenerateResult {
    text: string;
    usedModel: string;
    thinkingLevel: string;
    transport: GenerateTransport;
    usage: GenerateUsage;
}

interface UploadedRef {
    name: string;
    fileUri: string;
    mimeType: string;
}

export interface GeminiServerOptions {
    apiKey?: string;
    pollIntervalMs?: number;
    activationTimeoutMs?: number;
    /** テスト用: 経過時間の時計 */
    now?: () => number;
}

export class GeminiServerClient {
    private readonly genAI: GoogleGenAI;
    private readonly pollIntervalMs: number;
    private readonly activationTimeoutMs: number;
    private readonly now: () => number;

    constructor(options: GeminiServerOptions = {}) {
        const apiKey = options.apiKey ?? getGeminiApiKey();
        this.genAI = new GoogleGenAI({ apiKey });
        this.pollIntervalMs = options.pollIntervalMs ?? FILES_API_ACTIVATION_POLL_MS;
        this.activationTimeoutMs = options.activationTimeoutMs ?? FILES_API_ACTIVATION_TIMEOUT_MS;
        this.now = options.now ?? Date.now;
    }

    /** Files API へ上げて ACTIVE になるまで待つ。時間超過は 504 */
    async uploadMedia(bytes: Buffer, mimeType: string, fileName: string): Promise<UploadedRef> {
        logger.info('Files API へアップロードを開始', {
            fileName, mimeType, sizeInMB: (bytes.length / 1024 / 1024).toFixed(2),
        });
        const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
        const uploaded = await this.genAI.files.upload({
            file: blob,
            config: { mimeType, displayName: fileName },
        });

        let current = uploaded;
        const deadline = this.now() + this.activationTimeoutMs;
        // state は SDK の FileState 列挙の文字列値。列挙オブジェクト経由にしないのはモック時の undefined 参照回避
        while ((current.state as string | undefined) === 'PROCESSING') {
            if (!current.name) {
                throw new Error('Files API returned no file name while PROCESSING');
            }
            if (this.now() >= deadline) {
                throw new GenerateApiError('upstream_timeout',
                    'Files API でのファイル処理が時間内に完了しませんでした。しばらくしてから再試行してください。');
            }
            await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
            current = await this.genAI.files.get({ name: current.name });
        }

        if ((current.state as string | undefined) === 'FAILED') {
            throw new Error(`Files API processing failed: ${current.error?.message ?? 'unknown'}`);
        }
        if (!current.uri || !current.name) {
            throw new Error('Files API returned no uri');
        }
        logger.info('Files API へのアップロードが完了', {
            fileName, name: current.name, state: current.state,
            sizeBytes: current.sizeBytes, expirationTime: current.expirationTime,
        });
        return { name: current.name, fileUri: current.uri, mimeType: current.mimeType ?? mimeType };
    }

    /** 失敗しても 48 時間で自動削除されるため、記録だけして例外にしない (best-effort) */
    async deleteUploadedMedia(name: string): Promise<void> {
        try {
            await this.genAI.files.delete({ name });
            logger.info('Files API のファイルを削除', { name });
        } catch (error) {
            logger.warn('Files API のファイル削除に失敗（48時間で自動削除される）', {
                name, error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /** generateContent の唯一の入口。サイズで inline / Files API を選び、Files API は生成後に削除する */
    async generate(input: ServerGenerateInput): Promise<ServerGenerateResult> {
        const { bytes, mimeType, fileName } = input;
        const targetModel = resolveGeminiModel(input.prompt.model);
        const resolvedThinkingLevel = resolveThinkingLevelForModel(input.prompt.thinkingLevel, targetModel);
        const usedThinkingLevel = resolvedThinkingLevel ?? 'unspecified';
        const promptText = input.prompt.content || defaultPromptFor(mimeType);
        const promptBytes = utf8ByteLength(promptText);

        if (bytes.length === 0) {
            throw new GenerateApiError('invalid_request',
                'アップロードされたファイルが空です。ファイルを選び直して、もう一度変換してください。');
        }

        const base64 = bytes.toString('base64');
        const transport: GenerateTransport = selectMediaTransport(base64.length, promptBytes);
        logger.info('送信経路を決定', {
            fileName, mimeType, transport, sizeBytes: bytes.length,
            base64LengthChars: base64.length, promptBytes, budgetBytes: INLINE_REQUEST_BUDGET_BYTES,
            modelName: targetModel, thinkingLevel: usedThinkingLevel, promptName: input.prompt.name,
        });

        let uploaded: UploadedRef | null = null;
        try {
            const mediaPart = transport === 'inline'
                ? { inlineData: { mimeType, data: base64 } }
                : await (async () => {
                    uploaded = await this.uploadMedia(bytes, mimeType, fileName);
                    return { fileData: { fileUri: uploaded.fileUri, mimeType: uploaded.mimeType } };
                })();

            const result = await this.genAI.models.generateContent({
                model: targetModel,
                ...(resolvedThinkingLevel && {
                    config: { thinkingConfig: { thinkingLevel: THINKING_LEVEL_ENUMS[resolvedThinkingLevel] } },
                }),
                contents: [{ role: 'user', parts: [{ text: promptText }, mediaPart] }],
            });

            const text = result.text ?? '';
            const usage: GenerateUsage = {
                promptTokenCount: result.usageMetadata?.promptTokenCount,
                candidatesTokenCount: result.usageMetadata?.candidatesTokenCount,
                thoughtsTokenCount: result.usageMetadata?.thoughtsTokenCount,
                totalTokenCount: result.usageMetadata?.totalTokenCount,
            };
            logger.info('Gemini API usage', { model: targetModel, thinkingLevel: usedThinkingLevel, ...usage });
            logger.info('文書生成が成功', { fileName, modelName: targetModel, transport, generatedTextLength: text.length });

            return { text, usedModel: targetModel, thinkingLevel: usedThinkingLevel, transport, usage };
        } catch (error) {
            logger.error('Gemini API 呼び出しでエラーが発生', error, { fileName, modelName: targetModel, transport });
            throw classifyGeminiError(error, targetModel);
        } finally {
            if (uploaded) {
                await this.deleteUploadedMedia((uploaded as UploadedRef).name);
            }
        }
    }
}
