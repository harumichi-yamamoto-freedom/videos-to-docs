import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_GEMINI_MODEL,
    GEMINI_DEFAULT_MODEL_SENTINEL,
} from '../constants/geminiModels';
import type { GeminiThinkingLevel } from '../constants/geminiThinking';

const testDoubles = vi.hoisted(() => ({
    generateContent: vi.fn(),
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
    },
}));

vi.mock('./logger', () => ({
    createLogger: () => testDoubles.logger,
}));

import { GeminiClient, TranscriptionResult } from './gemini';

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
