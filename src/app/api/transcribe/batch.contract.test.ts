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
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { AzureBatchResult, AzureBatchStatus } from '@/lib/azureBatchContract';
import type { TranscribeJobPublicStatus, TranscribeProgressStage } from '@/lib/transcribeBatchContract';

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
        writeProcessingProgress: vi.fn(actual.writeProcessingProgress),
    };
});
vi.mock('@/server/transcriptionJob', async (importActual) => {
    const actual = await importActual<typeof import('@/server/transcriptionJob')>();
    return {
        ...actual,
        claimJobForFinalize: vi.fn(),
        commitTerminalOutcome: vi.fn(actual.commitTerminalOutcome),
        recordAzureObservation: vi.fn(actual.recordAzureObservation),
        createTranscriptionJob: vi.fn(async () => 'job-1'),
        getTranscriptionJob: vi.fn(),
        getTranscriptionJobByDocId: vi.fn(),
        updateTranscriptionJob: vi.fn(async () => undefined),
    };
});

vi.mock('@/server/reviewCandidates', async (importActual) => {
    const actual = await importActual<typeof import('@/server/reviewCandidates')>();
    return { ...actual, buildReviewCandidatesSafe: vi.fn(actual.buildReviewCandidatesSafe) };
});

import { POST as submitPOST } from './submit/route';
import { POST as statusPOST } from './status/route';
import { resolveRequestSubject } from '@/server/auth';
import { submitBatchJob, getAzureCredentials, getBatchJob, fetchBatchResult, deleteBatchJob } from '@/server/azureBatchTranscribe';
import { getSignedReadUrl } from '@/server/mediaSource';
import { attachJobToDocument, createProcessingDocument, writeProcessingProgress } from '@/server/transcriptionDocument';
import { claimJobForFinalize, commitTerminalOutcome, recordAzureObservation, type TranscriptionJob, FINALIZE_LEASE_MS, createTranscriptionJob, getTranscriptionJob, getTranscriptionJobByDocId, updateTranscriptionJob } from '@/server/transcriptionJob';
import { getTranscriptionDocuments, getTranscriptions, getTranscriptionsByOwnerId, restoreTranscription } from '@/lib/firestore';
import * as finalization from '@/server/finalizeTranscription';
import { buildReviewCandidatesSafe, buildUnavailableReview, measureReviewJsonBytes, phraseIdFor } from '@/server/reviewCandidates';
import type { TranscriptReview } from '@/lib/transcriptReviewContract';

const syntheticNowMs = 1_788_000_000_000;
const syntheticCreatedAtMs = syntheticNowMs - 600_000;

const expectedStatus = (status: TranscribeJobPublicStatus, options: {
    stage?: TranscribeProgressStage; observed?: boolean; error?: string;
} = {}) => ({
    status, docId: 'doc-1',
    stage: options.stage ?? (status === 'succeeded' ? 'completed' : status === 'failed' ? 'failed' : 'checking'),
    createdAtMs: syntheticCreatedAtMs, audioSec: 600, serverNowMs: syntheticNowMs,
    ...(options.observed && { azureStatusCheckedAtMs: syntheticNowMs }),
    ...(options.error !== undefined && { error: options.error }),
});

// Firestore の merge/set と delete/serverTimestamp を合成データ上で適用する。
const mergeFirestorePatch = (data: Record<string, unknown> | undefined, patch: Record<string, unknown>) => {
    const result = { ...data };
    for (const [key, value] of Object.entries(patch)) {
        if (value instanceof FieldValue && value.isEqual(FieldValue.delete())) delete result[key];
        else if (value instanceof FieldValue && value.isEqual(FieldValue.serverTimestamp())) {
            result[key] = Timestamp.fromMillis(Date.now());
        } else if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
            result[key] = mergeFirestorePatch(undefined, value as Record<string, unknown>);
        } else result[key] = value;
    }
    return result;
};

/** Firestore Admin SDK は undefined 値を拒否する。保存する review に undefined のキーが無いことの検査用 */
const hasUndefinedDeep = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(hasUndefinedDeep);
    if (value && typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).some((v) => v === undefined || hasUndefinedDeep(v));
    }
    return false;
};

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

