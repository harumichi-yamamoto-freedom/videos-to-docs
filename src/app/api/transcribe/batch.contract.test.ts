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
    jobData: undefined as Record<string, unknown> | undefined,
    ref: { id: 'doc-1', path: 'transcriptions/doc-1', get: vi.fn(), set: vi.fn() },
    jobRef: { id: 'job-1', path: 'transcriptionJobs/job-1' },
    tx: { get: vi.fn(), set: vi.fn() },
    runTransaction: vi.fn(),
    commitError: undefined as Error | undefined,
    warn: vi.fn(),
}));

const clientDb = vi.hoisted(() => ({
    getDocs: vi.fn(),
    getDoc: vi.fn(),
    tx: { get: vi.fn(), set: vi.fn(), update: vi.fn() },
    runTransaction: vi.fn(),
}));

// --- 外界の I/O だけモック（純関数は実物のまま） ---
vi.mock('@/server/firebaseAdmin', () => ({
    getAdminFirestore: () => ({
        collection: (name: string) => ({
            doc: () => name === 'transcriptionJobs' ? documentDb.jobRef : documentDb.ref,
        }),
        runTransaction: documentDb.runTransaction,
    }),
}));
vi.mock('firebase/firestore', async (importActual) => ({
    ...(await importActual<typeof import('firebase/firestore')>()),
    collection: vi.fn(),
    doc: () => documentDb.ref,
    query: vi.fn(),
    getDocs: clientDb.getDocs,
    getDoc: clientDb.getDoc,
    runTransaction: clientDb.runTransaction,
}));
vi.mock('@/lib/firebase', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({ getCurrentUserId: () => 'GUEST', getOwnerType: () => 'guest' }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/adminSettings', () => ({ validateDocumentSize: vi.fn(async () => ({ valid: true })) }));
vi.mock('@/lib/userManagement', () => ({ updateUserStats: vi.fn() }));
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
        attachJobToDocument: vi.fn(actual.attachJobToDocument),
    };
});
vi.mock('@/server/transcriptionJob', async (importActual) => {
    const actual = await importActual<typeof import('@/server/transcriptionJob')>();
    return {
        ...actual,
        claimJobForFinalize: vi.fn(),
        commitTerminalOutcome: vi.fn(actual.commitTerminalOutcome),
        createTranscriptionJob: vi.fn(async () => 'job-1'),
        getTranscriptionJob: vi.fn(),
        getTranscriptionJobByDocId: vi.fn(),
        updateTranscriptionJob: vi.fn(async () => undefined),
    };
});

