import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    countInflightStatusRequests,
    describeElapsed,
    estimateServerNowMs,
    fetchBatchStatus,
    pollBatchStatus,
    reconcileProcessingDocument,
    resolveProgressObservation,
    resumeBatchTranscription,
    runBatchTranscription,
    stageFromStatusResponse,
    startDocumentStatusWatch,
    submitBatchTranscription,
    TranscribeStatusError,
    type DocumentStatusWatchEnvironment,
    type DocumentStatusWatchSnapshot,
} from './batchTranscriptionClient';
import {
    TRANSCRIBE_SUBMIT_PATH,
    TRANSCRIBE_STATUS_PATH,
    type TranscribeStatusResponse,
} from '@/lib/transcribeBatchContract';

// firebase の遅延 import を無害化（Auth 初期化を避ける・ゲスト扱い）
vi.mock('@/lib/firebase', () => ({ auth: { currentUser: null } }));

const jsonResponse = (body: unknown, ok = true, status = 200, headers?: Record<string, string>) => ({
    ok, status, json: async () => body,
    ...(headers ? { headers: new Headers(headers) } : {}),
}) as unknown as Response;

const noWait = async () => {};

const statusRequestBodies = (fetchMock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): unknown[] =>
    fetchMock.mock.calls
        .filter(([url]) => url === TRANSCRIBE_STATUS_PATH)
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

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

describe('reconcileProcessingDocument', () => {
    it('docId を渡して 1 回だけ確認し、running のまま返す', async () => {
        const status = { status: 'running', docId: 'd1' };
        const controller = new AbortController();
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(status));

        expect(await reconcileProcessingDocument('d1', controller.signal)).toBe(status);
        // 🔴 fetch 自体には呼出元のシグナルを渡さない（同じ文書の他の確認と共有するため）。
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(TRANSCRIBE_STATUS_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ docId: 'd1' }),
        });
    });

    it.each(['succeeded', 'failed'])('サーバで確定済みの %s を追加 fetch なしで返す', async (status) => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ status, docId: 'd1' }));

        expect(await reconcileProcessingDocument('d1')).toEqual({ status, docId: 'd1' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('確認エラーは再試行せず、HTTP ステータス付きの TranscribeStatusError で呼出元へ返す', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ error: 'upstream_error', message: '確認できません' }, false, 502));

        const failure = await reconcileProcessingDocument('d1').catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(TranscribeStatusError);
        expect((failure as TranscribeStatusError).message).toBe('確認できません');
        expect((failure as TranscribeStatusError).httpStatus).toBe(502);
        expect((failure as TranscribeStatusError).code).toBe('upstream_error');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('既に中止されたシグナルでは fetch せずに中止理由で拒否する', async () => {
        const controller = new AbortController();
        controller.abort(new Error('stopped'));
        const fetchMock = vi.spyOn(globalThis, 'fetch');
        await expect(reconcileProcessingDocument('d1', controller.signal)).rejects.toThrow('stopped');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('TranscribeStatusError の Retry-After', () => {
    it('本文の retryAfterSec を ms にして持つ', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ error: 'rate_limited', message: '混雑', retryAfterSec: 20 }, false, 429));
        const failure = await reconcileProcessingDocument('d1').catch((error: unknown) => error) as TranscribeStatusError;
        expect(failure.httpStatus).toBe(429);
        expect(failure.retryAfterMs).toBe(20_000);
    });

    it('本文に無ければ Retry-After ヘッダ（秒）を読む', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ error: 'rate_limited', message: '混雑' }, false, 429, { 'retry-after': '7' }));
        const failure = await reconcileProcessingDocument('d1').catch((error: unknown) => error) as TranscribeStatusError;
        expect(failure.retryAfterMs).toBe(7_000);
    });

    it('どちらも無ければ undefined', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ error: 'rate_limited', message: '混雑' }, false, 429));
        const failure = await reconcileProcessingDocument('d1').catch((error: unknown) => error) as TranscribeStatusError;
        expect(failure.retryAfterMs).toBeUndefined();
    });
});

