import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type JobRef = { id: string };
type JobData = Record<string, unknown>;
type Transaction = {
    get: (ref: JobRef) => Promise<{ exists: boolean; data: () => JobData | undefined }>;
    update: (ref: JobRef, patch: JobData) => void;
    set: (ref: JobRef, patch: JobData, options: { merge: boolean }) => void;
};

const doubles = vi.hoisted(() => ({
    jobs: new Map<string, JobData>(),
    transactionTail: Promise.resolve() as Promise<unknown>,
    commitError: undefined as Error | undefined,
    get: vi.fn(),
    update: vi.fn(),
    set: vi.fn(),
    runTransaction: vi.fn(),
    where: vi.fn(),
    queryGet: vi.fn(),
    warn: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: doubles.warn, error: vi.fn() }) }));
vi.mock('firebase-admin/firestore', () => ({
    FieldValue: { serverTimestamp: () => 'SERVER_TS' },
}));
vi.mock('./firebaseAdmin', () => ({
    getAdminFirestore: () => ({
        collection: (name: string) => ({
            doc: (id: string) => ({ id: `${name}/${id}` }),
            where: doubles.where,
        }),
        runTransaction: doubles.runTransaction,
    }),
}));

import { claimJobForFinalize, commitTerminalOutcome, FINALIZE_LEASE_MS, getTranscriptionJobByDocId, type TerminalOutcome } from './transcriptionJob';

const NOW_MS = 1_800_000_000_000;
const JOB_ID = 'synthetic-job';
const JOB_PATH = `transcriptionJobs/${JOB_ID}`;
const DOC_ID = 'synthetic-document';
const DOC_PATH = `transcriptions/${DOC_ID}`;
const OWNER_ID = 'synthetic-owner';

const makeJob = (patch: JobData = {}): JobData => ({
    ownerId: 'synthetic-owner',
    ownerType: 'user',
    docId: 'synthetic-document',
    azureSelfUrl: 'https://example.invalid/transcriptions/synthetic-job',
    status: 'running',
    audioSec: 120,
    storagePath: 'synthetic-owner/audio.mp3',
    promptName: '全文文字起こし',
    createdAt: { toMillis: () => NOW_MS - 60_000 },
    updatedAt: { toMillis: () => NOW_MS - 30_000 },
    ...patch,
});

const makeDocument = (patch: JobData = {}): JobData => ({
    ownerId: OWNER_ID,
    status: 'processing',
    transcription: '合成の処理中本文',
    title: '合成の文書',
    ...patch,
});