/** 要確認候補の素材を含む合成結果: 低信頼句（index 1）と非 Success の句（index 3・表示テキスト空）。 */
const reviewAzureResult = (): AzureBatchResult => ({
    durationMilliseconds: 60_000,
    recognizedPhrases: [
        { offsetMilliseconds: 0, durationMilliseconds: 2000, speaker: 1, recognitionStatus: 'Success', nBest: [{ display: 'こんにちは。', confidence: 0.9 }] },
        { offsetMilliseconds: 2000, durationMilliseconds: 1000, speaker: 1, recognitionStatus: 'Success', nBest: [{ display: 'ええと。', confidence: 0.4 }] },
        { offsetMilliseconds: 3000, durationMilliseconds: 2000, speaker: 2, recognitionStatus: 'Success', nBest: [{ display: 'よろしくお願いします。', confidence: 0.95 }] },
        { offsetMilliseconds: 5000, durationMilliseconds: 500, speaker: 2, recognitionStatus: 'NoMatch', nBest: [{ display: '' }] },
    ],
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(syntheticNowMs);
    vi.mocked(resolveRequestSubject).mockResolvedValue(guest);
    documentDb.data = { ownerId: 'GUEST', status: 'processing', title: '合成の文書', transcription: '処理中' };
    documentDb.jobData = {
        ownerId: 'GUEST', ownerType: 'guest', docId: 'doc-1', status: 'finalizing',
        azureSelfUrl: 'https://ep/speechtotext/transcriptions/JID?api-version=2024-11-15',
        audioSec: 600, storagePath: 'audio/GUEST/x.mp3', promptName: 'p',
        createdAt: Timestamp.fromMillis(syntheticCreatedAtMs), updatedAt: Timestamp.fromMillis(syntheticNowMs),
    };
    documentDb.commitError = undefined;
    documentDb.ref.get.mockImplementation(async () => ({
        exists: documentDb.data !== undefined,
        data: () => documentDb.data,
    }));
    documentDb.ref.set.mockImplementation(async (patch) => {
        documentDb.data = mergeFirestorePatch(documentDb.data, patch);
    });
    documentDb.tx.get.mockImplementation(async (ref) => {
        const data = ref.path === documentDb.jobRef.path ? documentDb.jobData : documentDb.data;
        return { exists: data !== undefined, data: () => data };
    });
    documentDb.runTransaction.mockImplementation(async (fn) => {
        const writes: Array<{ ref: { path: string }; patch: Record<string, unknown> }> = [];
        documentDb.tx.set.mockImplementation((ref, patch) => { writes.push({ ref, patch }); });
        const result = await fn(documentDb.tx);
        if (documentDb.commitError && writes.some(({ ref, patch }) =>
            ref.path === documentDb.jobRef.path && (patch.status === 'succeeded' || patch.status === 'failed'))) {
            const error = documentDb.commitError;
            documentDb.commitError = undefined;
            throw error;
        }
        for (const { ref, patch } of writes) {
            if (ref.path === documentDb.jobRef.path) documentDb.jobData = mergeFirestorePatch(documentDb.jobData, patch);
            else documentDb.data = mergeFirestorePatch(documentDb.data, patch);
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
        promptName: 'p', createdAtMs: syntheticCreatedAtMs, updatedAtMs: syntheticNowMs,
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
        expect(await res.json()).toEqual(expectedStatus('succeeded', { observed: true }));
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
        expect(await res.json()).toEqual(expectedStatus('succeeded', { observed: true }));
        expect(getTranscriptionJobByDocId).toHaveBeenCalledExactlyOnceWith('doc-1');
        expect(getTranscriptionJob).not.toHaveBeenCalled();
        expect(documentDb.data).toMatchObject({ status: 'completed' });
        expect(documentDb.jobData).toMatchObject({ status: 'succeeded' });
    });

    it('docId から Azure の失敗も文書とジョブへ確定する', async () => {
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Failed', error: '合成の失敗理由' });
        const res = await statusPOST(req({ docId: 'doc-1' }));
        expect(await res.json()).toEqual(expectedStatus('failed', { error: '合成の失敗理由', observed: true }));
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
        expect(await res.json()).toEqual(expectedStatus('running', { stage: 'transcribing', observed: true }));
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
        expect(await res.json()).toEqual(expectedStatus('running', { stage: 'transcribing', observed: true }));
        expect(commitTerminalOutcome).not.toHaveBeenCalled();
        expect(claimJobForFinalize).toHaveBeenCalledWith('job-1');
        expect(updateTranscriptionJob).toHaveBeenCalledWith('job-1', { status: 'running' });
    });

    it.each([
        ['NotStarted', 'queued'],
        ['Running', 'transcribing'],
    ] as const)('Azure %s は %s を返し、文書へ段階を投影する', async (azureStatus, stage) => {
        vi.mocked(getBatchJob).mockResolvedValue({ status: azureStatus });
        const beforeUpdatedAt = documentDb.jobData?.updatedAt;
        const res = await statusPOST(req({ jobId: 'job-1' }));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(expectedStatus('running', { stage, observed: true }));
        expect(recordAzureObservation).toHaveBeenCalledExactlyOnceWith('job-1', azureStatus);
        expect(documentDb.jobData).toMatchObject({
            azureStatus, azureStatusCheckedAt: Timestamp.fromMillis(syntheticNowMs), updatedAt: beforeUpdatedAt,
        });
        expect(writeProcessingProgress).toHaveBeenCalledExactlyOnceWith('doc-1', 'GUEST', {
            jobId: 'job-1', stage, jobCreatedAtMs: syntheticCreatedAtMs, audioSec: 600,
        });
        expect(documentDb.data).toMatchObject({
            status: 'processing', jobId: 'job-1', transcription: '処理中',
            processingProgress: {
                stage, stageObservedAt: Timestamp.fromMillis(syntheticNowMs),
                jobCreatedAtMs: syntheticCreatedAtMs, audioSec: 600,
            },
        });
        expect(fetchBatchResult).not.toHaveBeenCalled();
        expect(commitTerminalOutcome).not.toHaveBeenCalled();
    });

    it('同じ段階の再 poll は観測時刻だけを進め、文書の段階時刻を書き直さない', async () => {
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Running' });
        await statusPOST(req({ jobId: 'job-1' }));
        const savedProgress = documentDb.data?.processingProgress;
        documentDb.tx.set.mockClear();
        vi.mocked(Date.now).mockReturnValue(syntheticNowMs + 30_000);

        const res = await statusPOST(req({ jobId: 'job-1' }));

        expect(await res.json()).toMatchObject({
            stage: 'transcribing', azureStatusCheckedAtMs: syntheticNowMs + 30_000,
            serverNowMs: syntheticNowMs + 30_000,
        });
        expect(documentDb.data?.processingProgress).toEqual(savedProgress);
        expect(documentDb.tx.set).toHaveBeenCalledExactlyOnceWith(documentDb.jobRef, {
            azureStatus: 'Running', azureStatusCheckedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
    });

    it('Succeeded を観測したら本文取得の前に importing を投影し、保存後に completed にする', async () => {
        let signalImporting!: () => void;
        const importing = new Promise<void>(resolve => { signalImporting = resolve; });
        let finishImport!: () => void;
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
        vi.mocked(fetchBatchResult).mockImplementationOnce(() => {
            signalImporting();
            return new Promise(resolve => { finishImport = () => resolve(sampleAzureResult()); });
        });

        const request = statusPOST(req({ jobId: 'job-1' }));
        await importing;
        expect(documentDb.data).toMatchObject({ status: 'processing', processingProgress: { stage: 'importing' } });
        expect(documentDb.jobData).toMatchObject({ status: 'finalizing', azureStatus: 'Succeeded' });
        expect(commitTerminalOutcome).not.toHaveBeenCalled();
        expect(deleteBatchJob).not.toHaveBeenCalled();

        vi.mocked(getTranscriptionJob).mockResolvedValueOnce({
            ...runningJob, status: 'finalizing', azureStatus: 'Succeeded', azureStatusCheckedAtMs: syntheticNowMs,
        });
        const concurrent = await statusPOST(req({ jobId: 'job-1' }));
        expect(await concurrent.json()).toEqual(expectedStatus('running', { stage: 'importing', observed: true }));
        finishImport();
        expect(await (await request).json()).toEqual(expectedStatus('succeeded', { observed: true }));
        expect(documentDb.data).toMatchObject({ status: 'completed', transcription: expect.stringContaining('よろしくお願いします') });
        expect(documentDb.data).not.toHaveProperty('processingProgress');
    });

    it.each([
        [undefined, 'checking'], ['NotStarted', 'queued'], ['Running', 'transcribing'],
        ['Succeeded', 'importing'], ['Failed', 'checking'], ['Unknown', 'checking'],
    ] as const)('finalizing は Azure 観測 %s の段階 %s を返す', async (azureStatus, stage) => {
        vi.mocked(getTranscriptionJob).mockResolvedValue({
            ...runningJob, status: 'finalizing', azureStatus: azureStatus as AzureBatchStatus | undefined,
        });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual(expectedStatus('running', { stage }));
        expect(getBatchJob).not.toHaveBeenCalled();
        expect(recordAzureObservation).not.toHaveBeenCalled();
        expect(writeProcessingProgress).not.toHaveBeenCalled();
    });

    it.each(['succeeded', 'failed'] as const)('終端 %s は保存済みの Azure Running より優先する', async status => {
        vi.mocked(getTranscriptionJob).mockResolvedValue({
            ...runningJob, status, azureStatus: 'Running', azureStatusCheckedAtMs: syntheticNowMs - 60_000,
        });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({
            ...expectedStatus(status), azureStatusCheckedAtMs: syntheticNowMs - 60_000,
        });
        expect(getBatchJob).not.toHaveBeenCalled();
        expect(writeProcessingProgress).not.toHaveBeenCalled();
    });

    it.each([undefined, 0, -1, NaN, Infinity, 'invalid'])('旧欠損・不正値 %s の任意情報は省略する', async value => {
        vi.mocked(getTranscriptionJob).mockResolvedValue({
            ...runningJob, status: 'finalizing', createdAtMs: value, audioSec: value, azureStatusCheckedAtMs: value,
        } as unknown as TranscriptionJob);
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({
            status: 'running', docId: 'doc-1', stage: 'checking', serverNowMs: syntheticNowMs,
        });
        expect(getBatchJob).not.toHaveBeenCalled();
    });

    it('🔴 Succeeded で結果取得→Markdown化→文書とジョブの原子的確定→Azure削除まで貫通する', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue(runningJob);
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
        vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual(expectedStatus('succeeded', { observed: true }));
        expect(commitTerminalOutcome).toHaveBeenCalledTimes(1);
        // 実の buildTranscriptMarkdownFromBatch を通した本文が入る（話者ラベル＋時刻）
        expect(commitTerminalOutcome).toHaveBeenCalledWith({
            jobId: 'job-1', docId: 'doc-1', expectedOwnerId: 'GUEST',
            outcome: {
                kind: 'succeeded', transcription: expect.stringContaining('よろしくお願いします'),
                generatedByModel: expect.stringContaining('Azure'), speakers: 2,
                // 要確認候補は本文と同じ commit に載る（設計 B2/B4）
                review: expect.objectContaining({
                    version: 1, sourceJobId: 'job-1', sourceTextHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                }),
            },
        });
        expect(documentDb.data).toMatchObject({
            status: 'completed', transcription: expect.stringContaining('よろしくお願いします'), title: '合成の文書',
        });
        expect(documentDb.jobData).toMatchObject({ status: 'succeeded', speakers: 2 });
        expect(documentDb.runTransaction).toHaveBeenCalledTimes(3);
        expect(updateTranscriptionJob).not.toHaveBeenCalled();
        expect(deleteBatchJob).toHaveBeenCalledTimes(1);
        expect(documentDb.tx.set.mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(deleteBatchJob).mock.invocationCallOrder[0]);
    });

    it('🔴 Failed でも文書は消さず、理由を残して failed を返す（L2-D1 是正）', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue(runningJob);
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Failed', error: 'AudioLengthLimitExceeded' });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        const body = await res.json();
        expect(body).toMatchObject(expectedStatus('failed', { observed: true }));
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
        expect(await res.json()).toEqual(expectedStatus('succeeded'));
        expect(getBatchJob).not.toHaveBeenCalled();
        expect(commitTerminalOutcome).not.toHaveBeenCalled();
        expect(claimJobForFinalize).not.toHaveBeenCalled();
    });

    it('既に failed のジョブは理由を返し、再確定も文書削除もしない', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue({ ...runningJob, status: 'failed', error: '合成の失敗理由' });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual(expectedStatus('failed', { error: '合成の失敗理由' }));
        expect(claimJobForFinalize).not.toHaveBeenCalled();
        expect(getBatchJob).not.toHaveBeenCalled();
        expect(documentDb.tx.set).not.toHaveBeenCalled();
    });

    it('有効な finalizing リースは公開 running として返す', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue({ ...runningJob, status: 'finalizing', updatedAtMs: Date.now() });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual(expectedStatus('running'));
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
        expect(await res.json()).toEqual(expectedStatus('succeeded', { observed: true }));
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
            expect(await res.json()).toEqual(expectedStatus(status === 'finalizing' ? 'running' : status, error));
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
        expect(await second.json()).toEqual(expectedStatus('running'));
        releaseAzure();
        expect(await (await first).json()).toEqual(expectedStatus('succeeded', { observed: true }));
        expect(getBatchJob).toHaveBeenCalledTimes(1);
        expect(fetchBatchResult).toHaveBeenCalledTimes(1);
        expect(commitTerminalOutcome).toHaveBeenCalledTimes(1);
        expect(deleteBatchJob).toHaveBeenCalledTimes(1);
    });

    it('Azure 設定がなくなっても running に戻して再試行できる', async () => {
        vi.mocked(getAzureCredentials).mockReturnValueOnce(null);
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual(expectedStatus('running'));
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

    it.each(['通信失敗', '未知の状態'] as const)('%s は HTTP エラーのまま checking と以前の観測時刻を返す', async failure => {
        const checkedAtMs = syntheticNowMs - 300_000;
        const observedJob = {
            ...runningJob, azureStatus: 'Running' as const, azureStatusCheckedAtMs: checkedAtMs,
        };
        vi.mocked(getTranscriptionJob).mockResolvedValue(observedJob);
        vi.mocked(claimJobForFinalize).mockResolvedValue({ ...observedJob, status: 'finalizing' });
        documentDb.jobData = {
            ...documentDb.jobData, azureStatus: 'Running', azureStatusCheckedAt: Timestamp.fromMillis(checkedAtMs),
        };
        documentDb.data = {
            ...documentDb.data, processingProgress: { stage: 'transcribing', stageObservedAt: Timestamp.fromMillis(checkedAtMs) },
        };
        const before = { ...documentDb.data };
        if (failure === '通信失敗') vi.mocked(getBatchJob).mockRejectedValueOnce(new Error('合成の通信障害'));
        else vi.mocked(getBatchJob).mockResolvedValueOnce({ status: 'Unknown' as AzureBatchStatus });

        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body).toEqual({
            error: 'upstream_error', message: expect.any(String), docId: 'doc-1', stage: 'checking',
            azureStatusCheckedAtMs: checkedAtMs, createdAtMs: syntheticCreatedAtMs,
            audioSec: 600, serverNowMs: syntheticNowMs,
        });
        expect(body).not.toHaveProperty('status');
        expect(recordAzureObservation).not.toHaveBeenCalled();
        expect(writeProcessingProgress).not.toHaveBeenCalled();
        expect(documentDb.data).toEqual(before);
        expect(documentDb.jobData?.azureStatusCheckedAt).toEqual(Timestamp.fromMillis(checkedAtMs));
        expect(updateTranscriptionJob).toHaveBeenCalledExactlyOnceWith('job-1', { status: 'running' });
        expect(commitTerminalOutcome).not.toHaveBeenCalled();
        expect(deleteBatchJob).not.toHaveBeenCalled();
    });

    it('保存済み Azure 終端から逆戻りする観測は採用せず checking と旧鮮度を返す', async () => {
        const checkedAtMs = syntheticNowMs - 60_000;
        documentDb.jobData = {
            ...documentDb.jobData, azureStatus: 'Succeeded', azureStatusCheckedAt: Timestamp.fromMillis(checkedAtMs),
        };
        vi.mocked(getBatchJob).mockResolvedValueOnce({ status: 'Running' });
        const res = await statusPOST(req({ jobId: 'job-1' }));

        expect(res.status).toBe(502);
        expect(await res.json()).toMatchObject({
            stage: 'checking', azureStatusCheckedAtMs: checkedAtMs, serverNowMs: syntheticNowMs,
        });
        expect(documentDb.tx.set).not.toHaveBeenCalled();
        expect(writeProcessingProgress).not.toHaveBeenCalled();
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
                vi.spyOn(finalization, 'buildTranscriptWithAnchors').mockImplementationOnce(() => {
                    throw new Error('合成の整形エラー');
                });
            }

            const res = await statusPOST(req({ jobId: 'job-1' }));
            const reason = '文字起こし結果の取り込みに失敗しました。もう一度お試しください。';
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual(expectedStatus('failed', { error: reason, observed: true }));
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
            expect(documentDb.tx.set).toHaveBeenCalledTimes(4);
            expect(documentDb.data).toMatchObject(original);
            expect(documentDb.data).toMatchObject({
                status: 'processing', processingProgress: { stage: stage === 'Failed' ? 'checking' : 'importing' },
            });
            expect(documentDb.jobData).toMatchObject({ status: 'finalizing' });
            expect(commitTerminalOutcome).toHaveBeenCalledTimes(1);
            expect(updateTranscriptionJob).not.toHaveBeenCalled();
            expect(deleteBatchJob).not.toHaveBeenCalled();

            vi.mocked(getTranscriptionJob).mockResolvedValueOnce({
                ...runningJob, status: 'finalizing', updatedAtMs: Date.now() - FINALIZE_LEASE_MS - 1,
            });
            vi.mocked(getBatchJob).mockResolvedValue({ status: stage === 'Failed' ? 'Failed' : 'Succeeded' });
            const retried = await statusPOST(req({ jobId: 'job-1' }));
            const failed = stage === 'Failed';
            expect(await retried.json()).toEqual(expectedStatus(failed ? 'failed' : 'succeeded', {
                observed: true, ...(failed && { error: 'Azure 側で処理に失敗しました。' }),
            }));
            expect(documentDb.data).toMatchObject({
                status: failed ? 'failed' : 'completed',
                transcription: expect.stringContaining(failed ? 'Azure 側で処理に失敗しました。' : 'よろしくお願いします'),
            });
            expect(documentDb.data).not.toHaveProperty('processingProgress');
            expect(documentDb.jobData).toMatchObject({ status: failed ? 'failed' : 'succeeded' });
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
        expect(documentDb.tx.set).toHaveBeenCalledTimes(2);
        expect(documentDb.tx.set).toHaveBeenCalledWith(documentDb.jobRef, expect.objectContaining({
            status: status === 'Succeeded' ? 'succeeded' : 'failed',
        }), { merge: true });
        expect(deleteBatchJob).toHaveBeenCalledTimes(1);
        expect(documentDb.warn).toHaveBeenCalled();
    });

    it.each(['Succeeded', 'Failed', '取り込み失敗'] as const)(
        '%s の commit が not_owner なら最新の失敗理由を返し、本文更新も Azure 削除もしない', async (stage) => {
            const reason = '別リクエストが確定した合成の失敗理由';
            vi.mocked(commitTerminalOutcome).mockImplementationOnce(async params => {
                // Azure 観測と進捗投影を終えた後、保存直前に別リクエストが確定する。
                documentDb.jobData = { ...documentDb.jobData, status: 'failed', error: reason };
                const actual = await vi.importActual<typeof import('@/server/transcriptionJob')>('@/server/transcriptionJob');
                return actual.commitTerminalOutcome(params);
            });
            vi.mocked(getTranscriptionJob)
                .mockResolvedValueOnce(runningJob)
                .mockResolvedValueOnce({ ...runningJob, status: 'failed', error: reason });
            vi.mocked(getBatchJob).mockResolvedValue({ status: stage === 'Failed' ? 'Failed' : 'Succeeded' });
            vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
            if (stage === '取り込み失敗') {
                vi.mocked(fetchBatchResult).mockRejectedValueOnce(new Error('合成の取得エラー'));
            }
            const res = await statusPOST(req({ jobId: 'job-1' }));
            expect(await res.json()).toEqual(expectedStatus('failed', { error: reason }));
            expect(commitTerminalOutcome).toHaveResolvedWith('not_owner');
            expect(getTranscriptionJob).toHaveBeenCalledTimes(2);
            expect(documentDb.tx.set).toHaveBeenCalledTimes(2);
            expect(documentDb.data).toMatchObject({ status: 'processing', transcription: '処理中' });
            expect(updateTranscriptionJob).not.toHaveBeenCalled();
            expect(deleteBatchJob).not.toHaveBeenCalled();
        },
    );

    it.each(['running', 'finalizing', 'succeeded', 'deleted'] as const)(
        'commit 権を失った後の現在状態 %s を返す', async (status) => {
            // 観測後の commit 時点で権限を失い、再読込時に次の処理が進んでいる場合も含む。
            vi.mocked(commitTerminalOutcome).mockImplementationOnce(async params => {
                documentDb.jobData = status === 'deleted' ? undefined : { ...documentDb.jobData, status: 'running' };
                const actual = await vi.importActual<typeof import('@/server/transcriptionJob')>('@/server/transcriptionJob');
                return actual.commitTerminalOutcome(params);
            });
            vi.mocked(getTranscriptionJob)
                .mockResolvedValueOnce(runningJob)
                .mockResolvedValueOnce(status === 'deleted' ? null : { ...runningJob, status });
            vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
            vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
            const res = await statusPOST(req({ jobId: 'job-1' }));
            if (status === 'deleted') expect(res.status).toBe(404);
            else expect(await res.json()).toEqual(expectedStatus(status === 'finalizing' ? 'running' : status));
            expect(commitTerminalOutcome).toHaveResolvedWith('not_owner');
            expect(documentDb.tx.set).toHaveBeenCalledTimes(2);
            expect(documentDb.data).toMatchObject({ status: 'processing', transcription: '処理中' });
            expect(deleteBatchJob).not.toHaveBeenCalled();
        },
    );

    it('🔴 Succeeded の確定で要確認候補を本文と同じ commit に渡し、段落開始行と本文ハッシュを付けて文書に保存する', async () => {
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
        vi.mocked(fetchBatchResult).mockResolvedValue(reviewAzureResult());
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual(expectedStatus('succeeded', { observed: true }));

        // 抽出側（安全版）には全句の品質素材を元 index 順で渡す（判定はこちらでしない）。音声長は >0 のときだけ渡す
        expect(buildReviewCandidatesSafe).toHaveBeenCalledTimes(1);
        const [phrases, sourceJobId, sourceTextHash, options] = vi.mocked(buildReviewCandidatesSafe).mock.calls[0];
        expect(sourceJobId).toBe('job-1');
        expect(options).toEqual({ threshold: 0.75, audioSec: 60 });
        expect(phrases.map((p) => p.index)).toEqual([0, 1, 2, 3]);
        expect(phrases[1]).toMatchObject({ text: 'ええと。', confidence: 0.4, recognitionStatus: 'Success', speaker: 'spk:1', startSec: 2, endSec: 3 });
        expect(phrases[3]).toMatchObject({ text: '', recognitionStatus: 'NoMatch', speaker: 'spk:2' });

        const { outcome } = vi.mocked(commitTerminalOutcome).mock.calls[0][0];
        if (outcome.kind !== 'succeeded') throw new Error('succeeded 以外の outcome');
        const review = outcome.review as TranscriptReview;
        expect(sourceTextHash).toBe(finalization.sourceTextHashOf(outcome.transcription));
        expect(review).toMatchObject({ version: 1, sourceJobId: 'job-1', sourceTextHash, availability: 'complete' });
        expect(review.summary.totalPhrases).toBe(4);
        expect(hasUndefinedDeep(review)).toBe(false);
        // 低信頼句（index 1）は 1 段落目（1 行目）、非 Success（index 3）は 2 段落目（3 行目）
        const lines = outcome.transcription.split('\n');
        expect(lines[0]).toContain('ええと。');
        expect(lines[2]).toContain('よろしくお願いします。');
        const low = review.candidates.find((c) => c.phraseId === phraseIdFor(1));
        const flagged = review.candidates.find((c) => c.phraseId === phraseIdFor(3));
        expect(low).toMatchObject({ reasons: expect.arrayContaining(['low_confidence']), confidence: 0.4, paragraphStartLine: 1 });
        expect(flagged).toMatchObject({ paragraphStartLine: 3 });
        expect(review.candidates.find((c) => c.phraseId === phraseIdFor(0))).toBeUndefined();
        expect(review.candidates.find((c) => c.phraseId === phraseIdFor(2))).toBeUndefined();

        // 文書に本文と同じ set で保存され、job には複製しない
        expect(documentDb.tx.set).toHaveBeenCalledWith(documentDb.ref, expect.objectContaining({
            transcription: outcome.transcription, transcriptReview: review, status: 'completed',
        }), { merge: true });
        expect(documentDb.data).toMatchObject({ status: 'completed', transcriptReview: review });
        expect(documentDb.jobData).toMatchObject({ status: 'succeeded' });
        expect(documentDb.jobData).not.toHaveProperty('transcriptReview');
        expect(deleteBatchJob).toHaveBeenCalledTimes(1);
    });

    it.each(['抽出側が例外を投げる', '抽出側が unavailable を返す'] as const)(
        '🔴 %s場合も本文が読めれば completed にし、unavailable と理由だけを保存する（設計 B4）', async (failure) => {
            vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
            vi.mocked(fetchBatchResult).mockResolvedValue(reviewAzureResult());
            if (failure === '抽出側が例外を投げる') {
                vi.mocked(buildReviewCandidatesSafe).mockImplementationOnce(() => { throw new Error('合成の抽出エラー'); });
            } else {
                vi.mocked(buildReviewCandidatesSafe).mockImplementationOnce((_phrases, jobId, hash) =>
                    buildUnavailableReview(jobId, hash, 'internal_error'));
            }
            const res = await statusPOST(req({ jobId: 'job-1' }));
            expect(await res.json()).toEqual(expectedStatus('succeeded', { observed: true }));
            expect(documentDb.data).toMatchObject({
                status: 'completed',
                transcription: expect.stringContaining('よろしくお願いします'),
                transcriptReview: {
                    version: 1, threshold: 0.75, sourceJobId: 'job-1', availability: 'unavailable',
                    unavailableReason: 'internal_error', candidates: [],
                },
            });
            const saved = documentDb.data?.transcriptReview as TranscriptReview;
            expect(saved.sourceTextHash).toBe(finalization.sourceTextHashOf(documentDb.data?.transcription as string));
            expect(documentDb.jobData).toMatchObject({ status: 'succeeded' });
            expect(documentDb.jobData).not.toHaveProperty('transcriptReview');
            expect(deleteBatchJob).toHaveBeenCalledTimes(1);
            expect(documentDb.warn).toHaveBeenCalledWith(
                failure === '抽出側が例外を投げる' ? '要確認候補の生成に失敗（本文は完成させる）' : '要確認候補を作れなかった（本文は完成させる）',
                { jobId: 'job-1', reason: failure === '抽出側が例外を投げる' ? '合成の抽出エラー' : 'internal_error' },
            );
        },
    );

    it.each(['minimal', 'omitted'] as const)(
        '🔴 本文が長く文書全体の保存予算に候補が収まらないときは %s にし、本文は切り詰めず completed にする', async (mode) => {
            // 本文サイズ = 1 MiB − 見込み − 余白。minimal: 最小形だけ収まる余白／omitted: 最小形も収まらない
            const minimalBytes = measureReviewJsonBytes(buildUnavailableReview('job-1', 'x'.repeat(64), 'storage_budget', 0.75));
            const limit = finalization.FIRESTORE_MAX_DOCUMENT_BYTES - finalization.DOCUMENT_OVERHEAD_HEADROOM_BYTES;
            const prefix = '[00:00](#t=0) **spk:1** ';
            const bodyChars = mode === 'minimal' ? limit - (minimalBytes + 100) - prefix.length : limit - prefix.length + 1;
            vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
            vi.mocked(fetchBatchResult).mockResolvedValue({
                durationMilliseconds: 60_000,
                recognizedPhrases: [{
                    offsetMilliseconds: 0, durationMilliseconds: 2000, speaker: 1, recognitionStatus: 'Success',
                    nBest: [{ display: 'a'.repeat(bodyChars), confidence: 0.4 }],
                }],
            });
            const res = await statusPOST(req({ jobId: 'job-1' }));
            expect(await res.json()).toEqual(expectedStatus('succeeded', { observed: true }));
            expect(documentDb.data).toMatchObject({ status: 'completed' });
            expect((documentDb.data?.transcription as string).length).toBe(prefix.length + bodyChars);
            if (mode === 'minimal') {
                expect(documentDb.data?.transcriptReview).toMatchObject({
                    availability: 'unavailable', unavailableReason: 'storage_budget', candidates: [], sourceJobId: 'job-1',
                });
                expect(documentDb.warn).toHaveBeenCalledWith('要確認候補が文書の保存予算に収まらないため最小形にする',
                    expect.objectContaining({ jobId: 'job-1', candidates: 1 }));
            } else {
                expect(documentDb.data).not.toHaveProperty('transcriptReview');
                expect(documentDb.warn).toHaveBeenCalledWith('最小形でも収まらないため要確認候補を省く（本文は保存する）',
                    expect.objectContaining({ jobId: 'job-1' }));
            }
            expect(documentDb.jobData).toMatchObject({ status: 'succeeded' });
            expect(deleteBatchJob).toHaveBeenCalledTimes(1);
        },
    );

    it('commit 失敗後の再確定でも要確認候補は同じ入力から同じ内容になる（append しない）', async () => {
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
        vi.mocked(fetchBatchResult).mockResolvedValue(reviewAzureResult());
        documentDb.commitError = new Error('合成の commit エラー');
        expect((await statusPOST(req({ jobId: 'job-1' }))).status).toBe(502);
        expect(documentDb.data).not.toHaveProperty('transcriptReview');
        expect(documentDb.data).toMatchObject({ status: 'processing' });

        vi.mocked(getTranscriptionJob).mockResolvedValueOnce({
            ...runningJob, status: 'finalizing', updatedAtMs: Date.now() - FINALIZE_LEASE_MS - 1,
        });
        const retried = await statusPOST(req({ jobId: 'job-1' }));
        expect(await retried.json()).toEqual(expectedStatus('succeeded', { observed: true }));
        const outcomes = vi.mocked(commitTerminalOutcome).mock.calls.map(([params]) => params.outcome);
        expect(outcomes).toHaveLength(2);
        expect(outcomes[1]).toEqual(outcomes[0]);
        expect(documentDb.data).toMatchObject({
            status: 'completed', transcriptReview: expect.objectContaining({ availability: 'complete', sourceJobId: 'job-1' }),
        });
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
    const finalizeDocument = () => commitTerminalOutcome({
        jobId: 'job-1', docId: 'doc-1', expectedOwnerId: 'GUEST',
        outcome: terminalStatus === 'completed'
            ? { kind: 'succeeded', transcription: '合成の文字起こし本文', generatedByModel: '合成のモデル', speakers: 2 }
            : { kind: 'failed', reason: '合成の失敗理由' },
    });

    it('所有者が一致する processing のみ更新し、再確定で本文を上書きしない', async () => {
        documentDb.data = { ...documentDb.data, processingProgress: { stage: 'importing' } };
        await expect(finalizeDocument()).resolves.toBe('committed');
        expect(documentDb.runTransaction).toHaveBeenCalledTimes(1);
        expect(documentDb.tx.get).toHaveBeenCalledWith(documentDb.jobRef);
        expect(documentDb.tx.get).toHaveBeenCalledWith(documentDb.ref);
        expect(documentDb.tx.set).toHaveBeenCalledWith(documentDb.ref, expect.objectContaining({
            status: terminalStatus,
        }), { merge: true });
        expect(documentDb.data).toMatchObject({ status: terminalStatus, ownerId: 'GUEST', title: '合成の文書' });
        expect(documentDb.data).not.toHaveProperty('processingProgress');
        expect(documentDb.tx.set).toHaveBeenCalledWith(documentDb.ref, expect.objectContaining({
            processingProgress: FieldValue.delete(),
        }), { merge: true });
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

    it.each(readers)('%s は completed 文書の transcriptReview をそのまま載せ、旧文書・不正な形では undefined', async (_name, read) => {
        const savedReview: TranscriptReview = {
            version: 1, threshold: 0.75, sourceTextHash: 'a'.repeat(64), sourceJobId: 'job-1',
            summary: {
                totalPhrases: 4, lowConfidence: 1, recognitionFlagged: 1, candidateTotal: 2,
                unknownConfidence: 1, unknownRecognitionStatus: 0, noTimeCandidates: 0, savedCandidates: 2,
            },
            availability: 'complete',
            candidates: [
                { phraseId: 'p1', reasons: ['low_confidence'], excerpt: 'ええと。', excerptTruncated: false, confidence: 0.4, paragraphStartLine: 1 },
                { phraseId: 'p3', reasons: ['recognition_status'], excerpt: '', excerptTruncated: false, recognitionStatus: 'NoMatch', paragraphStartLine: 3 },
            ],
        };
        const base = { fileName: 'synthetic.mp3', promptName: '合成プロンプト', originalFileType: 'audio', ownerType: 'guest', ownerId: 'GUEST', transcription: '合成本文' };
        clientDb.getDocs.mockResolvedValue({
            forEach: (fn: (snapshot: { id: string; data: () => Record<string, unknown> }) => void) => {
                fn({ id: 'doc-1', data: () => ({ ...base, title: '完成文書', status: 'completed', transcriptReview: savedReview }) });
                fn({ id: 'legacy', data: () => ({ ...base, title: '旧文書' }) });
                fn({ id: 'broken', data: () => ({ ...base, title: '壊れた形', transcriptReview: 'not-an-object' }) });
            },
        });
        const documents = await read();
        expect(documents).toHaveLength(3);
        expect(documents[0].transcriptReview).toEqual(savedReview);
        expect(documents[1].transcriptReview).toBeUndefined();
        expect(documents[2].transcriptReview).toBeUndefined();
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
