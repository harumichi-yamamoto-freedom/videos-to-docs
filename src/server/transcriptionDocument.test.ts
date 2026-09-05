import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
    document: undefined as Record<string, unknown> | undefined,
    job: undefined as Record<string, unknown> | undefined,
    get: vi.fn(),
    set: vi.fn(),
    doc: vi.fn(),
    jobDoc: vi.fn(),
    runTransaction: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('firebase-admin/firestore', () => ({
    FieldValue: { serverTimestamp: () => 'SERVER_TS', delete: () => 'DELETE_FIELD' },
}));
vi.mock('./firebaseAdmin', () => ({
    getAdminFirestore: () => ({
        collection: (name: string) => ({ doc: name === 'transcriptionJobs' ? doubles.jobDoc : doubles.doc }),
        runTransaction: doubles.runTransaction,
    }),
}));

import {
    attachJobToDocument,
    completeTranscriptionDocument,
    createProcessingDocument,
    failTranscriptionDocument,
    writeProcessingProgress,
} from './transcriptionDocument';

beforeEach(() => {
    vi.clearAllMocks();
    doubles.document = { ownerId: 'synthetic-owner', title: '合成の文書', status: 'processing' };
    doubles.job = { ownerId: 'synthetic-owner', docId: 'synthetic-doc' };
    doubles.doc.mockReturnValue({ id: 'synthetic-doc', get: doubles.get, set: doubles.set });
    doubles.jobDoc.mockReturnValue({ id: 'synthetic-job' });
    doubles.get.mockImplementation(async (ref?: { id: string }) => {
        const data = ref?.id === 'synthetic-job' ? doubles.job : doubles.document;
        return { exists: data !== undefined, data: () => data };
    });
    doubles.set.mockImplementation((data, options) => {
        doubles.document = options?.merge ? { ...doubles.document, ...data } : data;
        for (const key of Object.keys(doubles.document!)) {
            if (doubles.document![key] === 'DELETE_FIELD') delete doubles.document![key];
        }
    });
    // runTransaction は tx.get / tx.set を同じ doubles.document に対して動かす（本物の意味論を模す）
    doubles.runTransaction.mockImplementation(async (fn) => fn({
        get: doubles.get,
        set: (_ref: unknown, data: Record<string, unknown>, options?: { merge?: boolean }) => {
            doubles.set(data, options);
        },
    }));
});

describe('attachJobToDocument', () => {
    it('存在して所有者が一致する文書に jobId だけを merge し、本文等を保持する', async () => {
        await attachJobToDocument('synthetic-doc', 'synthetic-job', 'synthetic-owner');
        expect(doubles.doc).toHaveBeenCalledWith('synthetic-doc');
        expect(doubles.set).toHaveBeenCalledWith({ jobId: 'synthetic-job' }, { merge: true });
        expect(doubles.document).toEqual({
            ownerId: 'synthetic-owner', title: '合成の文書', status: 'processing', jobId: 'synthetic-job',
        });
        // 🔴 存在確認と書込みは同一トランザクション（get→set の隙での再作成を防ぐ）
        expect(doubles.runTransaction).toHaveBeenCalledTimes(1);
    });

    it.each([
        { name: '削除済み', document: undefined },
        { name: '所有者が異なる', document: { ownerId: 'synthetic-other-owner' } },
        { name: '所有者未設定', document: {} },
    ])('$name の文書は更新も再作成もしない', async ({ document }) => {
        doubles.document = document;
        await attachJobToDocument('synthetic-doc', 'synthetic-job', 'synthetic-owner');
        expect(doubles.set).not.toHaveBeenCalled();
        expect(doubles.document).toEqual(document);
    });
});

describe('createProcessingDocument', () => {
    const input = {
        ownerId: 'synthetic-owner', ownerType: 'user' as const, fileName: 'synthetic.mp3',
        promptName: '合成プロンプト', originalFileType: 'audio',
    };

    it('指定された jobId を処理中文書に保存する', async () => {
        await expect(createProcessingDocument({ ...input, jobId: 'synthetic-job' })).resolves.toBe('synthetic-doc');
        expect(doubles.document).toMatchObject({ jobId: 'synthetic-job', status: 'processing' });
    });

    it('jobId をまだ採番していなければ未定義のフィールドを書かない', async () => {
        await createProcessingDocument(input);
        expect(doubles.document).not.toHaveProperty('jobId');
        expect(doubles.document).toMatchObject({ ownerId: 'synthetic-owner', status: 'processing' });
    });
});

