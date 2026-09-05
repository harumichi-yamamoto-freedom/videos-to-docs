/**
 * 契約テスト（L5-問3(a)）: submit / status の**実ルート**を、外界の I/O だけ差し替えて通す。
 *
 * 🔴 本番で3回出た「tsc もテストも緑なのに壊れる」型は、いずれも継ぎ目がモックされ、
 *    ルートの orchestration（何を呼ぶか）を一度も実行していなかったのが原因（L5-問2）。
 *    ここでは parseStoragePath / isOwnedBySubject / parseBatchResult / buildTranscriptMarkdownFromBatch を
 *    **実物のまま**通し、「submit が実際に submitBatchJob と文書作成とジョブ作成を呼ぶ」
 *    「status が Succeeded で確定処理を最後まで配線している」ことを錠にする。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AzureBatchResult } from '@/lib/azureBatchContract';

const documentDb = vi.hoisted(() => ({
    data: undefined as Record<string, unknown> | undefined,
    ref: { id: 'doc-1' },
    tx: { get: vi.fn(), set: vi.fn() },
    runTransaction: vi.fn(),
    warn: vi.fn(),
}));

// --- 外界の I/O だけモック（純関数は実物のまま） ---
vi.mock('@/server/firebaseAdmin', () => ({
    getAdminFirestore: () => ({
        collection: () => ({ doc: () => documentDb.ref }),
        runTransaction: documentDb.runTransaction,
    }),
}));
vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: documentDb.warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/server/auth', () => ({
    GUEST_OWNER_ID: 'GUEST',
    resolveRequestSubject: vi.fn(),
}));
vi.mock('@/server/rateLimit', () => ({
    enforceRateLimit: vi.fn(async () => ({ allowed: true, count: 1, limit: 50 })),
    clientIpFromHeaders: vi.fn(() => '203.0.113.1'),
}));
vi.mock('@/server/mediaSource', async (importActual) => ({
    ...(await importActual<typeof import('@/server/mediaSource')>()),
    statMedia: vi.fn(async () => ({ storagePath: 'audio/GUEST/x.mp3', sizeBytes: 8_000_000 })),
    getSignedReadUrl: vi.fn(async () => 'https://signed.example/x.mp3?sig=abc'),
}));
vi.mock('@/server/azureBatchTranscribe', async (importActual) => ({
    ...(await importActual<typeof import('@/server/azureBatchTranscribe')>()),
    getAzureCredentials: vi.fn(() => ({ endpoint: 'https://ep', apiKey: 'k' })),
    submitBatchJob: vi.fn(async () => ({ selfUrl: 'https://ep/speechtotext/transcriptions/JID?api-version=2024-11-15' })),
    getBatchJob: vi.fn(),
    fetchBatchResult: vi.fn(),
    deleteBatchJob: vi.fn(async () => undefined),
}));
vi.mock('@/server/transcriptionDocument', async (importActual) => {
    const actual = await importActual<typeof import('@/server/transcriptionDocument')>();
    return {
        ...actual,
        createProcessingDocument: vi.fn(async () => 'doc-1'),
        completeTranscriptionDocument: vi.fn(actual.completeTranscriptionDocument),
        failTranscriptionDocument: vi.fn(actual.failTranscriptionDocument),
    };
});
vi.mock('@/server/transcriptionJob', () => ({
    FINALIZE_LEASE_MS: 3 * 60 * 1000,
    claimJobForFinalize: vi.fn(),
    createTranscriptionJob: vi.fn(async () => 'job-1'),
    getTranscriptionJob: vi.fn(),
    updateTranscriptionJob: vi.fn(async () => undefined),
}));

import { POST as submitPOST } from './submit/route';
import { POST as statusPOST } from './status/route';
import { resolveRequestSubject } from '@/server/auth';
import { submitBatchJob, getAzureCredentials, getBatchJob, fetchBatchResult, deleteBatchJob } from '@/server/azureBatchTranscribe';
import { getSignedReadUrl } from '@/server/mediaSource';
import { createProcessingDocument, completeTranscriptionDocument, failTranscriptionDocument } from '@/server/transcriptionDocument';
import { claimJobForFinalize, FINALIZE_LEASE_MS, createTranscriptionJob, getTranscriptionJob, updateTranscriptionJob } from '@/server/transcriptionJob';
import * as finalization from '@/server/finalizeTranscription';

const guest = { kind: 'guest' as const };
const req = (body: unknown) => new Request('http://t/api', { method: 'POST', body: JSON.stringify(body) });

const sampleAzureResult = (): AzureBatchResult => ({
    durationMilliseconds: 60_000,
    combinedRecognizedPhrases: [{ display: 'こんにちは。よろしくお願いします。' }],
    recognizedPhrases: [
        { offsetMilliseconds: 0, durationMilliseconds: 2000, speaker: 1, nBest: [{ display: 'こんにちは。' }] },
        { offsetMilliseconds: 3000, durationMilliseconds: 2000, speaker: 2, nBest: [{ display: 'よろしくお願いします。' }] },
    ],
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveRequestSubject).mockResolvedValue(guest);
    documentDb.data = { ownerId: 'GUEST', status: 'processing', title: '合成の文書', transcription: '処理中' };
    documentDb.tx.get.mockImplementation(async () => ({
        exists: documentDb.data !== undefined,
        data: () => documentDb.data,
    }));
    documentDb.tx.set.mockImplementation((_ref, patch) => {
        documentDb.data = { ...documentDb.data, ...patch };
    });
    documentDb.runTransaction.mockImplementation(async (fn) => fn(documentDb.tx));
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('POST /api/transcribe/submit（実ルートの配線）', () => {
    const validBody = {
        storagePath: 'audio/GUEST/x.mp3',
        fileName: 'x.mp3',
        mimeType: 'audio/mpeg',
        audioSec: 600,
        promptName: '全文文字起こし',
        originalFileType: 'audio',
    };

    it('🔴 submitBatchJob・文書作成・ジョブ作成を実際に呼び、{jobId,docId} を返す', async () => {
        const res = await submitPOST(req(validBody));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ jobId: 'job-1', docId: 'doc-1' });
        // #50 型（配線漏れ）の再発防止: 「呼ばれた」で錠にする
        expect(submitBatchJob).toHaveBeenCalledTimes(1);
        expect(createProcessingDocument).toHaveBeenCalledTimes(1);
        expect(createTranscriptionJob).toHaveBeenCalledTimes(1);
        // ジョブは Azure の self URL と文書 ID を結びつけて持つ
        expect(vi.mocked(createTranscriptionJob).mock.calls[0][0]).toMatchObject({
            docId: 'doc-1',
            azureSelfUrl: expect.stringContaining('/transcriptions/JID'),
            ownerType: 'guest',
        });
    });

    it('所有者でないパスは 403（Azure を呼ばない）', async () => {
        const res = await submitPOST(req({ ...validBody, storagePath: 'audio/someuser/x.mp3' }));
        expect(res.status).toBe(403);
        expect(submitBatchJob).not.toHaveBeenCalled();
    });

    it('Azure の待機・再試行中も音源を取得できるよう署名 URL は24時間有効にする', async () => {
        await submitPOST(req(validBody));
        expect(getSignedReadUrl).toHaveBeenCalledWith(validBody.storagePath, 24 * 60 * 60 * 1000);
    });

    it('音声長が 240 分超は 400（提出しない）', async () => {
        const res = await submitPOST(req({ ...validBody, audioSec: 241 * 60 }));
        expect(res.status).toBe(400);
        expect(submitBatchJob).not.toHaveBeenCalled();
    });

    it('audioSec 欠落は 400', async () => {
        const { audioSec, ...noSec } = validBody; void audioSec;
        const res = await submitPOST(req(noSec));
        expect(res.status).toBe(400);
    });
});

describe('POST /api/transcribe/status（確定処理の配線）', () => {
    const runningJob = {
        id: 'job-1', ownerId: 'GUEST', ownerType: 'guest' as const, docId: 'doc-1',
        azureSelfUrl: 'https://ep/speechtotext/transcriptions/JID?api-version=2024-11-15',
        status: 'running' as const, audioSec: 600, storagePath: 'audio/GUEST/x.mp3',
        promptName: 'p', createdAtMs: 0, updatedAtMs: 0,
    };

    beforeEach(() => {
        vi.mocked(getTranscriptionJob).mockResolvedValue(runningJob);
        vi.mocked(claimJobForFinalize).mockResolvedValue({ ...runningJob, status: 'finalizing', updatedAtMs: Date.now() });
    });

    it('Azure が Running のうちは文書を確定しない', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue(runningJob);
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Running' });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({ status: 'running', docId: 'doc-1' });
        expect(completeTranscriptionDocument).not.toHaveBeenCalled();
        expect(claimJobForFinalize).toHaveBeenCalledWith('job-1');
        expect(updateTranscriptionJob).toHaveBeenCalledWith('job-1', { status: 'running' });
    });

    it('🔴 Succeeded で結果取得→Markdown化→文書完成→ジョブ更新→Azure削除まで貫通する', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue(runningJob);
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
        vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({ status: 'succeeded', docId: 'doc-1' });
        expect(completeTranscriptionDocument).toHaveBeenCalledTimes(1);
        // 実の buildTranscriptMarkdownFromBatch を通した本文が入る（話者ラベル＋時刻）
        const [docId, markdown, model, expectedOwnerId] = vi.mocked(completeTranscriptionDocument).mock.calls[0];
        expect(docId).toBe('doc-1');
        expect(markdown).toContain('よろしくお願いします');
        expect(model).toContain('Azure');
        expect(expectedOwnerId).toBe('GUEST');
        expect(documentDb.data).toMatchObject({ status: 'completed', transcription: markdown, title: '合成の文書' });
        expect(updateTranscriptionJob).toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'succeeded' }));
        expect(deleteBatchJob).toHaveBeenCalledTimes(1);
    });

    it('🔴 Failed でも文書は消さず、理由を残して failed を返す（L2-D1 是正）', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue(runningJob);
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Failed', error: 'AudioLengthLimitExceeded' });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        const body = await res.json();
        expect(body.status).toBe('failed');
        expect(body.error).toContain('AudioLength');
        expect(failTranscriptionDocument).toHaveBeenCalledTimes(1);
        expect(failTranscriptionDocument).toHaveBeenCalledWith('doc-1', 'AudioLengthLimitExceeded', 'GUEST');
        expect(documentDb.data).toMatchObject({ status: 'failed', title: '合成の文書' });
        expect(documentDb.data?.transcription).toContain('AudioLengthLimitExceeded');
        expect(completeTranscriptionDocument).not.toHaveBeenCalled();
        expect(updateTranscriptionJob).toHaveBeenCalledWith('job-1', { status: 'failed', error: 'AudioLengthLimitExceeded' });
    });

    it('🔴 既に succeeded のジョブは Azure を叩かず即返す（冪等・二重確定しない）', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue({ ...runningJob, status: 'succeeded' });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({ status: 'succeeded', docId: 'doc-1' });
        expect(getBatchJob).not.toHaveBeenCalled();
        expect(completeTranscriptionDocument).not.toHaveBeenCalled();
        expect(claimJobForFinalize).not.toHaveBeenCalled();
    });

    it('既に failed のジョブは理由を返し、再確定も文書削除もしない', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue({ ...runningJob, status: 'failed', error: '合成の失敗理由' });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({ status: 'failed', docId: 'doc-1', error: '合成の失敗理由' });
        expect(claimJobForFinalize).not.toHaveBeenCalled();
        expect(getBatchJob).not.toHaveBeenCalled();
        expect(documentDb.tx.set).not.toHaveBeenCalled();
    });

    it('有効な finalizing リースは公開 running として返す', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue({ ...runningJob, status: 'finalizing', updatedAtMs: Date.now() });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({ status: 'running', docId: 'doc-1' });
        expect(claimJobForFinalize).not.toHaveBeenCalled();
        expect(getBatchJob).not.toHaveBeenCalled();
    });

    it('クラッシュで期限切れの finalizing リースを取り直して確定する', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue({
            ...runningJob, status: 'finalizing', updatedAtMs: Date.now() - FINALIZE_LEASE_MS - 1,
        });
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
        vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({ status: 'succeeded', docId: 'doc-1' });
        expect(claimJobForFinalize).toHaveBeenCalledWith('job-1');
        expect(completeTranscriptionDocument).toHaveBeenCalledTimes(1);
    });

    it.each(['running', 'finalizing', 'succeeded', 'failed'] as const)(
        '確定権を取れなければ最新の %s を読み直して返す', async (status) => {
            vi.mocked(claimJobForFinalize).mockResolvedValue(null);
            const error = status === 'failed' ? { error: '合成の失敗理由' } : {};
            vi.mocked(getTranscriptionJob)
                .mockResolvedValueOnce(runningJob)
                .mockResolvedValueOnce({ ...runningJob, status, ...error });
            const res = await statusPOST(req({ jobId: 'job-1' }));
            expect(await res.json()).toEqual({ status: status === 'finalizing' ? 'running' : status, docId: 'doc-1', ...error });
            expect(getTranscriptionJob).toHaveBeenCalledTimes(2);
            expect(getBatchJob).not.toHaveBeenCalled();
            expect(documentDb.tx.set).not.toHaveBeenCalled();
        },
    );

    it('並行 poll でも確定権を得た1リクエストだけが結果を保存・削除する', async () => {
        let signalStarted!: () => void;
        const started = new Promise<void>((resolve) => { signalStarted = resolve; });
        let releaseAzure!: () => void;
        vi.mocked(getBatchJob).mockImplementationOnce(() => {
            signalStarted();
            return new Promise((resolve) => { releaseAzure = () => resolve({ status: 'Succeeded' }); });
        });
        vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
        vi.mocked(claimJobForFinalize)
            .mockResolvedValueOnce({ ...runningJob, status: 'finalizing', updatedAtMs: Date.now() })
            .mockResolvedValueOnce(null);
        const first = statusPOST(req({ jobId: 'job-1' }));
        await started;
        const second = await statusPOST(req({ jobId: 'job-1' }));
        expect(await second.json()).toEqual({ status: 'running', docId: 'doc-1' });
        releaseAzure();
        expect(await (await first).json()).toEqual({ status: 'succeeded', docId: 'doc-1' });
        expect(getBatchJob).toHaveBeenCalledTimes(1);
        expect(fetchBatchResult).toHaveBeenCalledTimes(1);
        expect(completeTranscriptionDocument).toHaveBeenCalledTimes(1);
        expect(deleteBatchJob).toHaveBeenCalledTimes(1);
    });

    it('Azure 設定がなくなっても running に戻して再試行できる', async () => {
        vi.mocked(getAzureCredentials).mockReturnValueOnce(null);
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({ status: 'running', docId: 'doc-1' });
        expect(updateTranscriptionJob).toHaveBeenCalledWith('job-1', { status: 'running' });
        expect(getBatchJob).not.toHaveBeenCalled();
    });

    it('Azure 状態照会の通信失敗は確定権を解放してからエラーを返す', async () => {
        vi.mocked(getBatchJob).mockRejectedValueOnce(new Error('合成の通信障害'));
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(res.status).toBe(502);
        expect(updateTranscriptionJob).toHaveBeenCalledWith('job-1', { status: 'running' });
        expect(failTranscriptionDocument).not.toHaveBeenCalled();
    });

    it.each(['結果一覧取得', '結果 JSON 取得', '結果解析', 'Markdown 化', '文書保存'])(
        'Succeeded 後の%s失敗は理由付き failed にし、未取り込みの Azure 結果を残す', async (stage) => {
            vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
            vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
            if (stage === '結果一覧取得' || stage === '結果 JSON 取得') {
                const actual = await vi.importActual<typeof import('@/server/azureBatchTranscribe')>('@/server/azureBatchTranscribe');
                vi.mocked(fetchBatchResult).mockImplementationOnce(actual.fetchBatchResult);
                const fetchMock = vi.fn();
                if (stage === '結果一覧取得') {
                    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
                } else {
                    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
                        values: [{ kind: 'Transcription', links: { contentUrl: 'https://result.example/synthetic.json' } }],
                    }), { status: 200 })).mockResolvedValueOnce(new Response('invalid json', { status: 200 }));
                }
                vi.stubGlobal('fetch', fetchMock);
            } else if (stage === '結果解析') {
                vi.mocked(fetchBatchResult).mockResolvedValueOnce(null as unknown as AzureBatchResult);
            } else if (stage === 'Markdown 化') {
                vi.spyOn(finalization, 'buildTranscriptMarkdownFromBatch').mockImplementationOnce(() => {
                    throw new Error('合成の整形エラー');
                });
            } else {
                documentDb.runTransaction.mockRejectedValueOnce(new Error('合成の保存エラー'));
            }

            const res = await statusPOST(req({ jobId: 'job-1' }));
            const reason = '文字起こし結果の取り込みに失敗しました。もう一度お試しください。';
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ status: 'failed', docId: 'doc-1', error: reason });
            expect(failTranscriptionDocument).toHaveBeenCalledWith('doc-1', reason, 'GUEST');
            expect(documentDb.data).toMatchObject({ status: 'failed', title: '合成の文書' });
            expect(documentDb.data?.transcription).toContain(reason);
            expect(updateTranscriptionJob).toHaveBeenCalledWith('job-1', { status: 'failed', error: reason });
            expect(deleteBatchJob).not.toHaveBeenCalled();
        },
    );

    it('失敗理由の文書保存まで失敗してもジョブの終端化を試み、Azure 結果は削除しない', async () => {
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
        vi.mocked(fetchBatchResult).mockRejectedValueOnce(new Error('合成の取得エラー'));
        documentDb.runTransaction.mockRejectedValueOnce(new Error('合成の保存エラー'));
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(res.status).toBe(502);
        expect(updateTranscriptionJob).toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'failed' }));
        expect(deleteBatchJob).not.toHaveBeenCalled();
    });

    it.each(['Succeeded', 'Failed'] as const)('利用者が削除した文書を Azure %s で復活させない', async (status) => {
        documentDb.data = undefined;
        vi.mocked(getBatchJob).mockResolvedValue({ status });
        vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect((await res.json()).status).toBe(status === 'Succeeded' ? 'succeeded' : 'failed');
        expect(documentDb.data).toBeUndefined();
        expect(documentDb.tx.set).not.toHaveBeenCalled();
        expect(documentDb.warn).toHaveBeenCalled();
    });

    it('他人のジョブは 403', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue({ ...runningJob, ownerId: 'someuser', ownerType: 'user' });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(res.status).toBe(403);
    });

    it('存在しないジョブは 404', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue(null);
        const res = await statusPOST(req({ jobId: 'nope' }));
        expect(res.status).toBe(404);
    });
});

describe.each(['completed', 'failed'] as const)('文書を %s にする際のトランザクション', (terminalStatus) => {
    const finalizeDocument = () => terminalStatus === 'completed'
        ? completeTranscriptionDocument('doc-1', '合成の文字起こし本文', '合成のモデル', 'GUEST')
        : failTranscriptionDocument('doc-1', '合成の失敗理由', 'GUEST');

    it('所有者が一致する processing のみ更新し、再確定で本文を上書きしない', async () => {
        await finalizeDocument();
        expect(documentDb.runTransaction).toHaveBeenCalledTimes(1);
        expect(documentDb.tx.get).toHaveBeenCalledWith(documentDb.ref);
        expect(documentDb.tx.set).toHaveBeenCalledWith(documentDb.ref, expect.objectContaining({
            status: terminalStatus,
        }), { merge: true });
        expect(documentDb.data).toMatchObject({ status: terminalStatus, ownerId: 'GUEST', title: '合成の文書' });
        const saved = { ...documentDb.data };
        await finalizeDocument();
        expect(documentDb.tx.set).toHaveBeenCalledTimes(1);
        expect(documentDb.data).toEqual(saved);
    });

    it.each(['deleted', 'other-owner', 'completed', 'failed', 'edited', 'missing-status'])(
        '%s の文書は変更せず警告する', async (state) => {
            if (state === 'deleted') documentDb.data = undefined;
            else if (state === 'other-owner') documentDb.data = { ...documentDb.data, ownerId: 'synthetic-other-owner' };
            else documentDb.data = { ...documentDb.data, status: state === 'missing-status' ? undefined : state };
            const before = documentDb.data === undefined ? undefined : { ...documentDb.data };
            await finalizeDocument();
            expect(documentDb.runTransaction).toHaveBeenCalledTimes(1);
            expect(documentDb.tx.get).toHaveBeenCalledWith(documentDb.ref);
            expect(documentDb.tx.set).not.toHaveBeenCalled();
            expect(documentDb.data).toEqual(before);
            expect(documentDb.warn).toHaveBeenCalled();
        },
    );
});
