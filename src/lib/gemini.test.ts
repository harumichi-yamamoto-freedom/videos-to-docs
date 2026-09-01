import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_GEMINI_MODEL,
    GEMINI_DEFAULT_MODEL_SENTINEL,
} from '../constants/geminiModels';

const testDoubles = vi.hoisted(() => ({
    generateContent: vi.fn(),
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('@google/genai', () => ({
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
) => Promise<TranscriptionResult>;

const METHOD_CASES: Array<{
    name: string;
    invoke: InvokeGeminiMethod;
    expectedModelInfoLogs: number;
}> = [
    {
        name: 'transcribeVideo',
        expectedModelInfoLogs: 3,
        invoke: (client, model) => client.transcribeVideo(
            new Blob(['video'], { type: 'video/mp4' }),
            'video.mp4',
            'テスト用プロンプト',
            model,
        ),
    },
    {
        name: 'transcribeAudio',
        expectedModelInfoLogs: 3,
        invoke: (client, model) => client.transcribeAudio(
            new Blob(['audio'], { type: 'audio/mpeg' }),
            'audio.mp3',
            'テスト用プロンプト',
            model,
        ),
    },
    {
        name: 'transcribeWithBase64',
        expectedModelInfoLogs: 2,
        invoke: (client, model) => client.transcribeWithBase64(
            'ZmFrZQ==',
            'audio/mpeg',
            'audio.mp3',
            'テスト用プロンプト',
            model,
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
            });
            expect(testDoubles.generateContent).toHaveBeenCalledTimes(1);
            expect(testDoubles.generateContent).toHaveBeenCalledWith(
                expect.objectContaining({ model: DEFAULT_GEMINI_MODEL }),
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
            expect(result.usedModel).toBe(unknownModel);

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
});
