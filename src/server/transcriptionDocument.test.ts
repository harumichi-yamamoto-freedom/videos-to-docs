import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
    document: undefined as Record<string, unknown> | undefined,
    get: vi.fn(),
    set: vi.fn(),
    doc: vi.fn(),
    runTransaction: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => 'SERVER_TS' } }));
vi.mock('./firebaseAdmin', () => ({
    getAdminFirestore: () => ({
        collection: () => ({ doc: doubles.doc }),
        runTransaction: doubles.runTransaction,
    }),
}));

import { attachJobToDocument, createProcessingDocument } from './transcriptionDocument';

beforeEach(() => {
    vi.clearAllMocks();
    doubles.document = { ownerId: 'synthetic-owner', title: '合成の文書', status: 'processing' };
    doubles.doc.mockReturnValue({ id: 'synthetic-doc', get: doubles.get, set: doubles.set });
    doubles.get.mockImplementation(async () => ({
        exists: doubles.document !== undefined,
        data: () => doubles.document,
    }));
    doubles.set.mockImplementation((data, options) => {
        doubles.document = options?.merge ? { ...doubles.document, ...data } : data;
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
