import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateErrorBody, GenerateResponseBody } from './generateApiContract';
import { GENERATE_API_PATH } from './generateApiContract';

const testDoubles = vi.hoisted(() => ({
    fetchImpl: vi.fn(),
    getIdToken: vi.fn(),
    /** firebase の auth.currentUser の代役。既定クレデンシャル経路のテストで差し替える */
    currentUser: null as null | { getIdToken: () => Promise<string> },
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('./firebase', () => ({
    auth: {
        get currentUser() {
            return testDoubles.currentUser;
        },
    },
}));

vi.mock('./logger', () => ({
    createLogger: () => testDoubles.logger,
}));

import { GeminiClient, type GenerateDocumentInput } from './gemini';

const okBody = (overrides: Partial<GenerateResponseBody> = {}): GenerateResponseBody => ({
    text: '# 生成結果',
    usedModel: 'gemini-resolved',
    thinkingLevel: 'MEDIUM',
    transport: 'inline',
    usage: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 35 },
    elapsedMs: 1234,
    ...overrides,
});

const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });

const baseInput = (overrides: Partial<GenerateDocumentInput> = {}): GenerateDocumentInput => ({
    storagePath: 'audio/user-1/123_sample.mp3',
    fileName: 'sample.mp3',
    mimeType: 'audio/mpeg',
    prompt: {
        name: '議事録',
        content: '議事録を作って',
        model: 'default',
        thinkingLevel: 'high',
    },
    ...overrides,
});

const createClient = () =>
    new GeminiClient({ fetchImpl: testDoubles.fetchImpl, getIdToken: testDoubles.getIdToken });