describe('🔴 状態確認の共有（仕様 §A2 手順3: 同一 docId の実行中リクエストを共有し、二重 poll を作らない）', () => {
    it('同じ docId の同時確認は fetch 1 回を共有する（docId 指定も jobId+docId 指定も同じ鍵）', async () => {
        let resolveFetch!: (response: Response) => void;
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
            () => new Promise<Response>(resolve => { resolveFetch = resolve; }));

        const first = reconcileProcessingDocument('d1');
        const second = reconcileProcessingDocument('d1');
        const byJob = fetchBatchStatus('j1', undefined, 'd1');
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(countInflightStatusRequests()).toBe(1);

        resolveFetch(jsonResponse({ status: 'running', docId: 'd1' }));
        const results = await Promise.all([first, second, byJob]);
        expect(results.map(result => result.status)).toEqual(['running', 'running', 'running']);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(countInflightStatusRequests()).toBe(0);
    });

    it('別の docId は共有しない', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            const body = JSON.parse(String((init as RequestInit).body)) as { docId: string };
            return jsonResponse({ status: 'running', docId: body.docId });
        });
        const [a, b] = await Promise.all([reconcileProcessingDocument('d1'), reconcileProcessingDocument('d2')]);
        expect(a.docId).toBe('d1');
        expect(b.docId).toBe('d2');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('完了した後の次の確認は新しいリクエストになる', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 'running', docId: 'd1' }));
        await reconcileProcessingDocument('d1');
        await reconcileProcessingDocument('d1');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('片方の中止は共有相手を巻き添えにしない（中止側だけが中止理由で拒否される）', async () => {
        let resolveFetch!: (response: Response) => void;
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
            () => new Promise<Response>(resolve => { resolveFetch = resolve; }));
        const controller = new AbortController();

        const aborting = reconcileProcessingDocument('d1', controller.signal);
        const surviving = reconcileProcessingDocument('d1');
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        controller.abort(new Error('画面を離れた'));
        await expect(aborting).rejects.toThrow('画面を離れた');

        resolveFetch(jsonResponse({ status: 'succeeded', docId: 'd1' }));
        expect((await surviving).status).toBe('succeeded');
        expect(fetchMock).toHaveBeenCalledTimes(1);
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

    it('🔴 バックオフ待ちの最中に中止されたら、満了を待たず直ちに中止理由で拒否する', async () => {
        // 実 defaultWait（abort 対応）を使う。502 → バックオフ待ちに入り、その間に abort。
        // タイマー満了（30秒）を待たずに reject すること（呼出側の停止待ち上限 30 秒を超えさせない）。
        vi.useFakeTimers();
        try {
            const controller = new AbortController();
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                jsonResponse({ error: 'upstream_error', message: '一時エラー' }, false, 502));
            // wait は注入せず実 defaultWait を使う
            const pending = pollBatchStatus('j1', { signal: controller.signal });
            const rejected = expect(pending).rejects.toThrow('画面を離れた');
            await vi.advanceTimersByTimeAsync(0); // 1 回目の fetch を解決させ、バックオフ待ちへ
            controller.abort(new Error('画面を離れた'));
            await rejected; // タイマーを進めずに reject される
        } finally {
            vi.useRealTimers();
        }
    });

    it('タイムアウト時は最後に受け取った有効な応答（段階つき）を返す（上限直後の周回が失敗でも）', async () => {
        // 1 周目: 有効な running（段階つき）→ 待ちで時計が上限を超える → 2 周目: 一時エラー → 上限で返す
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ status: 'running', docId: 'd1', stage: 'transcribing' }))
            .mockResolvedValueOnce(jsonResponse({ error: 'upstream_error', message: '一時エラー' }, false, 502));
        let nowOffset = 0;
        const realNow = Date.now;
        vi.spyOn(Date, 'now').mockImplementation(() => realNow() + nowOffset);
        const result = await pollBatchStatus('j1', {
            wait: async () => { nowOffset += 10 * 60_000; },
            timeoutMs: 60_000,
        });
        expect(result).toEqual({ status: 'running', docId: 'd1', stage: 'transcribing' });
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

    it.each([
        { retryAfterSec: 20, expectedWaitMs: 20_000 },
        { retryAfterSec: 0, expectedWaitMs: 0 },
        { retryAfterSec: undefined, expectedWaitMs: 30_000 },
    ])('429 の Retry-After $retryAfterSec 秒を待ち、指定が無ければバックオフする', async ({ retryAfterSec, expectedWaitMs }) => {
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited', message: '混雑', retryAfterSec }, false, 429))
            .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', docId: 'd1' }));
        const wait = vi.fn(noWait);

        expect(await pollBatchStatus('j1', { docId: 'd1', wait })).toEqual({ status: 'succeeded', docId: 'd1' });
        expect(wait).toHaveBeenCalledExactlyOnceWith(expectedWaitMs);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('502・503・回線断の連続失敗は 30→60→60 秒で再試行し、running の成功で失敗数を戻す', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ error: 'upstream_error', message: '一時エラー' }, false, 502))
            .mockResolvedValueOnce(jsonResponse({ error: 'upstream_error', message: '一時エラー' }, false, 503))
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(jsonResponse({ status: 'running', docId: 'd1', stage: 'transcribing' }))
            .mockResolvedValueOnce(jsonResponse({ error: 'upstream_error', message: '一時エラー' }, false, 502))
            .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', docId: 'd1' }));
        const waits: number[] = [];
        const onTick = vi.fn();

        const result = await pollBatchStatus('j1', { docId: 'd1', wait: async ms => { waits.push(ms); }, onTick });

        expect(result.status).toBe('succeeded');
        expect(waits).toEqual([30_000, 60_000, 60_000, 15_000, 30_000]);
        expect(fetchMock).toHaveBeenCalledTimes(6);
        expect(onTick.mock.calls.map(([status]) => status.status)).toEqual(['running', 'succeeded']);
    });

    describe.each([401, 403, 404])('HTTP %s で確認を停止する', (httpStatus) => {
        it('有効な応答が無ければ docId 付きの running を返し、再試行しない', async () => {
            const fetchMock = vi.spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(jsonResponse({ error: 'unavailable', message: '確認できません' }, false, httpStatus))
                .mockResolvedValue(jsonResponse({ status: 'succeeded', docId: 'd1' }));
            const wait = vi.fn(noWait);
            const onTick = vi.fn();

            expect(await pollBatchStatus('j1', { docId: 'd1', wait, onTick })).toEqual({ status: 'running', docId: 'd1' });
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(wait).not.toHaveBeenCalled();
            expect(onTick).not.toHaveBeenCalled();
        });

        it('最後の有効応答と onTick の観測を保持し、エラー後は再試行しない', async () => {
            const lastStatus: TranscribeStatusResponse = { status: 'running', docId: 'd1', stage: 'transcribing' };
            const fetchMock = vi.spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(jsonResponse(lastStatus))
                .mockResolvedValueOnce(jsonResponse({ error: 'unavailable', message: '確認できません' }, false, httpStatus))
                .mockResolvedValue(jsonResponse({ status: 'succeeded', docId: 'd1' }));
            const wait = vi.fn(noWait);
            const onTick = vi.fn();

            expect(await pollBatchStatus('j1', { docId: 'd1', wait, onTick })).toBe(lastStatus);
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(wait).toHaveBeenCalledExactlyOnceWith(15_000);
            expect(onTick).toHaveBeenCalledExactlyOnceWith(lastStatus);
        });
    });

    it('有効な応答が無いままバックオフ中に上限へ達したら、docId 付きの running を返す', async () => {
        let now = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ error: 'upstream_error', message: '一時エラー' }, false, 502));
        const waits: number[] = [];

        const result = await pollBatchStatus('j1', {
            docId: 'd1', timeoutMs: 20_000,
            wait: async ms => { waits.push(ms); now += ms; },
        });

        expect(result).toEqual({ status: 'running', docId: 'd1' });
        expect(waits).toEqual([30_000]);
        expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('バックオフ待機中の中止理由を投げ、次の問い合わせを送らない', async () => {
        const controller = new AbortController();
        const reason = new Error('aborted-during-backoff');
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ error: 'upstream_error', message: '一時エラー' }, false, 502));
        const wait = vi.fn(async () => { controller.abort(reason); });

        await expect(pollBatchStatus('j1', { signal: controller.signal, wait })).rejects.toBe(reason);
        // signal のある本番経路では wait に signal も渡す（defaultWait が abort に即応するため）。
        expect(wait).toHaveBeenCalledExactlyOnceWith(30_000, controller.signal);
        expect(fetchMock).toHaveBeenCalledTimes(1);
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

