/**
 * アダプタの錠。
 *
 * ここが緩むと、**壊れた文字起こしが「成功」として保存される**。
 * 下流（下書き・保存・冪等）は分岐を知らないので、成功/失敗の判定はここが最後の砦。
 */
import { describe, expect, it, vi } from 'vitest';
import { runTranscriptPipeline } from './transcriptPipelineAdapter';
import type { VideoConverter } from '@/lib/ffmpeg';

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// useTranscriptionJob は storage 経由で firebase を引く。SDK 初期化だけ差し替える
vi.mock('@/lib/firebase', () => ({
    db: { name: 'mock' }, auth: { currentUser: null }, storage: { name: 'mock' },
}));

const converter = {} as VideoConverter;
const file = new File(['x'], 'call.mp3', { type: 'audio/mpeg' });

const jobResult = (over: Record<string, unknown> = {}) => ({
    ok: true, aborted: false, durationSec: 8700, noiseFloorDb: -34.9, silenceThresholdDb: -39.9,
    chunks: [{}, {}], failedChunkIndexes: [], cachedRuns: [],
    merged: { segments: [], gaps: [] }, invariants: { ok: true, violations: [] },
    markdown: '[00:00](#t=0) **営業** こんにちは。', ...over,
});

const runJob = (result: Record<string, unknown>) =>
    vi.fn(async () => result) as unknown as Parameters<typeof runTranscriptPipeline>[0]['runJob'];

describe('成功のとき', () => {
    it('本文を返し、使用モデルを記録する', async () => {
        const r = await runTranscriptPipeline({ file, converter, runJob: runJob(jobResult()) });
        expect(r.success).toBe(true);
        expect(r.text).toContain('#t=0');
        expect(r.usedModel).toBe('gemini-3.5-transcribe');
    });
});

describe('🔴 成功にしてはいけない場合', () => {
    it('失敗チャンクが1本でもあれば成功にしない', async () => {
        const r = await runTranscriptPipeline({
            file, converter, runJob: runJob(jobResult({ ok: false, failedChunkIndexes: [3] })),
        });
        expect(r.success).toBe(false);
        expect(r.error).toContain('1 個の区間');
    });

    it('🔴 ただし本文は捨てない — 取れたところまでは読める', async () => {
        const r = await runTranscriptPipeline({
            file, converter, runJob: runJob(jobResult({ ok: false, failedChunkIndexes: [3] })),
        });
        expect(r.text).toContain('#t=0');
    });

    it('🔴 結合の不変条件が破れていたら成功にしない（黙って壊れた結合を保存させない）', async () => {
        const r = await runTranscriptPipeline({
            file, converter,
            runJob: runJob(jobResult({ invariants: { ok: false, violations: ['start が単調でない'] } })),
        });
        expect(r.success).toBe(false);
        expect(r.text).toContain('#t=0');
    });

    it('中止は中止として伝える', async () => {
        const r = await runTranscriptPipeline({
            file, converter, runJob: runJob(jobResult({ ok: false, aborted: true })),
        });
        expect(r.success).toBe(false);
        expect(r.error).toContain('中止');
    });

    it('変換器が無ければ成功にしない', async () => {
        const r = await runTranscriptPipeline({ file, converter: null, runJob: runJob(jobResult()) });
        expect(r.success).toBe(false);
    });

    it('例外は握り潰さず失敗として返す（既存の失敗経路に乗せる）', async () => {
        const throwing = vi.fn(async () => { throw new Error('ffmpeg が落ちました'); });
        const r = await runTranscriptPipeline({
            file, converter,
            runJob: throwing as unknown as Parameters<typeof runTranscriptPipeline>[0]['runJob'],
        });
        expect(r.success).toBe(false);
        expect(r.error).toContain('ffmpeg');
    });
});