/** fetch に渡された init を型付きで取り出す */
const lastFetchCall = () => {
    const [url, init] = testDoubles.fetchImpl.mock.calls.at(-1) as [string, RequestInit];
    return { url, init, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
};

beforeEach(() => {
    testDoubles.fetchImpl.mockReset();
    testDoubles.getIdToken.mockReset().mockResolvedValue(null);
    testDoubles.currentUser = null;
    testDoubles.logger.info.mockReset();
    testDoubles.logger.warn.mockReset();
    testDoubles.logger.error.mockReset();
});

describe('GeminiClient.generateDocument リクエスト (#4 サーバ経由)', () => {
    it('契約のパスへ JSON POST し、本文に storagePath / mimeType / prompt をそのまま載せる', async () => {
        testDoubles.fetchImpl.mockResolvedValue(jsonResponse(200, okBody()));

        await createClient().generateDocument(baseInput());

        const { url, init, headers, body } = lastFetchCall();
        expect(url).toBe(GENERATE_API_PATH);
        expect(init.method).toBe('POST');
        expect(headers['content-type']).toBe('application/json');
        expect(body).toEqual({
            storagePath: 'audio/user-1/123_sample.mp3',
            fileName: 'sample.mp3',
            mimeType: 'audio/mpeg',
            prompt: { name: '議事録', content: '議事録を作って', model: 'default', thinkingLevel: 'high' },
        });
    });

    it('thinkingLevel 未指定は default として送る (サーバ側で解決する)', async () => {
        testDoubles.fetchImpl.mockResolvedValue(jsonResponse(200, okBody()));

        await createClient().generateDocument(baseInput({
            prompt: { name: 'p', content: 'c', model: 'gemini-2.5-flash' },
        }));

        expect(lastFetchCall().body.prompt.thinkingLevel).toBe('default');
    });

    it('ログイン中は ID トークンを Authorization: Bearer で付ける', async () => {
        testDoubles.getIdToken.mockResolvedValue('id-token-xyz');
        testDoubles.fetchImpl.mockResolvedValue(jsonResponse(200, okBody()));

        await createClient().generateDocument(baseInput());

        expect(lastFetchCall().headers.authorization).toBe('Bearer id-token-xyz');
    });

    it('未ログインは Authorization ヘッダを付けない (GUEST はサーバが判定する)', async () => {
        testDoubles.getIdToken.mockResolvedValue(null);
        testDoubles.fetchImpl.mockResolvedValue(jsonResponse(200, okBody()));

        await createClient().generateDocument(baseInput());

        expect(lastFetchCall().headers).not.toHaveProperty('authorization');
        expect(Object.keys(lastFetchCall().headers).map(key => key.toLowerCase())).not.toContain('authorization');
    });

    it('既定のトークン取得は auth.currentUser.getIdToken() を使う', async () => {
        testDoubles.currentUser = { getIdToken: vi.fn().mockResolvedValue('from-firebase') };
        testDoubles.fetchImpl.mockResolvedValue(jsonResponse(200, okBody()));

        await new GeminiClient({ fetchImpl: testDoubles.fetchImpl }).generateDocument(baseInput());

        expect(lastFetchCall().headers.authorization).toBe('Bearer from-firebase');
    });

    it('既定のトークン取得は未ログインなら null (ヘッダ無し)', async () => {
        testDoubles.currentUser = null;
        testDoubles.fetchImpl.mockResolvedValue(jsonResponse(200, okBody()));

        await new GeminiClient({ fetchImpl: testDoubles.fetchImpl }).generateDocument(baseInput());

        expect(lastFetchCall().headers).not.toHaveProperty('authorization');
    });

    it('AbortSignal を fetch に渡す', async () => {
        const controller = new AbortController();
        testDoubles.fetchImpl.mockResolvedValue(jsonResponse(200, okBody()));

        await createClient().generateDocument(baseInput({ signal: controller.signal }));

        expect(lastFetchCall().init.signal).toBe(controller.signal);
    });

    it('トークン取得に失敗したら API を呼ばずに利用者向け文言で失敗にする', async () => {
        testDoubles.getIdToken.mockRejectedValue(new Error('auth/network-request-failed'));

        const result = await createClient().generateDocument(baseInput());

        expect(result.success).toBe(false);
        expect(result.error).toContain('ログインし直して');
        expect(testDoubles.fetchImpl).not.toHaveBeenCalled();
    });
});

describe('GeminiClient.generateDocument 応答の写像', () => {
    it('200 は text / usedModel / thinkingLevel / transport / elapsedMs を TranscriptionResult に写す', async () => {
        testDoubles.fetchImpl.mockResolvedValue(jsonResponse(200, okBody({ transport: 'files_api' })));

        const result = await createClient().generateDocument(baseInput());

        expect(result).toEqual({
            success: true,
            text: '# 生成結果',
            usedModel: 'gemini-resolved',
            usedThinkingLevel: 'MEDIUM',
            transport: 'files_api',
            elapsedMs: 1234,
        });
    });

    it('usage を応答から取り出してログに残す', async () => {
        testDoubles.fetchImpl.mockResolvedValue(jsonResponse(200, okBody()));

        await createClient().generateDocument(baseInput());

        expect(testDoubles.logger.info).toHaveBeenCalledWith('Gemini API usage', {
            model: 'gemini-resolved',
            thinkingLevel: 'MEDIUM',
            transport: 'inline',
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 5,
            totalTokenCount: 35,
        });
    });

    it('契約と異なる 200 本文は成功にしない', async () => {
        testDoubles.fetchImpl.mockResolvedValue(jsonResponse(200, { unexpected: true }));

        const result = await createClient().generateDocument(baseInput());

        expect(result.success).toBe(false);
        expect(result.error).toContain('応答を読み取れません');
    });
});

describe('GeminiClient.generateDocument エラー応答', () => {
    const errorBody = (error: GenerateErrorBody['error'], message: string, retryAfterSec?: number): GenerateErrorBody => ({
        error,
        message,
        ...(retryAfterSec !== undefined && { retryAfterSec }),
    });

    it('429 は message に retryAfterSec を含めた文言で失敗にする', async () => {
        testDoubles.fetchImpl.mockResolvedValue(
            jsonResponse(429, errorBody('rate_limited', '1時間あたりの上限に達しました。', 90)),
        );

        const result = await createClient().generateDocument(baseInput());

        expect(result.success).toBe(false);
        expect(result.error).toBe('1時間あたりの上限に達しました。（約90秒後に再試行できます）');
    });

    it('429 の待ち時間が長いときは分で示す', async () => {
        testDoubles.fetchImpl.mockResolvedValue(
            jsonResponse(429, errorBody('rate_limited', '上限です。', 1800)),
        );

        const result = await createClient().generateDocument(baseInput());

        expect(result.error).toBe('上限です。（約30分後に再試行できます）');
    });

    it('403 はサーバの利用者向け文言をそのまま返す', async () => {
        testDoubles.fetchImpl.mockResolvedValue(
            jsonResponse(403, errorBody('forbidden', 'このファイルは別の利用者のものです。ログインし直してください。')),
        );

        const result = await createClient().generateDocument(baseInput());

        expect(result).toEqual({
            success: false,
            error: 'このファイルは別の利用者のものです。ログインし直してください。',
        });
    });

    it('503 (not_configured) もサーバの文言をそのまま返し、エラーログに status と code を残す', async () => {
        testDoubles.fetchImpl.mockResolvedValue(
            jsonResponse(503, errorBody('not_configured', 'サーバの設定が未完了です。管理者に連絡してください。')),
        );

        const result = await createClient().generateDocument(baseInput());

        expect(result.error).toBe('サーバの設定が未完了です。管理者に連絡してください。');
        expect(testDoubles.logger.error).toHaveBeenCalledWith(
            '文書生成 API がエラーを返却',
            expect.any(Error),
            expect.objectContaining({ status: 503, code: 'not_configured', fileName: 'sample.mp3' }),
        );
    });

    it.each([401, 404, 413, 502, 504])('契約外の %i (JSON でない本文) は状態別の既定文言で失敗にする', async (status) => {
        testDoubles.fetchImpl.mockResolvedValue(new Response('<html>gateway</html>', { status }));

        const result = await createClient().generateDocument(baseInput());

        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
        expect(result.error).not.toContain('<html>');
    });

    it('ネットワーク失敗 (fetch が reject) は接続確認の文言で失敗にする', async () => {
        testDoubles.fetchImpl.mockRejectedValue(new TypeError('Failed to fetch'));

        const result = await createClient().generateDocument(baseInput());

        expect(result).toEqual({
            success: false,
            error: 'ネットワークエラー: インターネット接続を確認してください。',
        });
    });

    it('中止 (signal) で fetch が落ちたときは失敗ではなく signal.reason を投げ直す', async () => {
        const controller = new AbortController();
        class ProcessingAbortedError extends Error {}
        testDoubles.fetchImpl.mockImplementation(async () => {
            controller.abort(new ProcessingAbortedError('ユーザー操作により中止されました。'));
            throw new DOMException('The operation was aborted.', 'AbortError');
        });

        await expect(
            createClient().generateDocument(baseInput({ signal: controller.signal })),
        ).rejects.toBeInstanceOf(ProcessingAbortedError);
    });

    it('中止理由が Error でなくても例外として投げる', async () => {
        const controller = new AbortController();
        testDoubles.fetchImpl.mockImplementation(async () => {
            controller.abort('string reason');
            throw new DOMException('The operation was aborted.', 'AbortError');
        });

        await expect(
            createClient().generateDocument(baseInput({ signal: controller.signal })),
        ).rejects.toThrow('処理が中止されました。');
    });
});