describe('resumeBatchTranscription（提出済みジョブの確認再開）', () => {
    it('🔴 submit を呼ばず、jobId の確認だけを再開して成功を返す', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ status: 'running', docId: 'd1', stage: 'importing' }))
            .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', docId: 'd1' }));
        const ticks: (string | undefined)[] = [];
        const res = await resumeBatchTranscription({
            jobId: 'j1', docId: 'd1', pollIntervalMs: 1, onTick: (status) => ticks.push(status.stage),
        });
        expect(res).toEqual({ outcome: 'succeeded', success: true, jobId: 'j1', docId: 'd1' });
        expect(fetchMock.mock.calls.every(([url]) => url === TRANSCRIBE_STATUS_PATH)).toBe(true);
        expect(statusRequestBodies(fetchMock)).toEqual([{ jobId: 'j1' }, { jobId: 'j1' }]);
        expect(ticks).toEqual(['importing', undefined]);
    });

    it('失敗はサーバの理由を返す', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ status: 'failed', docId: 'd1', error: '音声が長すぎます' }));
        expect(await resumeBatchTranscription({ jobId: 'j1', docId: 'd1' })).toEqual({
            outcome: 'failed', success: false, jobId: 'j1', docId: 'd1', error: '音声が長すぎます',
        });
    });

    it('403 で確認を止め、最後の観測を outcome:pending に渡す', async () => {
        const lastStatus: TranscribeStatusResponse = { status: 'running', docId: 'd1', stage: 'importing' };
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse(lastStatus))
            .mockResolvedValueOnce(jsonResponse({ error: 'forbidden', message: '確認できません' }, false, 403))
            .mockResolvedValue(jsonResponse({ status: 'succeeded', docId: 'd1' }));
        const onTick = vi.fn();

        expect(await resumeBatchTranscription({ jobId: 'j1', docId: 'd1', pollIntervalMs: 1, onTick })).toEqual({
            outcome: 'pending', success: false, pending: true, jobId: 'j1', docId: 'd1', lastStatus,
        });
        expect(onTick).toHaveBeenCalledExactlyOnceWith(lastStatus);
        expect(statusRequestBodies(fetchMock)).toEqual([{ jobId: 'j1' }, { jobId: 'j1' }]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('runBatchTranscription', () => {
    const input = {
        storagePath: 'audio/GUEST/x.mp3', fileName: 'x.mp3', mimeType: 'audio/mpeg',
        audioSec: 600, promptName: 'p', originalFileType: 'audio', pollIntervalMs: 0,
    };

    it('提出→ポーリング→成功で {outcome:succeeded, jobId, docId}', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ jobId: 'j1', docId: 'd1' }))   // submit
            .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', docId: 'd1' })); // status
        const res = await runBatchTranscription(input);
        expect(res).toEqual({ outcome: 'succeeded', success: true, jobId: 'j1', docId: 'd1' });
    });

    it('失敗はサーバの理由を返す（文書は消えない前提）', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ jobId: 'j1', docId: 'd1' }))
            .mockResolvedValueOnce(jsonResponse({ status: 'failed', docId: 'd1', error: '音声が長すぎます' }));
        const res = await runBatchTranscription(input);
        expect(res).toEqual({ outcome: 'failed', success: false, jobId: 'j1', docId: 'd1', error: '音声が長すぎます' });
    });

    it('提出直後に onSubmitted へ {jobId, docId} を渡す（確認再開用に呼出元が保持する）', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ jobId: 'j1', docId: 'd1' }))
            .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', docId: 'd1' }));
        const onSubmitted = vi.fn();
        await runBatchTranscription({ ...input, onSubmitted });
        expect(onSubmitted).toHaveBeenCalledExactlyOnceWith({ jobId: 'j1', docId: 'd1' });
    });

    it('提出直後の 404 で outcome:pending を返し、再提出も再確認もしない', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ jobId: 'j1', docId: 'd1' }))
            .mockResolvedValueOnce(jsonResponse({ error: 'media_not_found', message: '確認できません' }, false, 404))
            .mockResolvedValue(jsonResponse({ status: 'succeeded', docId: 'd1' }));
        const onSubmitted = vi.fn();

        expect(await runBatchTranscription({ ...input, onSubmitted })).toEqual({
            outcome: 'pending', success: false, pending: true, jobId: 'j1', docId: 'd1', lastStatus: null,
        });
        expect(onSubmitted).toHaveBeenCalledExactlyOnceWith({ jobId: 'j1', docId: 'd1' });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([TRANSCRIBE_SUBMIT_PATH, TRANSCRIBE_STATUS_PATH]);
    });

    it('🔴 確認上限の pending は失敗ではなく outcome:pending（最後の有効応答つき）で返す', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ jobId: 'j1', docId: 'd1' }))
            .mockResolvedValue(jsonResponse({ status: 'running', docId: 'd1', stage: 'queued' }));
        let nowOffset = 0;
        const realNow = Date.now;
        vi.spyOn(Date, 'now').mockImplementation(() => realNow() + nowOffset);
        // 1 周目の応答後に時計を進めて上限を超えさせる
        const onTick = vi.fn(() => { nowOffset += STATUS_POLL_TIMEOUT_MS_FOR_TEST; });
        const res = await runBatchTranscription({ ...input, onTick });
        expect(res).toEqual({
            outcome: 'pending', success: false, pending: true, jobId: 'j1', docId: 'd1',
            lastStatus: { status: 'running', docId: 'd1', stage: 'queued' },
        });
    });
});

