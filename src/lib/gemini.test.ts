import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_GEMINI_MODEL,
    GEMINI_DEFAULT_MODEL_SENTINEL,
} from '../constants/geminiModels';
import type { GeminiThinkingLevel } from '../constants/geminiThinking';

const testDoubles = vi.hoisted(() => ({
    generateContent: vi.fn(),
    filesUpload: vi.fn(),
    filesGet: vi.fn(),
    filesDelete: vi.fn(),
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('@google/genai', () => ({
    ThinkingLevel: {
        LOW: 'SDK_LOW',
        MEDIUM: 'SDK_MEDIUM',
        HIGH: 'SDK_HIGH',
    },
    GoogleGenAI: class {
        models = { generateContent: testDoubles.generateContent };
        files = {
            upload: testDoubles.filesUpload,
            get: testDoubles.filesGet,
            delete: testDoubles.filesDelete,
        };
    },
}));

vi.mock('./logger', () => ({
    createLogger: () => testDoubles.logger,
}));

import { GeminiClient, TranscriptionResult } from './gemini';
import { INLINE_REQUEST_BUDGET_BYTES } from './inlineMediaBudget';

type InvokeGeminiMethod = (
    client: GeminiClient,
    model: string,
    thinkingLevel?: GeminiThinkingLevel,
) => Promise<TranscriptionResult>;

const METHOD_CASES: Array<{
    name: string;
    invoke: InvokeGeminiMethod;
    expectedModelInfoLogs: number;
}> = [
    {
        name: 'transcribeVideo',
        expectedModelInfoLogs: 3,
        invoke: (client, model, thinkingLevel) => client.transcribeVideo(
            new Blob(['video'], { type: 'video/mp4' }),
            'video.mp4',
            'テスト用プロンプト',
            model,
            thinkingLevel,
        ),
    },
    {
        name: 'transcribeAudio',
        expectedModelInfoLogs: 3,
        invoke: (client, model, thinkingLevel) => client.transcribeAudio(
            new Blob(['audio'], { type: 'audio/mpeg' }),
            'audio.mp3',
            'テスト用プロンプト',
            model,
            thinkingLevel,
        ),
    },
    {
        name: 'transcribeWithBase64',
        expectedModelInfoLogs: 2,
        invoke: (client, model, thinkingLevel) => client.transcribeWithBase64(
            'ZmFrZQ==',
            'audio/mpeg',
            'audio.mp3',
            'テスト用プロンプト',
            model,
            thinkingLevel,
        ),
    },
];

function createClient(): GeminiClient {
    const client = new GeminiClient();
    Object.defineProperty(client, 'blobToBase64', {
        value: vi.fn().mockResolvedValue('ZmFrZQ=='),
    });
    return client;
}

describe('GeminiClient のモデル解決配線', () => {
    beforeEach(() => {
        vi.stubEnv('NEXT_PUBLIC_GEMINI_API_KEY', 'test-api-key');
        testDoubles.generateContent.mockReset();
        testDoubles.generateContent.mockResolvedValue({ text: 'ok' });
        testDoubles.logger.info.mockReset();
        testDoubles.logger.warn.mockReset();
        testDoubles.logger.error.mockReset();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it.each(METHOD_CASES)(
        '$name は default 相当値を解決して generateContent へ渡す',
        async ({ invoke, expectedModelInfoLogs }) => {
            const result = await invoke(createClient(), ' default ');

            expect(result).toEqual({
                success: true,
                text: 'ok',
                usedModel: DEFAULT_GEMINI_MODEL,
                usedThinkingLevel: 'MEDIUM',
            });
            expect(testDoubles.generateContent).toHaveBeenCalledTimes(1);
            expect(testDoubles.generateContent).toHaveBeenCalledWith(
                expect.objectContaining({
                    model: DEFAULT_GEMINI_MODEL,
                    config: {
                        thinkingConfig: {
                            thinkingLevel: 'SDK_MEDIUM',
                        },
                    },
                }),
            );

            const loggedModelNames = testDoubles.logger.info.mock.calls
                .map(call => call[1] as Record<string, unknown> | undefined)
                .filter(metadata => metadata && 'modelName' in metadata)
                .map(metadata => metadata?.modelName);
            expect(loggedModelNames).toHaveLength(expectedModelInfoLogs);
            expect(loggedModelNames).toEqual(
                Array(loggedModelNames.length).fill(DEFAULT_GEMINI_MODEL),
            );
        },
    );

    it.each(METHOD_CASES)(
        '$name の404文言とエラーログは解決済みモデルを使う',
        async ({ invoke }) => {
            testDoubles.generateContent.mockRejectedValueOnce(new Error('404 not found'));

            const result = await invoke(createClient(), ' default ');

            expect(result.success).toBe(false);
            expect(result.error).toContain(DEFAULT_GEMINI_MODEL);
            expect(result.error).not.toContain(`（${GEMINI_DEFAULT_MODEL_SENTINEL}）`);
            expect(testDoubles.logger.error).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(Error),
                expect.objectContaining({ modelName: DEFAULT_GEMINI_MODEL }),
            );
        },
    );

    it.each(METHOD_CASES)(
        '$name は未知の具体的なモデル ID をAPI直前でも加工しない',
        async ({ invoke, expectedModelInfoLogs }) => {
            const unknownModel = '  future-gemini-model  ';

            const result = await invoke(createClient(), unknownModel);

            expect(testDoubles.generateContent).toHaveBeenCalledWith(
                expect.objectContaining({ model: unknownModel }),
            );
            expect(testDoubles.generateContent.mock.calls[0][0]).not.toHaveProperty('config');
            expect(result.usedModel).toBe(unknownModel);
            expect(result.usedThinkingLevel).toBe('unspecified');

            const loggedModelNames = testDoubles.logger.info.mock.calls
                .map(call => call[1] as Record<string, unknown> | undefined)
                .filter(metadata => metadata && 'modelName' in metadata)
                .map(metadata => metadata?.modelName);
            expect(loggedModelNames).toHaveLength(expectedModelInfoLogs);
            expect(loggedModelNames).toEqual(
                Array(expectedModelInfoLogs).fill(unknownModel),
            );
        },
    );

    it.each(METHOD_CASES)(
        '$name の404文言とエラーログは未知の具体IDも加工しない',
        async ({ invoke }) => {
            const unknownModel = '  future-gemini-model  ';
            testDoubles.generateContent.mockRejectedValueOnce(new Error('404 not found'));

            const result = await invoke(createClient(), unknownModel);

            expect(result.error).toContain(unknownModel);
            expect(testDoubles.logger.error).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(Error),
                expect.objectContaining({ modelName: unknownModel }),
            );
        },
    );

    it.each(METHOD_CASES)(
        '$name は Gemini 3.7 系へ指定した thinkingLevel を付与し、実送信値を返す',
        async ({ invoke }) => {
            const result = await invoke(createClient(), 'gemini-3.7-future-preview', 'high');

            expect(testDoubles.generateContent).toHaveBeenCalledWith(
                expect.objectContaining({
                    model: 'gemini-3.7-future-preview',
                    config: {
                        thinkingConfig: {
                            thinkingLevel: 'SDK_HIGH',
                        },
                    },
                }),
            );
            expect(result.usedThinkingLevel).toBe('HIGH');
        },
    );

    it.each(METHOD_CASES)(
        '$name は非対象の Gemini 2.5 系へ thinkingConfig を付けず unspecified を返す',
        async ({ invoke }) => {
            const result = await invoke(createClient(), 'gemini-2.5-flash', 'high');

            expect(testDoubles.generateContent).toHaveBeenCalledTimes(1);
            expect(testDoubles.generateContent.mock.calls[0][0]).toEqual(
                expect.objectContaining({ model: 'gemini-2.5-flash' }),
            );
            expect(testDoubles.generateContent.mock.calls[0][0]).not.toHaveProperty('config');
            expect(result.usedThinkingLevel).toBe('unspecified');
        },
    );

    it.each(METHOD_CASES)(
        '$name は成功時に thinking token を含む usageMetadata を記録する',
        async ({ invoke }) => {
            testDoubles.generateContent.mockResolvedValueOnce({
                text: 'ok',
                usageMetadata: {
                    promptTokenCount: 101,
                    candidatesTokenCount: 202,
                    thoughtsTokenCount: 303,
                    totalTokenCount: 606,
                },
            });

            await invoke(createClient(), DEFAULT_GEMINI_MODEL, 'low');

            expect(testDoubles.generateContent.mock.calls[0][0]).toHaveProperty(
                'config.thinkingConfig.thinkingLevel',
                'SDK_LOW',
            );
            expect(testDoubles.logger.info).toHaveBeenCalledWith('Gemini API usage', {
                model: DEFAULT_GEMINI_MODEL,
                thinkingLevel: 'LOW',
                promptTokenCount: 101,
                candidatesTokenCount: 202,
                thoughtsTokenCount: 303,
                totalTokenCount: 606,
            });
        },
    );

    it.each(METHOD_CASES)(
        '$name は usageMetadata がなくても undefined 安全にログを記録する',
        async ({ invoke }) => {
            await invoke(createClient(), 'gemini-2.5-flash', 'medium');

            expect(testDoubles.logger.info).toHaveBeenCalledWith('Gemini API usage', {
                model: 'gemini-2.5-flash',
                thinkingLevel: 'unspecified',
                promptTokenCount: undefined,
                candidatesTokenCount: undefined,
                thoughtsTokenCount: undefined,
                totalTokenCount: undefined,
            });
        },
    );
});

describe('GeminiClient inline 予算の事前検査 (S2-1)', () => {
    beforeEach(() => {
        vi.stubEnv('NEXT_PUBLIC_GEMINI_API_KEY', 'test-api-key');
        testDoubles.generateContent.mockReset();
        testDoubles.generateContent.mockResolvedValue({ text: 'ok' });
        testDoubles.logger.info.mockReset();
        testDoubles.logger.warn.mockReset();
        testDoubles.logger.error.mockReset();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    const oversizedBase64 = () => 'a'.repeat(INLINE_REQUEST_BUDGET_BYTES + 1);

    it('予算を超える Base64 は generateContent を呼ばずに、実行可能な文言で失敗にする', async () => {
        const result = await new GeminiClient().transcribeWithBase64(
            oversizedBase64(),
            'audio/mpeg',
            'long.mp3',
            'テスト用プロンプト',
            'gemini-test',
            'default',
            '128k',
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('ビットレート 128k では約13分を超えると失敗します');
        expect(result.error).toContain('ビットレートを下げる');
        expect(testDoubles.generateContent).not.toHaveBeenCalled();
        expect(testDoubles.logger.error).toHaveBeenCalledWith(
            'inline 予算を超えるため generateContent を呼ばずに中止',
            undefined,
            expect.objectContaining({ fileName: 'long.mp3', budgetBytes: INLINE_REQUEST_BUDGET_BYTES }),
        );
    });

    it('ビットレート未指定でもサイズの目安つきで失敗にする', async () => {
        const result = await new GeminiClient().transcribeWithBase64(
            oversizedBase64(),
            'audio/mpeg',
            'long.mp3',
            'テスト用プロンプト',
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('約12MB');
        expect(testDoubles.generateContent).not.toHaveBeenCalled();
    });

    it('予算内の Base64 は従来どおり inlineData で送る', async () => {
        const result = await new GeminiClient().transcribeWithBase64(
            'ZmFrZQ==',
            'audio/mpeg',
            'short.mp3',
            'テスト用プロンプト',
        );

        expect(result.success).toBe(true);
        const request = testDoubles.generateContent.mock.calls[0][0] as {
            contents: Array<{ parts: Array<Record<string, unknown>> }>;
        };
        expect(request.contents[0].parts[1]).toEqual({
            inlineData: { mimeType: 'audio/mpeg', data: 'ZmFrZQ==' },
        });
    });

    it.each([
        ['transcribeVideo', (client: GeminiClient) => client.transcribeVideo(new Blob(['v'], { type: 'video/mp4' }), 'v.mp4')],
        ['transcribeAudio', (client: GeminiClient) => client.transcribeAudio(new Blob(['a'], { type: 'audio/mpeg' }), 'a.mp3')],
    ] as const)('%s も同じ事前検査を通る', async (_name, invoke) => {
        const client = new GeminiClient();
        Object.defineProperty(client, 'blobToBase64', {
            value: vi.fn().mockResolvedValue(oversizedBase64()),
        });

        const result = await invoke(client);

        expect(result.success).toBe(false);
        expect(result.error).toContain('ビットレートを下げる');
        expect(testDoubles.generateContent).not.toHaveBeenCalled();
    });

    it('API 側の payload 超過エラーも「大きすぎます」で終わらせず、打てる手を示す', async () => {
        testDoubles.generateContent.mockRejectedValue(
            new Error('Request payload size exceeds the limit: 20971520 bytes.'),
        );

        const result = await new GeminiClient().transcribeWithBase64(
            'ZmFrZQ==',
            'audio/mpeg',
            'short.mp3',
            'テスト用プロンプト',
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('ビットレートを下げる');
        expect(result.error).not.toContain('より小さいファイルを使用してください');
    });
});

describe('GeminiClient Files API 経路 (S2-1・要ライブ検証)', () => {
    beforeEach(() => {
        vi.stubEnv('NEXT_PUBLIC_GEMINI_API_KEY', 'test-api-key');
        testDoubles.generateContent.mockReset();
        testDoubles.generateContent.mockResolvedValue({ text: 'ok' });
        testDoubles.filesUpload.mockReset();
        testDoubles.filesGet.mockReset();
        testDoubles.filesDelete.mockReset();
        testDoubles.logger.info.mockReset();
        testDoubles.logger.warn.mockReset();
        testDoubles.logger.error.mockReset();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('transcribeWithFileUri は inlineData ではなく fileData で参照を渡す', async () => {
        const result = await new GeminiClient().transcribeWithFileUri(
            'https://generativelanguage.googleapis.com/v1beta/files/abc',
            'audio/mpeg',
            'long.mp3',
            'テスト用プロンプト',
            'gemini-test',
        );

        expect(result).toMatchObject({ success: true, text: 'ok' });
        const request = testDoubles.generateContent.mock.calls[0][0] as {
            contents: Array<{ parts: Array<Record<string, unknown>> }>;
        };
        expect(request.contents[0].parts).toEqual([
            { text: 'テスト用プロンプト' },
            {
                fileData: {
                    fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
                    mimeType: 'audio/mpeg',
                },
            },
        ]);
    });

    it('uploadMedia は Blob を upload し、ACTIVE になるまで get で待って参照を返す', async () => {
        const blob = new Blob(['audio'], { type: 'audio/mpeg' });
        testDoubles.filesUpload.mockResolvedValue({ name: 'files/abc', state: 'PROCESSING' });
        testDoubles.filesGet
            .mockResolvedValueOnce({ name: 'files/abc', state: 'PROCESSING' })
            .mockResolvedValueOnce({
                name: 'files/abc',
                uri: 'https://files/abc',
                mimeType: 'audio/mpeg',
                state: 'ACTIVE',
            });

        const ref = await new GeminiClient().uploadMedia(blob, 'long.mp3', { pollIntervalMs: 0 });

        expect(ref).toEqual({ name: 'files/abc', fileUri: 'https://files/abc', mimeType: 'audio/mpeg' });
        expect(testDoubles.filesUpload).toHaveBeenCalledWith({
            file: blob,
            config: { mimeType: 'audio/mpeg', displayName: 'long.mp3' },
        });
        expect(testDoubles.filesGet).toHaveBeenCalledTimes(2);
        expect(testDoubles.filesGet).toHaveBeenCalledWith({ name: 'files/abc' });
    });

    it('最初から ACTIVE なら get を呼ばない', async () => {
        testDoubles.filesUpload.mockResolvedValue({
            name: 'files/abc',
            uri: 'https://files/abc',
            mimeType: 'audio/mpeg',
            state: 'ACTIVE',
        });

        const ref = await new GeminiClient().uploadMedia(
            new Blob(['audio'], { type: 'audio/mpeg' }),
            'long.mp3',
        );

        expect(ref.fileUri).toBe('https://files/abc');
        expect(testDoubles.filesGet).not.toHaveBeenCalled();
    });

    it('FAILED になったら理由つきで投げる', async () => {
        testDoubles.filesUpload.mockResolvedValue({
            name: 'files/abc',
            state: 'FAILED',
            error: { message: 'unsupported codec' },
        });

        await expect(
            new GeminiClient().uploadMedia(new Blob(['audio'], { type: 'audio/mpeg' }), 'long.mp3'),
        ).rejects.toThrow('Files API でのファイル処理に失敗しました: unsupported codec');
    });

    it('URI を返さない応答は失敗にする', async () => {
        testDoubles.filesUpload.mockResolvedValue({ name: 'files/abc', state: 'ACTIVE' });

        await expect(
            new GeminiClient().uploadMedia(new Blob(['audio'], { type: 'audio/mpeg' }), 'long.mp3'),
        ).rejects.toThrow('Files API がファイルURIを返しませんでした。');
    });

    it('中止シグナルを upload に渡し、待機中に中止されたらその理由で投げる', async () => {
        const controller = new AbortController();
        testDoubles.filesUpload.mockImplementation(async () => {
            controller.abort(new Error('画面を離れたため処理を中止しました。'));
            return { name: 'files/abc', state: 'PROCESSING' };
        });

        await expect(
            new GeminiClient().uploadMedia(
                new Blob(['audio'], { type: 'audio/mpeg' }),
                'long.mp3',
                { signal: controller.signal, pollIntervalMs: 0 },
            ),
        ).rejects.toThrow('画面を離れたため処理を中止しました。');
        expect(testDoubles.filesUpload.mock.calls[0][0]).toMatchObject({
            config: { abortSignal: controller.signal },
        });
        expect(testDoubles.filesGet).not.toHaveBeenCalled();
    });

    it('処理待ちが上限を超えたら投げる', async () => {
        testDoubles.filesUpload.mockResolvedValue({ name: 'files/abc', state: 'PROCESSING' });
        testDoubles.filesGet.mockResolvedValue({ name: 'files/abc', state: 'PROCESSING' });

        await expect(
            new GeminiClient().uploadMedia(
                new Blob(['audio'], { type: 'audio/mpeg' }),
                'long.mp3',
                { pollIntervalMs: 0, timeoutMs: 0 },
            ),
        ).rejects.toThrow('時間内に完了しませんでした');
    });

    it('deleteUploadedMedia は失敗しても投げずに記録だけする', async () => {
        testDoubles.filesDelete.mockRejectedValue(new Error('gone'));

        await expect(new GeminiClient().deleteUploadedMedia('files/abc')).resolves.toBeUndefined();
        expect(testDoubles.filesDelete).toHaveBeenCalledWith({ name: 'files/abc' });
        expect(testDoubles.logger.warn).toHaveBeenCalledWith(
            'Files API のファイル削除に失敗（48時間で自動削除される）',
            expect.objectContaining({ name: 'files/abc', error: 'gone' }),
        );
    });
});
