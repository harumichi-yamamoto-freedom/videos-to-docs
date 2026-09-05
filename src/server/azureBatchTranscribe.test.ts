import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseBatchResult, getAzureCredentials, deleteBatchJob } from './azureBatchTranscribe';
import type { AzureBatchResult } from '@/lib/azureBatchContract';

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: warnMock }) }));

/**
 * 合成データのみ（架空・実顧客の発話は置かない）。バッチ結果の実際の形（recognizedPhrases /
 * nBest[0].display / offsetMilliseconds / speaker / combinedRecognizedPhrases）を写している。
 */
const sampleResult = (): AzureBatchResult => ({
    durationMilliseconds: 120_000,
    combinedRecognizedPhrases: [{ display: 'こんにちは。よろしくお願いします。' }],
    recognizedPhrases: [
        {
            offsetMilliseconds: 500,
            durationMilliseconds: 3000,
            speaker: 1,
            recognitionStatus: 'Success',
            nBest: [{ display: 'こんにちは。', confidence: 0.9, displayWords: [] }],
        },
        {
            offsetMilliseconds: 4000,
            durationMilliseconds: 2500,
            speaker: 2,
            recognitionStatus: 'Success',
            nBest: [{ display: 'よろしくお願いします。', confidence: 0.88, displayWords: [] }],
        },
    ],
});

describe('parseBatchResult', () => {
    it('句単位で注釈へ変換し、話者ラベルと秒を付ける', () => {
        const parsed = parseBatchResult(sampleResult());
        expect(parsed.status).toBe('completed');
        expect(parsed.audioSec).toBe(120);
        expect(parsed.annotations).toHaveLength(2);
        expect(parsed.annotations[0]).toMatchObject({
            startSec: 0.5,
            endSec: 3.5,
            speaker: 'spk:1',
        });
        expect(parsed.annotations[1]).toMatchObject({
            startSec: 4,
            endSec: 6.5,
            speaker: 'spk:2',
        });
        expect(parsed.speakers).toBe(2);
        expect(parsed.droppedPhrases).toBe(0);
    });

    it('本文は combinedRecognizedPhrases を優先する', () => {
        const parsed = parseBatchResult(sampleResult());
        expect(parsed.text).toContain('よろしくお願いします');
    });

    it('ticks のみの句も ms に変換して注釈へ残す', () => {
        const parsed = parseBatchResult({
            recognizedPhrases: [{
                offsetInTicks: 5_000_000,
                durationInTicks: 30_000_000,
                speaker: 1,
                nBest: [{ display: '合成の発話です。' }],
            }],
        });
        expect(parsed.annotations).toEqual([{
            text: '合成の発話です。',
            startSec: 0.5,
            endSec: 3.5,
            speaker: 'spk:1',
        }]);
        expect(parsed.droppedPhrases).toBe(0);
    });

    it('ms が数値でなければ ticks を使い、数値の ms は ticks より優先する', () => {
        const parsed = parseBatchResult({
            recognizedPhrases: [{
                offsetMilliseconds: 'invalid',
                durationMilliseconds: 2000,
                offsetInTicks: 10_000_000,
                durationInTicks: 90_000_000,
                nBest: [{ display: '時刻の補完です。' }],
            }],
        });
        expect(parsed.annotations[0]).toMatchObject({ startSec: 1, endSec: 3 });
        expect(parsed.droppedPhrases).toBe(0);
    });

    it('ms と ticks の両方が読めない句は落とす', () => {
        const parsed = parseBatchResult({
            recognizedPhrases: [{
                offsetMilliseconds: 'invalid',
                offsetInTicks: 'invalid',
                durationInTicks: 10_000_000,
                nBest: [{ display: '時刻不明の句です。' }],
            }],
        });
        expect(parsed.annotations).toHaveLength(0);
        expect(parsed.droppedPhrases).toBe(1);
    });

    it('combined が無ければ句を連結して本文にする', () => {
        const r = sampleResult();
        delete (r as { combinedRecognizedPhrases?: unknown }).combinedRecognizedPhrases;
        const parsed = parseBatchResult(r);
        expect(parsed.text.split('\n')).toHaveLength(2);
        expect(parsed.text).toContain('こんにちは');
    });

    it('🔴 時刻が読めない句は落とし、件数を返す（0 埋めしない）', () => {
        const r = sampleResult();
        (r.recognizedPhrases as unknown[]).push({
            // offsetMilliseconds 欠落
            durationMilliseconds: 1000,
            speaker: 1,
            nBest: [{ display: '欠けた句' }],
        });
        const parsed = parseBatchResult(r);
        expect(parsed.annotations).toHaveLength(2); // 落ちた 1 句は入らない
        expect(parsed.droppedPhrases).toBe(1);
    });

    it('話者が付かない句は speaker=null（本文は残す）', () => {
        const r: AzureBatchResult = {
            durationMilliseconds: 10_000,
            recognizedPhrases: [
                { offsetMilliseconds: 0, durationMilliseconds: 2000, nBest: [{ display: '話者なし' }] },
            ],
        };
        const parsed = parseBatchResult(r);
        expect(parsed.annotations[0].speaker).toBeNull();
        expect(parsed.annotations[0].text).toBe('話者なし');
        expect(parsed.speakers).toBe(0);
    });

    it('空の結果でも落ちない', () => {
        const parsed = parseBatchResult({});
        expect(parsed.annotations).toHaveLength(0);
        expect(parsed.audioSec).toBe(0);
        expect(parsed.text).toBe('');
    });
});