const STATUS_POLL_TIMEOUT_MS_FOR_TEST = 91 * 60_000;

describe('表示段階のヘルパ（仕様 §A1・A3）', () => {
    it('stageFromStatusResponse: 応答の stage を使い、無ければ終端だけ公開 3 値から導く', () => {
        expect(stageFromStatusResponse({ status: 'running', docId: 'd', stage: 'queued' })).toBe('queued');
        expect(stageFromStatusResponse({ status: 'succeeded', docId: 'd' })).toBe('completed');
        expect(stageFromStatusResponse({ status: 'failed', docId: 'd' })).toBe('failed');
        // 旧サーバ: running で stage 無し → 不明（勝手に段階を作らない）
        expect(stageFromStatusResponse({ status: 'running', docId: 'd' })).toBeUndefined();
    });

    it('resolveProgressObservation: 終端を最優先し、非終端では観測時刻が新しい方を採用する', () => {
        const projection = { stage: 'importing' as const, stageObservedAtMs: 2_000, jobCreatedAtMs: 100 };
        const older: TranscribeStatusResponse = { status: 'running', docId: 'd', stage: 'transcribing', azureStatusCheckedAtMs: 1_000 };
        const newer: TranscribeStatusResponse = { status: 'running', docId: 'd', stage: 'transcribing', azureStatusCheckedAtMs: 3_000 };
        const terminal: TranscribeStatusResponse = { status: 'succeeded', docId: 'd' };

        expect(resolveProgressObservation(projection, older)).toMatchObject({ stage: 'importing', source: 'projection' });
        expect(resolveProgressObservation(projection, newer)).toMatchObject({ stage: 'transcribing', source: 'status' });
        expect(resolveProgressObservation(projection, terminal)).toMatchObject({ stage: 'completed', source: 'status' });
        expect(resolveProgressObservation(projection, null)).toMatchObject({ stage: 'importing', jobCreatedAtMs: 100 });
        expect(resolveProgressObservation(undefined, null)).toBeNull();
        // 観測時刻が無い側があれば、生きている応答を優先する
        expect(resolveProgressObservation({ stage: 'queued' }, older)).toMatchObject({ stage: 'transcribing' });
    });

    it('describeElapsed: 分単位で丸め、秒やパーセントを出さない', () => {
        expect(describeElapsed(0)).toBe('1分未満');
        expect(describeElapsed(59_000)).toBe('1分未満');
        expect(describeElapsed(5 * 60_000 + 30_000)).toBe('5分');
        expect(describeElapsed(65 * 60_000)).toBe('1時間5分');
        expect(describeElapsed(120 * 60_000)).toBe('2時間');
        expect(describeElapsed(Number.NaN)).toBe('1分未満');
    });

    it('estimateServerNowMs: serverNowMs にローカル経過を足し、無ければローカル時刻', () => {
        const response: TranscribeStatusResponse = { status: 'running', docId: 'd', serverNowMs: 10_000 };
        expect(estimateServerNowMs(response, 500_000, 530_000)).toBe(40_000);
        expect(estimateServerNowMs({ status: 'running', docId: 'd' }, 500_000, 530_000)).toBe(530_000);
        expect(estimateServerNowMs(null, null, 530_000)).toBe(530_000);
    });
});

