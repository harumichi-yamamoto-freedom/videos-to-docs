import { describe, it, expect, afterEach } from 'vitest';
import { parseBatchResult, getAzureCredentials } from './azureBatchTranscribe';
import type { AzureBatchResult } from '@/lib/azureBatchContract';

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