import { POST as submitPOST } from './submit/route';
import { POST as statusPOST } from './status/route';
import { resolveRequestSubject } from '@/server/auth';
import { submitBatchJob, getAzureCredentials, getBatchJob, fetchBatchResult, deleteBatchJob } from '@/server/azureBatchTranscribe';
import { getSignedReadUrl } from '@/server/mediaSource';
import { attachJobToDocument, createProcessingDocument } from '@/server/transcriptionDocument';
import { claimJobForFinalize, commitTerminalOutcome, FINALIZE_LEASE_MS, createTranscriptionJob, getTranscriptionJob, getTranscriptionJobByDocId, updateTranscriptionJob } from '@/server/transcriptionJob';
import { getTranscriptionDocuments, getTranscriptions, getTranscriptionsByOwnerId, restoreTranscription } from '@/lib/firestore';
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
    documentDb.jobData = { status: 'finalizing' };
    documentDb.commitError = undefined;
    documentDb.ref.get.mockImplementation(async () => ({
        exists: documentDb.data !== undefined,
        data: () => documentDb.data,
    }));
    documentDb.ref.set.mockImplementation(async (patch) => {
        documentDb.data = { ...documentDb.data, ...patch };
    });
    documentDb.tx.get.mockImplementation(async (ref) => {
        const data = ref.path === documentDb.jobRef.path ? documentDb.jobData : documentDb.data;
        return { exists: data !== undefined, data: () => data };
    });
    documentDb.runTransaction.mockImplementation(async (fn) => {
        const writes: Array<{ ref: { path: string }; patch: Record<string, unknown> }> = [];
        documentDb.tx.set.mockImplementation((ref, patch) => { writes.push({ ref, patch }); });
        const result = await fn(documentDb.tx);
        if (documentDb.commitError) {
            const error = documentDb.commitError;
            documentDb.commitError = undefined;
            throw error;
        }
        for (const { ref, patch } of writes) {
            if (ref.path === documentDb.jobRef.path) documentDb.jobData = { ...documentDb.jobData, ...patch };
            else documentDb.data = { ...documentDb.data, ...patch };
        }
        return result;
    });
    clientDb.tx.get.mockResolvedValue({ exists: () => false });
    clientDb.tx.set.mockImplementation((_ref, patch) => { documentDb.data = { ...patch }; });
    clientDb.getDoc.mockImplementation(async () => ({ exists: () => true, data: () => documentDb.data }));
    clientDb.runTransaction.mockImplementation(async (_db, fn) => fn(clientDb.tx));
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
        expect(attachJobToDocument).toHaveBeenCalledExactlyOnceWith('doc-1', 'job-1', 'GUEST');
        expect(vi.mocked(createProcessingDocument).mock.invocationCallOrder[0])
            .toBeLessThan(vi.mocked(createTranscriptionJob).mock.invocationCallOrder[0]);
        expect(vi.mocked(createTranscriptionJob).mock.invocationCallOrder[0])
            .toBeLessThan(vi.mocked(attachJobToDocument).mock.invocationCallOrder[0]);
        expect(documentDb.data).toMatchObject({ status: 'processing', jobId: 'job-1' });
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
        vi.mocked(getTranscriptionJobByDocId).mockResolvedValue(runningJob);
        vi.mocked(claimJobForFinalize).mockResolvedValue({ ...runningJob, status: 'finalizing', updatedAtMs: Date.now() });
    });

    it('docId から文書の jobId を引き、完了結果をその場で文書とジョブへ確定する', async () => {
        documentDb.data = { ...documentDb.data, jobId: 'job-1' };
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
        vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
        const res = await statusPOST(req({ docId: 'doc-1' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'succeeded', docId: 'doc-1' });
        expect(documentDb.ref.get).toHaveBeenCalledTimes(1);
        expect(getTranscriptionJob).toHaveBeenCalledExactlyOnceWith('job-1');
        expect(getTranscriptionJobByDocId).not.toHaveBeenCalled();
        expect(claimJobForFinalize).toHaveBeenCalledWith('job-1');
        expect(documentDb.data).toMatchObject({
            status: 'completed', jobId: 'job-1', transcription: expect.stringContaining('よろしくお願いします'),
        });
        expect(documentDb.jobData).toMatchObject({ status: 'succeeded' });
        expect(deleteBatchJob).toHaveBeenCalledTimes(1);
    });

    it('jobId 未付与の既存文書も docId の逆引きから確定する', async () => {
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
        vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
        const res = await statusPOST(req({ docId: 'doc-1' }));
        expect(await res.json()).toEqual({ status: 'succeeded', docId: 'doc-1' });
        expect(getTranscriptionJobByDocId).toHaveBeenCalledExactlyOnceWith('doc-1');
        expect(getTranscriptionJob).not.toHaveBeenCalled();
        expect(documentDb.data).toMatchObject({ status: 'completed' });
        expect(documentDb.jobData).toMatchObject({ status: 'succeeded' });
    });

    it('docId から Azure の失敗も文書とジョブへ確定する', async () => {
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Failed', error: '合成の失敗理由' });
        const res = await statusPOST(req({ docId: 'doc-1' }));
        expect(await res.json()).toEqual({ status: 'failed', docId: 'doc-1', error: '合成の失敗理由' });
        expect(documentDb.data).toMatchObject({ status: 'failed', transcription: expect.stringContaining('合成の失敗理由') });
        expect(documentDb.jobData).toMatchObject({ status: 'failed' });
    });

    it('docId の文書が他人の所有ならジョブも Azure も読まず 403', async () => {
        documentDb.data = { ...documentDb.data, jobId: 'job-1', ownerId: 'synthetic-other-owner' };
        const res = await statusPOST(req({ docId: 'doc-1' }));
        expect(res.status).toBe(403);
        expect(getTranscriptionJob).not.toHaveBeenCalled();
        expect(getTranscriptionJobByDocId).not.toHaveBeenCalled();
        expect(claimJobForFinalize).not.toHaveBeenCalled();
        expect(getBatchJob).not.toHaveBeenCalled();
    });

    it.each(['attached', 'lookup'])('文書を所有していても %s のジョブ所有者が他人なら 403', async source => {
        const otherJob = { ...runningJob, ownerId: 'synthetic-other-owner', ownerType: 'user' as const };
        if (source === 'attached') {
            documentDb.data = { ...documentDb.data, jobId: 'job-1' };
            vi.mocked(getTranscriptionJob).mockResolvedValue(otherJob);
        } else {
            vi.mocked(getTranscriptionJobByDocId).mockResolvedValue(otherJob);
        }
        const res = await statusPOST(req({ docId: 'doc-1' }));
        expect(res.status).toBe(403);
        expect(claimJobForFinalize).not.toHaveBeenCalled();
        expect(getBatchJob).not.toHaveBeenCalled();
    });

    it.each(['missing', 'different-document'])('保存された jobId が %s なら docId で引き直す', async state => {
        documentDb.data = { ...documentDb.data, jobId: 'synthetic-stale-job' };
        vi.mocked(getTranscriptionJob).mockResolvedValue(state === 'missing' ? null : {
            ...runningJob, id: 'synthetic-stale-job', docId: 'synthetic-other-document',
        });
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Running' });
        const res = await statusPOST(req({ docId: 'doc-1' }));
        expect(await res.json()).toEqual({ status: 'running', docId: 'doc-1' });
        expect(getTranscriptionJob).toHaveBeenCalledWith('synthetic-stale-job');
        expect(getTranscriptionJobByDocId).toHaveBeenCalledExactlyOnceWith('doc-1');
        expect(claimJobForFinalize).toHaveBeenCalledExactlyOnceWith('job-1');
        expect(commitTerminalOutcome).not.toHaveBeenCalled();
    });

    it('docId の文書が存在しなければ 404', async () => {
        documentDb.data = undefined;
        const res = await statusPOST(req({ docId: 'synthetic-missing' }));
        expect(res.status).toBe(404);
        expect(getTranscriptionJobByDocId).not.toHaveBeenCalled();
        expect(getBatchJob).not.toHaveBeenCalled();
    });

    it('docId に対応するジョブがなければ 404', async () => {
        vi.mocked(getTranscriptionJobByDocId).mockResolvedValue(null);
        const res = await statusPOST(req({ docId: 'doc-1' }));
        expect(res.status).toBe(404);
        expect(claimJobForFinalize).not.toHaveBeenCalled();
    });

    it.each([{}, null, { jobId: 'job-1', docId: 'doc-1' }, { docId: '' }, { docId: 1 }, { jobId: ' ' }])(
        'ID の両省略・両指定・不正な形式 %j は 400', async body => {
            const res = await statusPOST(req(body));
            expect(res.status).toBe(400);
            expect(resolveRequestSubject).not.toHaveBeenCalled();
            expect(getTranscriptionJob).not.toHaveBeenCalled();
            expect(getTranscriptionJobByDocId).not.toHaveBeenCalled();
        },
    );

    it('Azure が Running のうちは文書を確定しない', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue(runningJob);
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Running' });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({ status: 'running', docId: 'doc-1' });
        expect(commitTerminalOutcome).not.toHaveBeenCalled();
        expect(claimJobForFinalize).toHaveBeenCalledWith('job-1');
        expect(updateTranscriptionJob).toHaveBeenCalledWith('job-1', { status: 'running' });
    });

    it('🔴 Succeeded で結果取得→Markdown化→文書とジョブの原子的確定→Azure削除まで貫通する', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue(runningJob);
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
        vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({ status: 'succeeded', docId: 'doc-1' });
        expect(commitTerminalOutcome).toHaveBeenCalledTimes(1);
        // 実の buildTranscriptMarkdownFromBatch を通した本文が入る（話者ラベル＋時刻）
        expect(commitTerminalOutcome).toHaveBeenCalledWith({
            jobId: 'job-1', docId: 'doc-1', expectedOwnerId: 'GUEST',
            outcome: {
                kind: 'succeeded', transcription: expect.stringContaining('よろしくお願いします'),
                generatedByModel: expect.stringContaining('Azure'), speakers: 2,
            },
        });
        expect(documentDb.data).toMatchObject({
            status: 'completed', transcription: expect.stringContaining('よろしくお願いします'), title: '合成の文書',
        });
        expect(documentDb.jobData).toMatchObject({ status: 'succeeded', speakers: 2 });
        expect(documentDb.runTransaction).toHaveBeenCalledTimes(1);
        expect(updateTranscriptionJob).not.toHaveBeenCalled();
        expect(deleteBatchJob).toHaveBeenCalledTimes(1);
        expect(documentDb.tx.set.mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(deleteBatchJob).mock.invocationCallOrder[0]);
    });

    it('🔴 Failed でも文書は消さず、理由を残して failed を返す（L2-D1 是正）', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue(runningJob);
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Failed', error: 'AudioLengthLimitExceeded' });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        const body = await res.json();
        expect(body.status).toBe('failed');
        expect(body.error).toContain('AudioLength');
        expect(commitTerminalOutcome).toHaveBeenCalledTimes(1);
        expect(commitTerminalOutcome).toHaveBeenCalledWith({
            jobId: 'job-1', docId: 'doc-1', expectedOwnerId: 'GUEST',
            outcome: { kind: 'failed', reason: 'AudioLengthLimitExceeded' },
        });
        expect(documentDb.data).toMatchObject({ status: 'failed', title: '合成の文書' });
        expect(documentDb.data?.transcription).toContain('AudioLengthLimitExceeded');
        expect(documentDb.jobData).toMatchObject({ status: 'failed', error: 'AudioLengthLimitExceeded' });
        expect(updateTranscriptionJob).not.toHaveBeenCalled();
        expect(deleteBatchJob).toHaveBeenCalledTimes(1);
    });

    it('🔴 既に succeeded のジョブは Azure を叩かず即返す（冪等・二重確定しない）', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue({ ...runningJob, status: 'succeeded' });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({ status: 'succeeded', docId: 'doc-1' });
        expect(getBatchJob).not.toHaveBeenCalled();
        expect(commitTerminalOutcome).not.toHaveBeenCalled();
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
        expect(commitTerminalOutcome).toHaveBeenCalledTimes(1);
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
        expect(commitTerminalOutcome).toHaveBeenCalledTimes(1);
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
        expect(commitTerminalOutcome).not.toHaveBeenCalled();
    });

    it.each(['結果一覧取得', '結果 JSON 取得', '結果解析', 'Markdown 化'])(
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
            }

            const res = await statusPOST(req({ jobId: 'job-1' }));
            const reason = '文字起こし結果の取り込みに失敗しました。もう一度お試しください。';
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ status: 'failed', docId: 'doc-1', error: reason });
            expect(commitTerminalOutcome).toHaveBeenCalledWith({
                jobId: 'job-1', docId: 'doc-1', expectedOwnerId: 'GUEST', outcome: { kind: 'failed', reason },
            });
            expect(documentDb.data).toMatchObject({ status: 'failed', title: '合成の文書' });
            expect(documentDb.data?.transcription).toContain(reason);
            expect(documentDb.jobData).toMatchObject({ status: 'failed', error: reason });
            expect(updateTranscriptionJob).not.toHaveBeenCalled();
            expect(deleteBatchJob).not.toHaveBeenCalled();
        },
    );

    it.each(['Succeeded', 'Failed', '取り込み失敗'] as const)(
        '%s の終端 commit が失敗すると両方非終端に留まり、リース切れ後に本文を保存できる', async (stage) => {
            vi.mocked(getBatchJob).mockResolvedValue({ status: stage === 'Failed' ? 'Failed' : 'Succeeded' });
            vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
            if (stage === '取り込み失敗') {
                vi.mocked(fetchBatchResult).mockRejectedValueOnce(new Error('合成の取得エラー'));
            }
            const original = { ...documentDb.data };
            documentDb.commitError = new Error('合成の commit エラー');
            const res = await statusPOST(req({ jobId: 'job-1' }));
            expect(res.status).toBe(502);
            expect(documentDb.tx.set).toHaveBeenCalledTimes(2);
            expect(documentDb.data).toEqual(original);
            expect(documentDb.jobData).toEqual({ status: 'finalizing' });
            expect(commitTerminalOutcome).toHaveBeenCalledTimes(1);
            expect(updateTranscriptionJob).not.toHaveBeenCalled();
            expect(deleteBatchJob).not.toHaveBeenCalled();

            vi.mocked(getTranscriptionJob).mockResolvedValueOnce({
                ...runningJob, status: 'finalizing', updatedAtMs: Date.now() - FINALIZE_LEASE_MS - 1,
            });
            vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
            const retried = await statusPOST(req({ jobId: 'job-1' }));
            expect(await retried.json()).toEqual({ status: 'succeeded', docId: 'doc-1' });
            expect(documentDb.data).toMatchObject({ status: 'completed', transcription: expect.stringContaining('よろしくお願いします') });
            expect(documentDb.jobData).toMatchObject({ status: 'succeeded' });
            expect(deleteBatchJob).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['Succeeded', 'Failed'] as const)('利用者が削除した文書を Azure %s で復活させない', async (status) => {
        documentDb.data = undefined;
        vi.mocked(getBatchJob).mockResolvedValue({ status });
        vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect((await res.json()).status).toBe(status === 'Succeeded' ? 'succeeded' : 'failed');
        expect(documentDb.data).toBeUndefined();
        expect(documentDb.tx.set).toHaveBeenCalledTimes(1);
        expect(documentDb.tx.set).toHaveBeenCalledWith(documentDb.jobRef, expect.objectContaining({
            status: status === 'Succeeded' ? 'succeeded' : 'failed',
        }), { merge: true });
        expect(deleteBatchJob).toHaveBeenCalledTimes(1);
        expect(documentDb.warn).toHaveBeenCalled();
    });

    it.each(['Succeeded', 'Failed', '取り込み失敗'] as const)(
        '%s の commit が not_owner なら最新の失敗理由を返し、文書更新も Azure 削除もしない', async (stage) => {
            const reason = '別リクエストが確定した合成の失敗理由';
            documentDb.jobData = { status: 'failed', error: reason };
            vi.mocked(getTranscriptionJob)
                .mockResolvedValueOnce(runningJob)
                .mockResolvedValueOnce({ ...runningJob, status: 'failed', error: reason });
            vi.mocked(getBatchJob).mockResolvedValue({ status: stage === 'Failed' ? 'Failed' : 'Succeeded' });
            vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
            if (stage === '取り込み失敗') {
                vi.mocked(fetchBatchResult).mockRejectedValueOnce(new Error('合成の取得エラー'));
            }
            const res = await statusPOST(req({ jobId: 'job-1' }));
            expect(await res.json()).toEqual({ status: 'failed', docId: 'doc-1', error: reason });
            expect(commitTerminalOutcome).toHaveResolvedWith('not_owner');
            expect(getTranscriptionJob).toHaveBeenCalledTimes(2);
            expect(documentDb.tx.set).not.toHaveBeenCalled();
            expect(updateTranscriptionJob).not.toHaveBeenCalled();
            expect(deleteBatchJob).not.toHaveBeenCalled();
        },
    );

    it.each(['running', 'finalizing', 'succeeded', 'deleted'] as const)(
        'commit 権を失った後の現在状態 %s を返す', async (status) => {
            // commit の時点では running に戻っていて、再読込時に次の処理が進んでいる場合も含む。
            documentDb.jobData = status === 'deleted' ? undefined : { status: 'running' };
            vi.mocked(getTranscriptionJob)
                .mockResolvedValueOnce(runningJob)
                .mockResolvedValueOnce(status === 'deleted' ? null : { ...runningJob, status });
            vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
            vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
            const res = await statusPOST(req({ jobId: 'job-1' }));
            if (status === 'deleted') expect(res.status).toBe(404);
            else expect(await res.json()).toEqual({ status: status === 'finalizing' ? 'running' : status, docId: 'doc-1' });
            expect(documentDb.tx.set).not.toHaveBeenCalled();
            expect(deleteBatchJob).not.toHaveBeenCalled();
        },
    );

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
    const finalizeDocument = () => commitTerminalOutcome({
        jobId: 'job-1', docId: 'doc-1', expectedOwnerId: 'GUEST',
        outcome: terminalStatus === 'completed'
            ? { kind: 'succeeded', transcription: '合成の文字起こし本文', generatedByModel: '合成のモデル', speakers: 2 }
            : { kind: 'failed', reason: '合成の失敗理由' },
    });

    it('所有者が一致する processing のみ更新し、再確定で本文を上書きしない', async () => {
        await expect(finalizeDocument()).resolves.toBe('committed');
        expect(documentDb.runTransaction).toHaveBeenCalledTimes(1);
        expect(documentDb.tx.get).toHaveBeenCalledWith(documentDb.jobRef);
        expect(documentDb.tx.get).toHaveBeenCalledWith(documentDb.ref);
        expect(documentDb.tx.set).toHaveBeenCalledWith(documentDb.ref, expect.objectContaining({
            status: terminalStatus,
        }), { merge: true });
        expect(documentDb.data).toMatchObject({ status: terminalStatus, ownerId: 'GUEST', title: '合成の文書' });
        const saved = { ...documentDb.data };
        expect(documentDb.jobData).toMatchObject({ status: terminalStatus === 'completed' ? 'succeeded' : 'failed' });
        await expect(finalizeDocument()).resolves.toBe('not_owner');
        expect(documentDb.tx.set).toHaveBeenCalledTimes(2);
        expect(documentDb.data).toEqual(saved);
    });

    it.each(['deleted', 'other-owner', 'completed', 'failed', 'edited', 'missing-status'])(
        '%s の文書は変更せず警告する', async (state) => {
            if (state === 'deleted') documentDb.data = undefined;
            else if (state === 'other-owner') documentDb.data = { ...documentDb.data, ownerId: 'synthetic-other-owner' };
            else documentDb.data = { ...documentDb.data, status: state === 'missing-status' ? undefined : state };
            const before = documentDb.data === undefined ? undefined : { ...documentDb.data };
            await expect(finalizeDocument()).resolves.toBe('committed');
            expect(documentDb.runTransaction).toHaveBeenCalledTimes(1);
            expect(documentDb.tx.get).toHaveBeenCalledWith(documentDb.ref);
            expect(documentDb.tx.set).toHaveBeenCalledTimes(1);
            expect(documentDb.tx.set).toHaveBeenCalledWith(documentDb.jobRef, expect.objectContaining({
                status: terminalStatus === 'completed' ? 'succeeded' : 'failed',
            }), { merge: true });
            expect(documentDb.data).toEqual(before);
            expect(documentDb.warn).toHaveBeenCalled();
        },
    );
});