describe('startDocumentStatusWatch（選択中文書の継続確認・仕様 §A2 手順3〜5）', () => {
    interface FakeTimer { id: number; callback: () => void; ms: number }

    const createEnvironment = (initial: { visible?: boolean; online?: boolean } = {}) => {
        const timers: FakeTimer[] = [];
        const listeners = new Set<() => void>();
        let nextId = 1;
        const state = { visible: initial.visible ?? true, online: initial.online ?? true, now: 1_000_000 };
        const environment: DocumentStatusWatchEnvironment = {
            isVisible: () => state.visible,
            isOnline: () => state.online,
            subscribe: (onChange) => {
                listeners.add(onChange);
                return () => listeners.delete(onChange);
            },
            now: () => state.now,
            setTimer: (callback, ms) => {
                const id = nextId++;
                timers.push({ id, callback, ms });
                return id;
            },
            clearTimer: (handle) => {
                const index = timers.findIndex(timer => timer.id === handle);
                if (index >= 0) timers.splice(index, 1);
            },
        };
        return {
            environment,
            state,
            timers,
            listenerCount: () => listeners.size,
            /** 次のタイマーを 1 本だけ発火させる */
            fireNext: () => {
                const timer = timers.shift();
                if (!timer) throw new Error('発火できるタイマーがありません');
                timer.callback();
            },
            notify: () => listeners.forEach(listener => listener()),
        };
    };

    const running = (stage: TranscribeStatusResponse['stage'] = 'transcribing'): TranscribeStatusResponse =>
        ({ status: 'running', docId: 'd1', stage, azureStatusCheckedAtMs: 999_000, serverNowMs: 1_000_100 });

    const waitForMode = (watch: { getSnapshot: () => DocumentStatusWatchSnapshot }, mode: DocumentStatusWatchSnapshot['mode']) =>
        vi.waitFor(() => expect(watch.getSnapshot().mode).toBe(mode));

    it('開始時に即時 1 回確認し、完了後に基本間隔のタイマーを 1 本だけ積む（積み重ねない）', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(running()));
        const env = createEnvironment();
        const onChange = vi.fn();
        const watch = startDocumentStatusWatch('d1', { environment: env.environment, onChange });

        expect(watch.getSnapshot().mode).toBe('checking');
        await waitForMode(watch, 'waiting');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(statusRequestBodies(fetchMock)).toEqual([{ docId: 'd1' }]);
        expect(env.timers.map(timer => timer.ms)).toEqual([15_000]);
        expect(watch.getSnapshot()).toMatchObject({
            lastResponse: running(), lastResponseAtMs: 1_000_000, lastError: null, consecutiveFailures: 0,
        });

        env.fireNext();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        await waitForMode(watch, 'waiting');
        expect(env.timers).toHaveLength(1);
        expect(onChange).toHaveBeenLastCalledWith(watch.getSnapshot());
        watch.stop();
    });

    it('手動確認（checkNow）は実行中のリクエストを共有し、重複送信しない', async () => {
        let resolveFetch!: (response: Response) => void;
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
            () => new Promise<Response>(resolve => { resolveFetch = resolve; }));
        const env = createEnvironment();
        const watch = startDocumentStatusWatch('d1', { environment: env.environment });

        const first = watch.checkNow();
        const second = watch.checkNow();
        expect(second).toBe(first);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        resolveFetch(jsonResponse(running()));
        expect((await first)?.status).toBe('running');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        watch.stop();
    });

    it('🔴 HTTP 一時失敗は 30→60 秒へ延ばし、成功で 15 秒へ戻す。失敗では lastResponse を進めない', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ error: 'upstream_error', message: '一時エラー' }, false, 502))
            .mockResolvedValueOnce(jsonResponse({ error: 'upstream_error', message: '一時エラー' }, false, 502))
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(jsonResponse(running()));
        const env = createEnvironment();
        const watch = startDocumentStatusWatch('d1', { environment: env.environment });

        await waitForMode(watch, 'waiting');
        expect(env.timers.map(timer => timer.ms)).toEqual([30_000]);
        expect(watch.getSnapshot()).toMatchObject({
            lastResponse: null, lastError: { message: '一時エラー', httpStatus: 502 }, consecutiveFailures: 1,
        });

        env.fireNext();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(env.timers.map(timer => timer.ms)).toEqual([60_000]));

        env.fireNext();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
        await vi.waitFor(() => expect(env.timers.map(timer => timer.ms)).toEqual([60_000]));
        expect(watch.getSnapshot()).toMatchObject({
            lastError: { message: '通信に失敗しました。' }, consecutiveFailures: 3,
        });

        env.fireNext();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
        await vi.waitFor(() => expect(env.timers.map(timer => timer.ms)).toEqual([15_000]));
        expect(watch.getSnapshot()).toMatchObject({ lastError: null, consecutiveFailures: 0, lastResponse: running() });
        watch.stop();
    });

    it('429 は Retry-After を尊重する', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ error: 'rate_limited', message: '混雑', retryAfterSec: 20 }, false, 429));
        const env = createEnvironment();
        const watch = startDocumentStatusWatch('d1', { environment: env.environment });
        await waitForMode(watch, 'waiting');
        expect(env.timers.map(timer => timer.ms)).toEqual([20_000]);
        watch.stop();
    });

    it.each(['manual', 'visible', 'online', 'timer'] as const)(
        '429 の待機中は %s から確認しても再送せず、期限後に送信する', async (entrance) => {
            const fetchMock = vi.spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited', message: '混雑', retryAfterSec: 20 }, false, 429))
                .mockResolvedValue(jsonResponse(running()));
            const env = createEnvironment();
            const watch = startDocumentStatusWatch('d1', { environment: env.environment });
            await waitForMode(watch, 'waiting');
            expect(watch.getSnapshot().notBeforeMs).toBe(1_020_000);
            expect(env.timers.map(timer => timer.ms)).toEqual([20_000]);

            env.state.now += 5_000;
            if (entrance === 'manual') {
                await watch.checkNow();
                await watch.checkNow();
            } else if (entrance === 'timer') {
                // タイマーの早期発火も同じ待機期限で防ぐ。
                env.fireNext();
            } else {
                env.state[entrance] = false;
                env.notify();
                expect(watch.getSnapshot().mode).toBe(entrance === 'visible' ? 'paused_hidden' : 'paused_offline');
                expect(env.timers).toHaveLength(0);
                env.state[entrance] = true;
                env.notify();
            }

            await waitForMode(watch, 'waiting');
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(env.timers.map(timer => timer.ms)).toEqual([15_000]);
            expect(watch.getSnapshot()).toMatchObject({ notBeforeMs: 1_020_000, consecutiveFailures: 1 });

            env.state.now += 15_000;
            env.fireNext();
            expect(watch.getSnapshot().notBeforeMs).toBeUndefined();
            await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
            await waitForMode(watch, 'waiting');
            expect(watch.getSnapshot()).toMatchObject({ lastError: null, consecutiveFailures: 0 });
            expect(env.timers.map(timer => timer.ms)).toEqual([15_000]);
            watch.stop();
        },
    );

    it.each([401, 403])('%s は自動確認を止め（stopped_auth）、タイマーを積まない', async (httpStatus) => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ error: 'forbidden', message: '権限がありません' }, false, httpStatus));
        const env = createEnvironment();
        const watch = startDocumentStatusWatch('d1', { environment: env.environment });
        await waitForMode(watch, 'stopped_auth');
        expect(env.timers).toHaveLength(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        watch.stop();
    });

    it('🔴 404 は「確認できません」として自動確認を止め、再提出しない。手動確認で再開できる', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ error: 'media_not_found', message: '文書が見つかりません。' }, false, 404))
            .mockResolvedValueOnce(jsonResponse(running()));
        const env = createEnvironment();
        const watch = startDocumentStatusWatch('d1', { environment: env.environment });
        await waitForMode(watch, 'stopped_not_found');
        expect(env.timers).toHaveLength(0);
        expect(fetchMock.mock.calls.every(([url]) => url === TRANSCRIBE_STATUS_PATH)).toBe(true);

        await watch.checkNow();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls.every(([url]) => url === TRANSCRIBE_STATUS_PATH)).toBe(true);
        await waitForMode(watch, 'waiting');
        expect(env.timers.map(timer => timer.ms)).toEqual([15_000]);
        watch.stop();
    });

    it('終端応答で onTerminal を 1 回呼び、以後はタイマーも fetch も無い', async () => {
        const terminal: TranscribeStatusResponse = { status: 'succeeded', docId: 'd1', stage: 'completed' };
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(terminal));
        const env = createEnvironment();
        const onTerminal = vi.fn();
        const watch = startDocumentStatusWatch('d1', { environment: env.environment, onTerminal });
        await waitForMode(watch, 'terminal');
        expect(onTerminal).toHaveBeenCalledExactlyOnceWith(terminal);
        expect(env.timers).toHaveLength(0);

        expect(await watch.checkNow()).toEqual(terminal);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        watch.stop();
    });

    it('🔴 非表示なら確認せず、表示に戻ったら即時 1 回確認する。待機中に非表示になればタイマーを外す', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(running()));
        const env = createEnvironment({ visible: false });
        const watch = startDocumentStatusWatch('d1', { environment: env.environment });
        expect(watch.getSnapshot().mode).toBe('paused_hidden');
        expect(fetchMock).not.toHaveBeenCalled();

        env.state.visible = true;
        env.notify();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await waitForMode(watch, 'waiting');
        expect(env.timers).toHaveLength(1);

        env.state.visible = false;
        env.notify();
        expect(watch.getSnapshot().mode).toBe('paused_hidden');
        expect(env.timers).toHaveLength(0);

        env.state.visible = true;
        env.notify();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        watch.stop();
    });

    it('オフラインなら確認を止め、回線復帰で即時 1 回確認する', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(running()));
        const env = createEnvironment({ online: false });
        const watch = startDocumentStatusWatch('d1', { environment: env.environment });
        expect(watch.getSnapshot().mode).toBe('paused_offline');
        expect(fetchMock).not.toHaveBeenCalled();

        env.state.online = true;
        env.notify();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await waitForMode(watch, 'waiting');
        watch.stop();
    });

    it('🔴 確認上限に達したら自動確認を止め（stopped_limit）、手動確認で時計を仕切り直して再開する', async () => {
        let resolveFetch!: (response: Response) => void;
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
            () => new Promise<Response>(resolve => { resolveFetch = resolve; }));
        const env = createEnvironment();
        const watch = startDocumentStatusWatch('d1', { environment: env.environment, maxDurationMs: 1_000 });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        env.state.now += 5_000;
        resolveFetch(jsonResponse(running()));
        await waitForMode(watch, 'stopped_limit');
        expect(env.timers).toHaveLength(0);
        // 上限で止まっても最後の有効観測は残る（「最終確認時は文字起こし中」に使う）
        expect(watch.getSnapshot().lastResponse).toEqual(running());

        const manual = watch.checkNow();
        expect(watch.getSnapshot().startedAtMs).toBe(env.state.now);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        resolveFetch(jsonResponse(running()));
        await manual;
        await waitForMode(watch, 'waiting');
        expect(env.timers.map(timer => timer.ms)).toEqual([15_000]);
        watch.stop();
    });

    it.each([
        new TranscribeStatusError('一時エラー', { httpStatus: 502 }),
        new TypeError('Failed to fetch'),
    ])('失敗が続き上限を超えて戻った $name は stopped_limit にしてタイマーを残さない', async (failure) => {
        let rejectFetch!: (reason: unknown) => void;
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockRejectedValueOnce(failure)
            .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectFetch = reject; }));
        const env = createEnvironment();
        const watch = startDocumentStatusWatch('d1', { environment: env.environment, maxDurationMs: 40_000 });
        await waitForMode(watch, 'waiting');
        expect(env.timers.map(timer => timer.ms)).toEqual([30_000]);

        env.state.now += 30_000;
        env.fireNext();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        env.state.now += 10_001;
        rejectFetch(failure);

        await waitForMode(watch, 'stopped_limit');
        expect(watch.getSnapshot()).toMatchObject({ lastResponse: null, consecutiveFailures: 2 });
        expect(env.timers).toHaveLength(0);
        watch.stop();
    });

    it('失敗後のタイマーが上限を超えて発火しても再送せず stopped_limit にする', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ error: 'upstream_error', message: '一時エラー' }, false, 502));
        const env = createEnvironment();
        const watch = startDocumentStatusWatch('d1', { environment: env.environment, maxDurationMs: 40_000 });
        await waitForMode(watch, 'waiting');
        expect(env.timers.map(timer => timer.ms)).toEqual([30_000]);

        env.state.now += 40_001;
        env.fireNext();

        await waitForMode(watch, 'stopped_limit');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(env.timers).toHaveLength(0);
        watch.stop();
    });

    it('上限超過後の 429 は待機期限を保持し、手動再開で起点を戻しても Retry-After を守る', async () => {
        let resolveFetch!: (response: Response) => void;
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFetch = resolve; }))
            .mockResolvedValue(jsonResponse(running()));
        const env = createEnvironment();
        const watch = startDocumentStatusWatch('d1', { environment: env.environment, maxDurationMs: 30_000 });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        env.state.now += 40_000;
        resolveFetch(jsonResponse({ error: 'rate_limited', message: '混雑', retryAfterSec: 20 }, false, 429));
        await waitForMode(watch, 'stopped_limit');
        expect(watch.getSnapshot()).toMatchObject({ startedAtMs: 1_000_000, notBeforeMs: 1_060_000 });
        expect(env.timers).toHaveLength(0);

        env.state.now += 5_000;
        await watch.checkNow();
        expect(watch.getSnapshot()).toMatchObject({
            mode: 'waiting', startedAtMs: 1_045_000, notBeforeMs: 1_060_000,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(env.timers.map(timer => timer.ms)).toEqual([15_000]);

        env.state.now += 15_000;
        env.fireNext();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        await waitForMode(watch, 'waiting');
        expect(watch.getSnapshot().notBeforeMs).toBeUndefined();
        expect(watch.getSnapshot().startedAtMs).toBe(1_045_000);
        expect(env.timers.map(timer => timer.ms)).toEqual([15_000]);
        watch.stop();
    });

    it('stop() はタイマーと購読を解き、遅れて届いた応答で onChange/onTerminal を呼ばない', async () => {
        let resolveFetch!: (response: Response) => void;
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
            () => new Promise<Response>(resolve => { resolveFetch = resolve; }));
        const env = createEnvironment();
        const onChange = vi.fn();
        const onTerminal = vi.fn();
        const watch = startDocumentStatusWatch('d1', { environment: env.environment, onChange, onTerminal });
        expect(env.listenerCount()).toBe(1);
        // 認証ヘッダの準備（遅延 import）を挟むので、fetch が実際に飛ぶまで待ってから止める
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        watch.stop();
        expect(watch.getSnapshot().mode).toBe('disposed');
        expect(env.listenerCount()).toBe(0);
        const changesAtStop = onChange.mock.calls.length;

        resolveFetch(jsonResponse({ status: 'succeeded', docId: 'd1' }));
        await vi.waitFor(() => expect(countInflightStatusRequests()).toBe(0));
        expect(onChange).toHaveBeenCalledTimes(changesAtStop);
        expect(onTerminal).not.toHaveBeenCalled();
        expect(env.timers).toHaveLength(0);
        expect(await watch.checkNow()).toBeNull();
    });
});
