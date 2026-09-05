import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type JobRef = { id: string };
type JobData = Record<string, unknown>;
type Transaction = {
    get: (ref: JobRef) => Promise<{ exists: boolean; data: () => JobData | undefined }>;
    update: (ref: JobRef, patch: JobData) => void;
};

const doubles = vi.hoisted(() => ({
    jobs: new Map<string, JobData>(),
    transactionTail: Promise.resolve() as Promise<unknown>,
    update: vi.fn(),
    runTransaction: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('firebase-admin/firestore', () => ({
    FieldValue: { serverTimestamp: () => 'SERVER_TS' },
}));
vi.mock('./firebaseAdmin', () => ({
    getAdminFirestore: () => ({
        collection: (name: string) => ({ doc: (id: string) => ({ id: `${name}/${id}` }) }),
        runTransaction: doubles.runTransaction,
    }),
}));

import { claimJobForFinalize, FINALIZE_LEASE_MS } from './transcriptionJob';

const NOW_MS = 1_800_000_000_000;
const JOB_ID = 'synthetic-job';
const JOB_PATH = `transcriptionJobs/${JOB_ID}`;

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

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    doubles.jobs.clear();
    doubles.transactionTail = Promise.resolve();
    // Firestore の同じ文書に対するトランザクションを直列化し、確定した更新を次の読取へ渡す。
    doubles.runTransaction.mockImplementation((fn: (tx: Transaction) => Promise<unknown>) => {
        const result = doubles.transactionTail.then(async () => {
            const pendingUpdates: Array<{ ref: JobRef; patch: JobData }> = [];
            const value = await fn({
                get: async ref => {
                    const data = doubles.jobs.get(ref.id);
                    return { exists: data !== undefined, data: () => data };
                },
                update: (ref, patch) => {
                    doubles.update(ref, patch);
                    pendingUpdates.push({ ref, patch });
                },
            });
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