describe('処理中の文書の読取・復元とバッチ確定', () => {
    const readers = [
        ['getTranscriptionDocuments', () => getTranscriptionDocuments()],
        ['getTranscriptions', () => getTranscriptions()],
        ['getTranscriptionsByOwnerId', () => getTranscriptionsByOwnerId('GUEST')],
    ] as const;

    it.each(readers)('%s は status と jobId を読取り、復元 payload と確定処理まで保持する', async (_name, read) => {
        documentDb.data = { ...documentDb.data, jobId: 'job-1' };
        clientDb.getDocs.mockResolvedValue({
            forEach: (fn: (snapshot: { id: string; data: () => Record<string, unknown> }) => void) => fn({
                id: 'doc-1',
                data: () => ({
                    ...documentDb.data, fileName: 'synthetic.mp3', promptName: '合成プロンプト',
                    originalFileType: 'audio', ownerType: 'guest',
                }),
            }),
        });
        const [document] = await read();
        expect(document.status).toBe('processing');
        expect(document.jobId).toBe('job-1');
        const source = { ...document, text: 'text' in document ? document.text : document.transcription };
        documentDb.data = undefined;
        await restoreTranscription('doc-1', source, { title: '合成の復元文書' });
        expect(clientDb.tx.set).toHaveBeenCalledWith(documentDb.ref, expect.objectContaining({
            status: 'processing', jobId: 'job-1', title: '合成の復元文書', transcription: '処理中',
        }), { merge: true });
        await expect(commitTerminalOutcome({
            jobId: 'job-1', docId: 'doc-1', expectedOwnerId: 'GUEST',
            outcome: { kind: 'succeeded', transcription: '復元後の合成本文', generatedByModel: '合成モデル', speakers: 1 },
        })).resolves.toBe('committed');
        expect(documentDb.data).toMatchObject({ status: 'completed', jobId: 'job-1', transcription: '復元後の合成本文' });
        expect(documentDb.jobData).toMatchObject({ status: 'succeeded' });
    });

    it.each(readers)('%s は旧文書の status と jobId を undefined として読み、復元 payload に追加しない', async (_name, read) => {
        clientDb.getDocs.mockResolvedValue({
            forEach: (fn: (snapshot: { id: string; data: () => Record<string, unknown> }) => void) => fn({
                id: 'doc-1', data: () => ({ title: '合成の旧文書', fileName: 'synthetic.mp3', transcription: '合成本文' }),
            }),
        });
        const [document] = await read();
        expect(document.status).toBeUndefined();
        expect(document.jobId).toBeUndefined();
        const source = { ...document, text: 'text' in document ? document.text : document.transcription };
        documentDb.data = undefined;
        await restoreTranscription('doc-1', source, {});
        expect(clientDb.tx.set).toHaveBeenCalledTimes(1);
        expect(clientDb.tx.set.mock.calls[0][1]).not.toHaveProperty('status');
        expect(clientDb.tx.set.mock.calls[0][1]).not.toHaveProperty('jobId');
    });
});