describe('writeProcessingProgress', () => {
    const progress = { jobId: 'synthetic-job', stage: 'transcribing' as const, jobCreatedAtMs: 1_700_000_000_000, audioSec: 120.5 };

    beforeEach(() => {
        doubles.document = {
            ...doubles.document, jobId: 'synthetic-job', transcription: '合成の本文', updatedAt: 'UNCHANGED_TS',
        };
    });

    it.each(['checking', 'queued', 'transcribing', 'importing'] as const)('%s をサーバ時刻付きで投影し、本文と updatedAt を保持する', async (stage) => {
        await writeProcessingProgress('synthetic-doc', 'synthetic-owner', { ...progress, stage });
        expect(doubles.runTransaction).toHaveBeenCalledTimes(1);
        expect(doubles.set).toHaveBeenCalledExactlyOnceWith({
            processingProgress: {
                stage, stageObservedAt: 'SERVER_TS', jobCreatedAtMs: progress.jobCreatedAtMs, audioSec: progress.audioSec,
            },
        }, { merge: true });
        expect(doubles.document).toMatchObject({ transcription: '合成の本文', updatedAt: 'UNCHANGED_TS', status: 'processing' });
        expect(doubles.jobDoc).not.toHaveBeenCalled();
    });

    it.each([
        { name: '削除済み', patch: undefined },
        { name: '別 owner', patch: { ownerId: 'synthetic-other-owner' } },
        { name: 'owner 未設定', patch: { ownerId: undefined } },
        { name: '完了済み', patch: { status: 'completed' } },
        { name: '失敗済み', patch: { status: 'failed' } },
        { name: 'status 未設定', patch: { status: undefined } },
        { name: '別 jobId', patch: { jobId: 'synthetic-other-job' } },
        { name: '不正 jobId', patch: { jobId: null } },
    ])('$name の文書には投影を書かず復活させない', async ({ patch }) => {
        doubles.document = patch === undefined ? undefined : { ...doubles.document, ...patch };
        const original = doubles.document;
        await writeProcessingProgress('synthetic-doc', 'synthetic-owner', progress);
        expect(doubles.set).not.toHaveBeenCalled();
        expect(doubles.document).toEqual(original);
    });

    it('同じ段階の poll は何も書かず、段階の観測時刻と付随情報を据え置く', async () => {
        const previous = { stage: 'transcribing', stageObservedAt: 'PREVIOUS_TS', audioSec: 90 };
        doubles.document!.processingProgress = previous;
        await writeProcessingProgress('synthetic-doc', 'synthetic-owner', progress);
        expect(doubles.set).not.toHaveBeenCalled();
        expect(doubles.document!.processingProgress).toEqual(previous);
    });

    it('旧文書の jobId を同じ transaction で検証し、投影と原子的に補う', async () => {
        delete doubles.document!.jobId;
        await writeProcessingProgress('synthetic-doc', 'synthetic-owner', progress);
        expect(doubles.get).toHaveBeenCalledTimes(2);
        expect(doubles.jobDoc).toHaveBeenCalledWith('synthetic-job');
        expect(doubles.runTransaction).toHaveBeenCalledTimes(1);
        expect(doubles.set).toHaveBeenCalledExactlyOnceWith({
            jobId: 'synthetic-job',
            processingProgress: {
                stage: 'transcribing', stageObservedAt: 'SERVER_TS', jobCreatedAtMs: progress.jobCreatedAtMs, audioSec: progress.audioSec,
            },
        }, { merge: true });
    });

    it.each([
        { name: 'ジョブ未登録', job: undefined },
        { name: 'ジョブの owner 不一致', job: { ownerId: 'synthetic-other-owner', docId: 'synthetic-doc' } },
        { name: 'ジョブの docId 不一致', job: { ownerId: 'synthetic-owner', docId: 'synthetic-other-doc' } },
        { name: '不正な旧ジョブ', job: {} },
    ])('$name なら旧文書に jobId も投影も書かない', async ({ job }) => {
        delete doubles.document!.jobId;
        doubles.job = job;
        await writeProcessingProgress('synthetic-doc', 'synthetic-owner', progress);
        expect(doubles.set).not.toHaveBeenCalled();
        expect(doubles.document).not.toHaveProperty('jobId');
        expect(doubles.document).not.toHaveProperty('processingProgress');
    });

    it.each([undefined, NaN, Infinity, -Infinity, -1, 0])('旧データ・不正な付随値 %s を Firestore に書かない', async (value) => {
        await writeProcessingProgress('synthetic-doc', 'synthetic-owner', {
            ...progress, jobCreatedAtMs: value, audioSec: value,
        });
        expect(doubles.document!.processingProgress).toEqual({ stage: 'transcribing', stageObservedAt: 'SERVER_TS' });
    });
});

describe('文書単独の終端更新', () => {
    it('完成本文と status を保存する際に進捗投影を削除する', async () => {
        doubles.document!.processingProgress = { stage: 'importing', stageObservedAt: 'PREVIOUS_TS' };
        await completeTranscriptionDocument('synthetic-doc', '合成の完成本文', 'synthetic-model', 'synthetic-owner');
        expect(doubles.set).toHaveBeenCalledWith(expect.objectContaining({ processingProgress: 'DELETE_FIELD' }), { merge: true });
        expect(doubles.document).toMatchObject({ status: 'completed', transcription: '合成の完成本文' });
        expect(doubles.document).not.toHaveProperty('processingProgress');
    });

    it('失敗理由と status を保存する際に進捗投影を削除し、文書は残す', async () => {
        doubles.document!.processingProgress = { stage: 'checking', stageObservedAt: 'PREVIOUS_TS' };
        await failTranscriptionDocument('synthetic-doc', '合成の失敗理由', 'synthetic-owner');
        expect(doubles.set).toHaveBeenCalledWith(expect.objectContaining({ processingProgress: 'DELETE_FIELD' }), { merge: true });
        expect(doubles.document).toMatchObject({ status: 'failed', title: '合成の文書' });
        expect(doubles.document!.transcription).toContain('合成の失敗理由');
        expect(doubles.document).not.toHaveProperty('processingProgress');
    });
});