describe('deleteBatchJob', () => {
    const credentials = { endpoint: 'https://example.invalid', apiKey: 'synthetic-api-key' };
    const selfUrl = 'https://example.invalid/transcriptions/synthetic-job';

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it.each([200, 202, 204, 299, 404])('status %i は削除成功として警告しない', async (status) => {
        const fetchMock = vi.fn().mockResolvedValue({ status, text: async () => '' });
        vi.stubGlobal('fetch', fetchMock);

        await expect(deleteBatchJob(selfUrl, credentials)).resolves.toBeUndefined();

        expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'DELETE' }));
        expect(warnMock).not.toHaveBeenCalled();
    });

    it.each([199, 301, 401, 429, 500, 503])('status %i は警告しても例外を投げない', async (status) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            status,
            text: async () => JSON.stringify({ error: { message: 'synthetic upstream error' } }),
        }));

        await expect(deleteBatchJob(selfUrl, credentials)).resolves.toBeUndefined();

        expect(warnMock).toHaveBeenCalledExactlyOnceWith('バッチジョブの削除に失敗（TTL に任せる）', { status });
    });

    it('通信例外でも警告に留めて確定処理を止めない', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('synthetic network failure')));

        await expect(deleteBatchJob(selfUrl, credentials)).resolves.toBeUndefined();

        expect(warnMock).toHaveBeenCalledExactlyOnceWith('バッチジョブの削除に失敗（TTL に任せる）', {
            reason: 'synthetic network failure',
        });
    });
});

describe('getAzureCredentials', () => {
    const saved = { ep: process.env.AZURE_SPEECH_ENDPOINT, key: process.env.AZURE_SPEECH_KEY };
    afterEach(() => {
        process.env.AZURE_SPEECH_ENDPOINT = saved.ep;
        process.env.AZURE_SPEECH_KEY = saved.key;
    });

    it('未設定なら null（設定漏れと障害を混同しない）', () => {
        delete process.env.AZURE_SPEECH_ENDPOINT;
        delete process.env.AZURE_SPEECH_KEY;
        expect(getAzureCredentials()).toBeNull();
    });

    it('設定されていれば末尾スラッシュを落として返す', () => {
        process.env.AZURE_SPEECH_ENDPOINT = 'https://example.cognitiveservices.azure.com/';
        process.env.AZURE_SPEECH_KEY = 'k';
        expect(getAzureCredentials()).toEqual({
            endpoint: 'https://example.cognitiveservices.azure.com',
            apiKey: 'k',
        });
    });
});
