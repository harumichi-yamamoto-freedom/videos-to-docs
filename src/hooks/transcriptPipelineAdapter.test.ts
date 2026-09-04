/**
 * アダプタの錠。
 *
 * ここが緩むと、**壊れた文字起こしが「成功」として保存される**。
 * 下流（下書き・保存・冪等）は分岐を知らないので、成功/失敗の判定はここが最後の砦。
 */
import { describe, expect, it, vi } from 'vitest';
import { buildTranscriptionJobDeps, runTranscriptPipeline, summarizeChunkFailures } from './transcriptPipelineAdapter';
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
    chunks: [{}, {}], failedChunkIndexes: [], cachedRuns: [], fallbackChunks: [],
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
        expect(r.usedModel).toBe('MAI-Transcribe-2');
    });

    it('🔴 フォールバックした区間があれば、両方のエンジンを記録に残す', async () => {
        // 用語集は MAI でしか効かない。片方だけ書くと、用語が効いていない区間がある事実が消える
        const r = await runTranscriptPipeline({
            file, converter,
            runJob: runJob(jobResult({ fallbackChunks: [{ chunkIndex: 1, reason: 'MAI timeout' }] })),
        });
        expect(r.success).toBe(true);
        expect(r.usedModel).toContain('MAI-Transcribe-2');
        expect(r.usedModel).toContain('gemini-3.5-transcribe');
        expect(r.usedModel).toContain('1/2');
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

/**
 * 🔴 本番の依存が実際に組まれていることの錠。
 *
 * 以前は `{ converter, ...deps } as TranscriptionJobDeps` と**型を黙らせて**いたため、
 * `scanSilence` などが 1 つも配線されないまま tsc もテストも緑で、
 * 本番だけ `scanSilence is not a function` で落ちていた（2026-09-04・実ブラウザで発見）。
 */
describe('🔴 buildTranscriptionJobDeps — 本番の配線', () => {
    const converter = {
        getFfmpeg: () => ({
            writeFile: vi.fn(), exec: vi.fn(), deleteFile: vi.fn(), on: vi.fn(), off: vi.fn(),
        }),
        convertSegmentToMp3: vi.fn(),
    } as unknown as Parameters<typeof buildTranscriptionJobDeps>[0];

    it('必要な依存が 1 つ残らず関数として揃っている', () => {
        const deps = buildTranscriptionJobDeps(converter);
        for (const key of ['scanSilence', 'uploadChunk', 'deleteChunk', 'postChunk'] as const) {
            expect(typeof deps[key], key).toBe('function');
        }
        expect(deps.converter).toBe(converter);
    });

    it('🔴 ffmpeg の取り出しは走査するときまで遅らせる（組み立てだけで load を要求しない）', async () => {
        const spy = vi.fn(() => ({
            writeFile: vi.fn(), exec: vi.fn(async () => undefined), deleteFile: vi.fn(),
            on: vi.fn(), off: vi.fn(),
        }));
        const deps = buildTranscriptionJobDeps(
            { getFfmpeg: spy } as unknown as Parameters<typeof buildTranscriptionJobDeps>[0],
        );
        expect(spy).not.toHaveBeenCalled();
        await deps.scanSilence(new File([new Uint8Array(1)], 'a.mp3'), { durationSec: 10 }).catch(() => {});
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

/**
 * 🔴 原因を名指ししない警報は、鳴っていても直らない。
 * 実害 (2026-09-04): 本番で 9 区間が落ちたが、文言が件数だけで、
 * サーバのログ保持窓も過ぎており、理由をどこからも追えなかった。
 */
describe('summarizeChunkFailures', () => {
    const chunk = (status: string, attempts: unknown[]) =>
        ({ status, attempts }) as unknown as Parameters<typeof summarizeChunkFailures>[0][number];

    it('落ちたゲートを名指しし、件数の多い順に並べる', () => {
        const r = summarizeChunkFailures([
            chunk('failed', [{ quality: { failedGates: ['G6'] } }]),
            chunk('failed', [{ quality: { failedGates: ['G6'] } }]),
            chunk('failed', [{ error: 'fetch failed' }]),
            chunk('completed', [{}]),
        ]);
        expect(r.text).toBe('品質検査 G6 2件・通信または処理の失敗 1件');
        expect(r.counts).toEqual({ '品質検査 G6': 2, '通信または処理の失敗': 1 });
    });

    it('🔴 最後の試行の落ち方を採る（再試行で様式が変わる）', () => {
        const r = summarizeChunkFailures([
            chunk('failed', [{ error: 'timeout' }, { quality: { failedGates: ['G3'] } }]),
        ]);
        expect(r.text).toBe('品質検査 G3 1件');
    });

    it('成功したチャンクは数えない', () => {
        expect(summarizeChunkFailures([chunk('completed', [{}])]).counts).toEqual({});
    });

    it('理由が何も無ければ「原因不明」として残す（黙って空にしない）', () => {
        expect(summarizeChunkFailures([chunk('failed', [{}])]).text).toBe('原因不明 1件');
    });

    it('失敗が無ければ、その旨を返す（例外にしない）', () => {
        expect(summarizeChunkFailures([]).text).toBe('原因を特定できませんでした');
    });
});
