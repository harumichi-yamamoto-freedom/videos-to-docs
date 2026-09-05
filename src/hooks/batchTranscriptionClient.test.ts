import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    submitBatchTranscription,
    pollBatchStatus,
    runBatchTranscription,
} from './batchTranscriptionClient';
import { TRANSCRIBE_SUBMIT_PATH, TRANSCRIBE_STATUS_PATH } from '@/lib/transcribeBatchContract';

// firebase の遅延 import を無害化（Auth 初期化を避ける・ゲスト扱い）
vi.mock('@/lib/firebase', () => ({ auth: { currentUser: null } }));

const jsonResponse = (body: unknown, ok = true, status = 200) => ({
    ok, status, json: async () => body,
}) as unknown as Response;

const noWait = async () => {};

beforeEach(() => {
    vi.restoreAllMocks();
});

describe('submitBatchTranscription', () => {
    const req = {
        storagePath: 'audio/GUEST/x.mp3', fileName: 'x.mp3', mimeType: 'audio/mpeg',
        audioSec: 600, promptName: 'p', originalFileType: 'audio',
    };

    it('SUBMIT パスへ POST し {jobId,docId} を返す', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ jobId: 'j1', docId: 'd1' }));
        const res = await submitBatchTranscription(req);
        expect(res).toEqual({ jobId: 'j1', docId: 'd1' });
        expect(fetchMock.mock.calls[0][0]).toBe(TRANSCRIBE_SUBMIT_PATH);
    });

    it('!ok はサーバの message を Error にする', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ error: 'rate_limited', message: '上限に達しました' }, false, 429));
        await expect(submitBatchTranscription(req)).rejects.toThrow('上限に達しました');
    });
});

describe('pollBatchStatus', () => {
    it('running を挟んで succeeded になるまで問い合わせる', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ status: 'running', docId: 'd1' }))
            .mockResolvedValueOnce(jsonResponse({ status: 'running', docId: 'd1' }))
            .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', docId: 'd1' }));
        const ticks: string[] = [];
        const res = await pollBatchStatus('j1', { wait: noWait, onTick: (s) => ticks.push(s.status) });
        expect(res.status).toBe('succeeded');
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(ticks).toEqual(['running', 'running', 'succeeded']);
        expect(fetchMock.mock.calls[0][0]).toBe(TRANSCRIBE_STATUS_PATH);
    });

    it('中止シグナルで例外を投げる（それ以上叩かない）', async () => {
        const controller = new AbortController();
        controller.abort(new Error('stopped'));
        const fetchMock = vi.spyOn(globalThis, 'fetch');
        await expect(pollBatchStatus('j1', { signal: controller.signal, wait: noWait })).rejects.toThrow('stopped');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('タイムアウトに達したら running のまま返す（諦めるが失敗にしない）', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 'running', docId: 'd1' }));
        const res = await pollBatchStatus('j1', { wait: noWait, timeoutMs: -1 });
        expect(res.status).toBe('running');
    });

    it('🔴 一時的な状態確認エラー（502）で止まらず、次の周回で確定を拾う', async () => {
        // 1回目 502（サーバの確定 commit が transient で落ちた等）→ 飲み込んで再試行 → 2回目 succeeded。
        // これで止まると、サーバのリース切れ再確定に永遠に到達せず文書が processing で固まる（再レビュー major）。
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ error: 'upstream_error', message: '一時エラー' }, false, 502))
            .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', docId: 'd1' }));
        const res = await pollBatchStatus('j1', { wait: noWait });
        expect(res.status).toBe('succeeded');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('🔴 一時エラーが続いてもタイムアウトまで諦めない', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ error: 'upstream_error', message: '一時エラー' }, false, 502));
        const res = await pollBatchStatus('j1', { wait: noWait, timeoutMs: -1 });
        expect(res.status).toBe('running'); // 諦めるが「失敗」にはしない
    });

    it('中止は一時エラーとして飲み込まず、即座に投げる', async () => {
        const controller = new AbortController();
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            controller.abort(new Error('aborted-mid-flight'));
            throw new Error('The operation was aborted');
        });
        await expect(pollBatchStatus('j1', { signal: controller.signal, wait: noWait }))
            .rejects.toThrow('aborted-mid-flight');
    });
});

describe('runBatchTranscription', () => {
    const input = {
        storagePath: 'audio/GUEST/x.mp3', fileName: 'x.mp3', mimeType: 'audio/mpeg',
        audioSec: 600, promptName: 'p', originalFileType: 'audio', pollIntervalMs: 0,
    };

    it('提出→ポーリング→成功で {success:true, docId}', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ jobId: 'j1', docId: 'd1' }))   // submit
            .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', docId: 'd1' })); // status
        const res = await runBatchTranscription(input);
        expect(res).toEqual({ success: true, docId: 'd1' });
    });

    it('失敗はサーバの理由を返す（文書は消えない前提）', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ jobId: 'j1', docId: 'd1' }))
            .mockResolvedValueOnce(jsonResponse({ status: 'failed', docId: 'd1', error: '音声が長すぎます' }));
        const res = await runBatchTranscription(input);
        expect(res).toEqual({ success: false, docId: 'd1', error: '音声が長すぎます' });
    });
});