const successOutcome: TerminalOutcome = {
    kind: 'succeeded',
    transcription: '合成の文字起こし結果',
    generatedByModel: 'Azure synthetic model',
    speakers: 2,
};
const failureOutcome: TerminalOutcome = { kind: 'failed', reason: '合成の失敗理由' };
const terminalParams = (outcome: TerminalOutcome) => ({ jobId: JOB_ID, docId: DOC_ID, expectedOwnerId: OWNER_ID, outcome });

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    doubles.jobs.clear();
    doubles.transactionTail = Promise.resolve();
    doubles.commitError = undefined;
    doubles.set.mockReset();
    doubles.where.mockReturnValue({ get: doubles.queryGet });
    doubles.queryGet.mockResolvedValue({ docs: [] });
    // Firestore の同じ文書に対するトランザクションを直列化し、確定した更新を次の読取へ渡す。
    doubles.runTransaction.mockImplementation((fn: (tx: Transaction) => Promise<unknown>) => {
        const result = doubles.transactionTail.then(async () => {
            const pendingUpdates: Array<{ ref: JobRef; patch: JobData }> = [];
            const value = await fn({
                get: async ref => {
                    if (pendingUpdates.length > 0) throw new Error('Firestore reads must precede writes');
                    doubles.get(ref);
                    const data = doubles.jobs.get(ref.id);
                    return { exists: data !== undefined, data: () => data };
                },
                update: (ref, patch) => {
                    doubles.update(ref, patch);
                    pendingUpdates.push({ ref, patch });
                },
                set: (ref, patch, options) => {
                    doubles.set(ref, patch, options);
                    pendingUpdates.push({ ref, patch });
                },
            });
            if (doubles.commitError) throw doubles.commitError;
            for (const { ref, patch } of pendingUpdates) {
                doubles.jobs.set(ref.id, {
                    ...doubles.jobs.get(ref.id),
                    ...patch,
                    updatedAt: patch.updatedAt === 'SERVER_TS' ? { toMillis: () => NOW_MS } : patch.updatedAt,
                });
            }
            return value;
        });
        doubles.transactionTail = result.catch(() => undefined);
        return result;
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('getTranscriptionJobByDocId', () => {
    it('docId 単一等値で検索し、該当がなければ null を返す', async () => {
        await expect(getTranscriptionJobByDocId(DOC_ID)).resolves.toBeNull();
        expect(doubles.where).toHaveBeenCalledExactlyOnceWith('docId', '==', DOC_ID);
        expect(doubles.queryGet).toHaveBeenCalledTimes(1);
    });

    it('クエリ順によらず createdAt が最新のジョブを採る', async () => {
        doubles.queryGet.mockResolvedValue({ docs: [
            { id: 'synthetic-middle', data: () => makeJob({ createdAt: NOW_MS - 1000 }) },
            { id: 'synthetic-newest', data: () => makeJob({ createdAt: { toMillis: () => NOW_MS } }) },
            { id: 'synthetic-oldest', data: () => makeJob({ createdAt: { toMillis: () => NOW_MS - 2000 } }) },
        ] });
        await expect(getTranscriptionJobByDocId(DOC_ID)).resolves.toMatchObject({
            id: 'synthetic-newest', docId: DOC_ID, createdAtMs: NOW_MS,
        });
        expect(doubles.where).toHaveBeenCalledExactlyOnceWith('docId', '==', DOC_ID);
    });

    it('壊れたジョブを除外し、有効な一件を返す', async () => {
        doubles.queryGet.mockResolvedValue({ docs: [
            { id: 'synthetic-invalid', data: () => ({ docId: DOC_ID, createdAt: NOW_MS }) },
            { id: JOB_ID, data: () => makeJob() },
        ] });
        await expect(getTranscriptionJobByDocId(DOC_ID)).resolves.toMatchObject({ id: JOB_ID, docId: DOC_ID });
    });
});

describe('claimJobForFinalize', () => {
    it('存在しないジョブを作らず null を返す', async () => {
        await expect(claimJobForFinalize(JOB_ID)).resolves.toBeNull();
        expect(doubles.update).not.toHaveBeenCalled();
        expect(doubles.jobs.size).toBe(0);
    });

    it.each(['succeeded', 'failed'])('終端 %s は再確定しない', async status => {
        doubles.jobs.set(JOB_PATH, makeJob({ status }));
        await expect(claimJobForFinalize(JOB_ID)).resolves.toBeNull();
        expect(doubles.update).not.toHaveBeenCalled();
    });

    it('running を finalizing に変更し、更新後のジョブを返す', async () => {
        doubles.jobs.set(JOB_PATH, makeJob());
        await expect(claimJobForFinalize(JOB_ID)).resolves.toEqual({
            id: JOB_ID,
            ownerId: 'synthetic-owner',
            ownerType: 'user',
            docId: 'synthetic-document',
            azureSelfUrl: 'https://example.invalid/transcriptions/synthetic-job',
            status: 'finalizing',
            audioSec: 120,
            storagePath: 'synthetic-owner/audio.mp3',
            promptName: '全文文字起こし',
            createdAtMs: NOW_MS - 60_000,
            updatedAtMs: NOW_MS,
        });
        expect(doubles.runTransaction).toHaveBeenCalledTimes(1);
        expect(doubles.update).toHaveBeenCalledWith({ id: JOB_PATH }, { status: 'finalizing', updatedAt: 'SERVER_TS' });
        expect(doubles.jobs.get(JOB_PATH)?.status).toBe('finalizing');
    });

    it.each([0, FINALIZE_LEASE_MS - 1, FINALIZE_LEASE_MS])('リースが切れていない finalizing（経過 %i ms）は取得しない', async elapsedMs => {
        doubles.jobs.set(JOB_PATH, makeJob({ status: 'finalizing', updatedAt: { toMillis: () => NOW_MS - elapsedMs } }));
        await expect(claimJobForFinalize(JOB_ID)).resolves.toBeNull();
        expect(doubles.update).not.toHaveBeenCalled();
    });

    it('リースが切れた finalizing は取得し直して時刻を更新する', async () => {
        doubles.jobs.set(JOB_PATH, makeJob({ status: 'finalizing', updatedAt: { toMillis: () => NOW_MS - FINALIZE_LEASE_MS - 1 } }));
        await expect(claimJobForFinalize(JOB_ID)).resolves.toMatchObject({ status: 'finalizing', updatedAtMs: NOW_MS });
        expect(doubles.update).toHaveBeenCalledTimes(1);
    });

    it('並行した 2 リクエストのうち 1 つだけ確定権を得る', async () => {
        doubles.jobs.set(JOB_PATH, makeJob());
        const jobs = await Promise.all([claimJobForFinalize(JOB_ID), claimJobForFinalize(JOB_ID)]);
        expect(jobs.filter(job => job !== null)).toHaveLength(1);
        expect(jobs.filter(job => job === null)).toHaveLength(1);
        expect(doubles.runTransaction).toHaveBeenCalledTimes(2);
        expect(doubles.update).toHaveBeenCalledTimes(1);
    });
});

describe('commitTerminalOutcome', () => {
    beforeEach(() => {
        doubles.jobs.set(JOB_PATH, makeJob({ status: 'finalizing', updatedAt: { toMillis: () => NOW_MS } }));
        doubles.jobs.set(DOC_PATH, makeDocument());
    });

    it('文書とジョブを同じトランザクションで読み、成功本文と終端状態を同時に保存する', async () => {
        await expect(commitTerminalOutcome(terminalParams(successOutcome))).resolves.toBe('committed');
        expect(doubles.runTransaction).toHaveBeenCalledTimes(1);
        expect(doubles.get.mock.calls).toEqual([[{ id: JOB_PATH }], [{ id: DOC_PATH }]]);
        expect(doubles.set).toHaveBeenCalledTimes(2);
        expect(doubles.set).toHaveBeenNthCalledWith(1, { id: DOC_PATH }, {
            transcription: successOutcome.transcription,
            generatedByModel: successOutcome.generatedByModel,
            status: 'completed',
            updatedAt: 'SERVER_TS',
        }, { merge: true });
        expect(doubles.set).toHaveBeenNthCalledWith(2, { id: JOB_PATH }, {
            status: 'succeeded', speakers: 2, updatedAt: 'SERVER_TS',
        }, { merge: true });
        expect(doubles.jobs.get(DOC_PATH)).toMatchObject({
            title: '合成の文書', status: 'completed', transcription: successOutcome.transcription,
            generatedByModel: successOutcome.generatedByModel,
        });
        expect(doubles.jobs.get(JOB_PATH)).toMatchObject({ status: 'succeeded', speakers: 2, docId: DOC_ID });
        expect(doubles.update).not.toHaveBeenCalled();
    });

    it('失敗でも文書を消さず理由本文を残し、ジョブも同じトランザクションで失敗にする', async () => {
        await expect(commitTerminalOutcome(terminalParams(failureOutcome))).resolves.toBe('committed');
        expect(doubles.runTransaction).toHaveBeenCalledTimes(1);
        expect(doubles.get.mock.calls).toEqual([[{ id: JOB_PATH }], [{ id: DOC_PATH }]]);
        expect(doubles.set).toHaveBeenCalledTimes(2);
        expect(doubles.set).toHaveBeenNthCalledWith(1, { id: DOC_PATH }, {
            transcription: `文字起こしに失敗しました。\n\n理由: ${failureOutcome.reason}\n\nお手数ですが、もう一度お試しください。`,
            status: 'failed', updatedAt: 'SERVER_TS',
        }, { merge: true });
        expect(doubles.set).toHaveBeenNthCalledWith(2, { id: JOB_PATH }, {
            status: 'failed', error: failureOutcome.reason, updatedAt: 'SERVER_TS',
        }, { merge: true });
        expect(doubles.jobs.get(DOC_PATH)).toMatchObject({
            title: '合成の文書', status: 'failed', transcription: expect.stringContaining(failureOutcome.reason),
        });
        expect(doubles.jobs.get(JOB_PATH)).toMatchObject({ status: 'failed', error: failureOutcome.reason });
        expect(doubles.jobs.size).toBe(2);
    });

    it.each([undefined, 'running', 'succeeded', 'failed'])('ジョブが %s なら not_owner を返し、どちらにも書かない', async status => {
        if (status === undefined) doubles.jobs.delete(JOB_PATH);
        else doubles.jobs.set(JOB_PATH, makeJob({ status }));
        const previous = new Map(doubles.jobs);
        await expect(commitTerminalOutcome(terminalParams(successOutcome))).resolves.toBe('not_owner');
        expect(doubles.get.mock.calls).toEqual([[{ id: JOB_PATH }]]);
        expect(doubles.set).not.toHaveBeenCalled();
        expect(doubles.update).not.toHaveBeenCalled();
        expect(doubles.jobs).toEqual(previous);
    });

    describe.each([successOutcome, failureOutcome])('$kind の文書保護と原子性', outcome => {
        it.each([
            { name: '削除済み', document: undefined },
            { name: '所有者が異なる', document: makeDocument({ ownerId: 'synthetic-other-owner' }) },
            { name: 'completed', document: makeDocument({ status: 'completed', transcription: '利用者の合成編集' }) },
            { name: 'failed', document: makeDocument({ status: 'failed', transcription: '既存の合成失敗理由' }) },
            { name: 'status 未設定', document: makeDocument({ status: undefined }) },
        ])('$name の文書は復活・上書きせず、ジョブだけを終端化する', async ({ document }) => {
            if (document === undefined) doubles.jobs.delete(DOC_PATH);
            else doubles.jobs.set(DOC_PATH, document);
            await expect(commitTerminalOutcome(terminalParams(outcome))).resolves.toBe('committed');
            expect(doubles.jobs.get(DOC_PATH)).toEqual(document);
            expect(doubles.jobs.get(JOB_PATH)?.status).toBe(outcome.kind);
            expect(doubles.set).toHaveBeenCalledTimes(1);
            expect(doubles.set).toHaveBeenCalledWith({ id: JOB_PATH }, expect.objectContaining({ status: outcome.kind }), { merge: true });
            expect(doubles.warn).toHaveBeenCalledTimes(1);
        });

        it.each(['文書の書き込み', 'ジョブの書き込み', 'コミット'])('%s が失敗したら両方を維持し、リース切れ後に本文保存を再試行できる', async stage => {
            const error = new Error('synthetic transaction failure');
            if (stage === 'コミット') {
                doubles.commitError = error;
            } else {
                if (stage === 'ジョブの書き込み') doubles.set.mockImplementationOnce(() => undefined);
                doubles.set.mockImplementationOnce(() => { throw error; });
            }
            const previous = new Map(doubles.jobs);
            await expect(commitTerminalOutcome(terminalParams(outcome))).rejects.toBe(error);
            expect(doubles.jobs).toEqual(previous);
            expect(doubles.jobs.get(DOC_PATH)?.status).toBe('processing');
            expect(doubles.jobs.get(JOB_PATH)?.status).toBe('finalizing');

            doubles.commitError = undefined;
            vi.mocked(Date.now).mockReturnValue(NOW_MS + FINALIZE_LEASE_MS + 1);
            await expect(claimJobForFinalize(JOB_ID)).resolves.toMatchObject({ status: 'finalizing' });
            await expect(commitTerminalOutcome(terminalParams(successOutcome))).resolves.toBe('committed');
            expect(doubles.jobs.get(DOC_PATH)).toMatchObject({ status: 'completed', transcription: successOutcome.transcription });
            expect(doubles.jobs.get(JOB_PATH)).toMatchObject({ status: 'succeeded', speakers: 2 });
        });

        it('確定済みなら再実行しても本文とジョブを変更しない', async () => {
            await expect(commitTerminalOutcome(terminalParams(outcome))).resolves.toBe('committed');
            const committed = new Map(doubles.jobs);
            doubles.set.mockClear();
            await expect(commitTerminalOutcome(terminalParams(successOutcome))).resolves.toBe('not_owner');
            expect(doubles.jobs).toEqual(committed);
            expect(doubles.set).not.toHaveBeenCalled();
        });
    });

    it('並行した成功・失敗の確定は片方だけコミットし、文書とジョブの終端状態が一致する', async () => {
        const results = await Promise.all([
            commitTerminalOutcome(terminalParams(successOutcome)),
            commitTerminalOutcome(terminalParams(failureOutcome)),
        ]);
        expect(results).toEqual(['committed', 'not_owner']);
        expect(doubles.jobs.get(DOC_PATH)).toMatchObject({ status: 'completed', transcription: successOutcome.transcription });
        expect(doubles.jobs.get(JOB_PATH)?.status).toBe('succeeded');
        expect(doubles.set).toHaveBeenCalledTimes(2);
    });
});
