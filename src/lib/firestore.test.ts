import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const database = { name: 'mock-firestore' };
    const documentReference = { id: 'mock-document-reference' };
    const timestamp = { type: 'mock-server-timestamp' };
    const deleteFieldValue = { type: 'mock-delete-field' };
    const transactionGet = vi.fn();
    const transactionDelete = vi.fn();
    const transactionSet = vi.fn();
    const transactionUpdate = vi.fn();
    const transaction = {
        get: transactionGet,
        delete: transactionDelete,
        set: transactionSet,
        update: transactionUpdate,
    };

    return {
        database,
        deleteFieldValue,
        documentReference,
        timestamp,
        addDoc: vi.fn(),
        collection: vi.fn((...segments: unknown[]) => ({ type: 'collection', segments })),
        deleteField: vi.fn(() => deleteFieldValue),
        doc: vi.fn(() => documentReference),
        getDoc: vi.fn(),
        getDocs: vi.fn(),
        increment: vi.fn((operand: number) => ({ type: 'mock-increment', operand })),
        limit: vi.fn((count: number) => ({ type: 'limit', count })),
        orderBy: vi.fn((field: string, direction: string) => ({ type: 'orderBy', field, direction })),
        query: vi.fn((...constraints: unknown[]) => ({ type: 'query', constraints })),
        runTransaction: vi.fn(),
        serverTimestamp: vi.fn(() => timestamp),
        transaction,
        transactionDelete,
        transactionGet,
        transactionSet,
        transactionUpdate,
        updateDoc: vi.fn(),
        where: vi.fn((field: string, operator: string, value: unknown) => ({
            type: 'where',
            field,
            operator,
            value,
        })),
        getCurrentUserId: vi.fn(() => 'GUEST'),
        getOwnerType: vi.fn<() => 'guest' | 'user'>(() => 'guest'),
        logAudit: vi.fn(),
        updateUserStats: vi.fn(),
        validateDocumentSize: vi.fn(),
    };
});

vi.mock('firebase/firestore', () => ({
    Timestamp: class MockTimestamp {},
    addDoc: mocks.addDoc,
    collection: mocks.collection,
    deleteField: mocks.deleteField,
    doc: mocks.doc,
    getDoc: mocks.getDoc,
    getDocs: mocks.getDocs,
    increment: mocks.increment,
    limit: mocks.limit,
    orderBy: mocks.orderBy,
    query: mocks.query,
    runTransaction: mocks.runTransaction,
    serverTimestamp: mocks.serverTimestamp,
    updateDoc: mocks.updateDoc,
    where: mocks.where,
}));

vi.mock('./firebase', () => ({
    db: mocks.database,
}));

vi.mock('./auth', () => ({
    getCurrentUserId: mocks.getCurrentUserId,
    getOwnerType: mocks.getOwnerType,
}));

vi.mock('./auditLog', () => ({
    logAudit: mocks.logAudit,
}));

vi.mock('./adminSettings', () => ({
    validateDocumentSize: mocks.validateDocumentSize,
}));

vi.mock('./userManagement', () => ({
    updateUserStats: mocks.updateUserStats,
}));

vi.mock('./logger', () => ({
    createLogger: vi.fn(() => ({
        error: vi.fn(),
    })),
}));

import {
    deleteTranscription,
    getTranscriptionDocuments,
    getTranscriptions,
    getTranscriptionsByOwnerId,
    restoreTranscription,
    saveTranscription,
    updateTranscription,
    updateTranscriptionContent,
} from './firestore';

interface MockDocumentData {
    title: string;
    fileName: string;
    originalFileType: string;
    promptName: string;
    ownerType: 'guest' | 'user';
    ownerId: string;
    createdBy: string;
    transcription?: string | null;
    text?: string | null;
    generatedByModel?: string;
    generatedByThinkingLevel?: string;
    modelSelection?: 'default' | 'pinned';
    updatedAt?: Date;
}

const mappingCases: Array<{ id: string; data: MockDocumentData; expected: string }> = [
    {
        id: 'canonical-and-legacy',
        data: {
            title: 'canonical-and-legacy',
            fileName: 'canonical-and-legacy.txt',
            originalFileType: 'audio',
            promptName: 'テスト',
            ownerType: 'guest',
            ownerId: 'GUEST',
            createdBy: 'GUEST',
            transcription: 'transcription の本文',
            text: '古い text の本文',
            generatedByModel: 'gemini-3.7-flash',
            generatedByThinkingLevel: 'HIGH',
            modelSelection: 'default',
            updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        },
        expected: 'transcription の本文',
    },
    {
        id: 'legacy-only',
        data: {
            title: 'legacy-only',
            fileName: 'legacy-only.txt',
            originalFileType: 'audio',
            promptName: 'テスト',
            ownerType: 'guest',
            ownerId: 'GUEST',
            createdBy: 'GUEST',
            text: 'text の本文',
            generatedByModel: 'gemini-2.5-pro',
            generatedByThinkingLevel: 'unspecified',
            modelSelection: 'pinned',
        },
        expected: 'text の本文',
    },
    {
        id: 'canonical-null',
        data: {
            title: 'canonical-null',
            fileName: 'canonical-null.txt',
            originalFileType: 'audio',
            promptName: 'テスト',
            ownerType: 'guest',
            ownerId: 'GUEST',
            createdBy: 'GUEST',
            transcription: null,
            text: 'null からフォールバックした本文',
        },
        expected: 'null からフォールバックした本文',
    },
    {
        id: 'missing-content',
        data: {
            title: 'missing-content',
            fileName: 'missing-content.txt',
            originalFileType: 'audio',
            promptName: 'テスト',
            ownerType: 'guest',
            ownerId: 'GUEST',
            createdBy: 'GUEST',
        },
        expected: '',
    },
    {
        id: 'null-content',
        data: {
            title: 'null-content',
            fileName: 'null-content.txt',
            originalFileType: 'audio',
            promptName: 'テスト',
            ownerType: 'guest',
            ownerId: 'GUEST',
            createdBy: 'GUEST',
            transcription: null,
            text: null,
        },
        expected: '',
    },
    {
        id: 'canonical-empty-string',
        data: {
            title: 'canonical-empty-string',
            fileName: 'canonical-empty-string.txt',
            originalFileType: 'audio',
            promptName: 'テスト',
            ownerType: 'guest',
            ownerId: 'GUEST',
            createdBy: 'GUEST',
            transcription: '',
            text: 'フォールバックしてはいけない本文',
        },
        expected: '',
    },
];

function mockQuerySnapshot() {
    mocks.getDocs.mockResolvedValueOnce({
        forEach: (callback: (snapshot: { id: string; data: () => MockDocumentData }) => void) => {
            for (const row of mappingCases) {
                callback({
                    id: row.id,
                    data: () => row.data,
                });
            }
        },
    });
}

describe('firestore', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.addDoc.mockResolvedValue(mocks.documentReference);
        // once キューを持ち越すとテスト間で読取回数の差が別のテストへ漏れる。
        mocks.transactionGet.mockReset();
        mocks.transactionGet.mockResolvedValue({
            exists: () => true,
            data: () => ({ documentCount: 3 }),
        });
        mocks.getDoc.mockResolvedValue({ exists: () => false, data: () => ({}) });
        mocks.transactionDelete.mockReturnValue(undefined);
        mocks.transactionSet.mockReturnValue(undefined);
        mocks.transactionUpdate.mockReturnValue(undefined);
        mocks.runTransaction.mockImplementation(
            async (
                _database: unknown,
                updateFunction: (transaction: typeof mocks.transaction) => Promise<unknown>,
            ) => updateFunction(mocks.transaction),
        );
        mocks.updateDoc.mockResolvedValue(undefined);
        mocks.logAudit.mockResolvedValue(undefined);
        mocks.updateUserStats.mockResolvedValue(undefined);
        mocks.validateDocumentSize.mockResolvedValue({
            valid: true,
            size: 12,
            maxSize: 1024,
        });
        mocks.getCurrentUserId.mockReturnValue('GUEST');
        mocks.getOwnerType.mockReturnValue('guest');
    });

    describe('saveTranscription', () => {
        it('本文を transcription のみに保存し、legacy text は保存しない', async () => {
            const documentId = await saveTranscription(
                'recording.wav',
                '新規文書の本文',
                '議事録',
                'audio',
                '128kbps',
                44100,
                '新規文書',
                'audio/recording.wav',
                'gemini-3.7-flash',
                'default',
                'HIGH',
            );

            expect(documentId).toBe(mocks.documentReference.id);
            expect(mocks.validateDocumentSize).toHaveBeenCalledWith('新規文書の本文');
            expect(mocks.collection).toHaveBeenCalledWith(mocks.database, 'transcriptions');
            expect(mocks.addDoc).toHaveBeenCalledOnce();

            const payload = mocks.addDoc.mock.calls[0][1];
            expect(payload).toEqual({
                title: '新規文書',
                fileName: 'recording.wav',
                originalFileType: 'audio',
                transcription: '新規文書の本文',
                promptName: '議事録',
                bitrate: '128kbps',
                sampleRate: 44100,
                ownerType: 'guest',
                ownerId: 'GUEST',
                createdBy: 'GUEST',
                createdAt: mocks.timestamp,
                audioStoragePath: 'audio/recording.wav',
                generatedByModel: 'gemini-3.7-flash',
                generatedByThinkingLevel: 'HIGH',
                modelSelection: 'default',
            });
            expect(payload).not.toHaveProperty('text');
        });

        it('既存の10引数呼出しは modelSelection を保ち thinking level を保存しない', async () => {
            await saveTranscription(
                'recording.wav',
                '新規文書の本文',
                '議事録',
                'audio',
                undefined,
                undefined,
                undefined,
                undefined,
                'gemini-3.7-flash',
                'default',
            );

            const payload = mocks.addDoc.mock.calls[0][1];
            expect(payload).not.toHaveProperty('generatedByThinkingLevel');
            expect(payload).toMatchObject({
                generatedByModel: 'gemini-3.7-flash',
                modelSelection: 'default',
            });
        });

        it('期待する所有者と実際の書き込み先が違えば保存しない', async () => {
            mocks.getCurrentUserId.mockReturnValue('user-2');

            const rejection = await saveTranscription(
                'recording.wav',
                '新規文書の本文',
                '議事録',
                'audio',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                'user-1',
            ).catch((error: unknown) => error as Error);

            expect(rejection).toBeInstanceOf(Error);
            expect((rejection as Error).message).toContain('ログイン状態が処理の開始時から変わった');
            // U5: 画面に出る文言に生のUIDを載せない
            expect((rejection as Error).message).not.toContain('user-1');
            expect((rejection as Error).message).not.toContain('user-2');
            // 突き合わせに要る値はログにだけ残す
            expect(mocks.addDoc).not.toHaveBeenCalled();
            expect(mocks.updateUserStats).not.toHaveBeenCalled();
        });

        it('期待する所有者と一致すればそのUIDで保存する', async () => {
            mocks.getCurrentUserId.mockReturnValue('user-1');

            await saveTranscription(
                'recording.wav',
                '新規文書の本文',
                '議事録',
                'audio',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                'user-1',
            );

            expect(mocks.addDoc).toHaveBeenCalledOnce();
            expect(mocks.addDoc.mock.calls[0][1]).toMatchObject({
                ownerId: 'user-1',
                createdBy: 'user-1',
            });
        });
    });

    describe('updateTranscriptionContent', () => {
        it('本文を transcription に書き込み、同じペイロードで legacy text を削除する', async () => {
            await updateTranscriptionContent('document-id', '更新後の本文');

            expect(mocks.doc).toHaveBeenCalledWith(
                mocks.database,
                'transcriptions',
                'document-id',
            );
            expect(mocks.deleteField).toHaveBeenCalledOnce();
            expect(mocks.serverTimestamp).toHaveBeenCalledOnce();
            expect(mocks.updateDoc).toHaveBeenCalledOnce();

            const payload = mocks.updateDoc.mock.calls[0][1];
            expect(payload).toEqual({
                transcription: '更新後の本文',
                text: mocks.deleteFieldValue,
                updatedAt: mocks.timestamp,
            });
        });
    });

    describe('updateTranscription', () => {
        it('タイトルと本文を単一の原子更新へまとめる', async () => {
            await updateTranscription('document-id', {
                title: '更新後のタイトル',
                transcription: '更新後の本文',
            });

            expect(mocks.doc).toHaveBeenCalledWith(
                mocks.database,
                'transcriptions',
                'document-id',
            );
            expect(mocks.updateDoc).toHaveBeenCalledOnce();
            expect(mocks.updateDoc).toHaveBeenCalledWith(mocks.documentReference, {
                title: '更新後のタイトル',
                transcription: '更新後の本文',
                text: mocks.deleteFieldValue,
                updatedAt: mocks.timestamp,
            });
            expect(mocks.logAudit).toHaveBeenCalledWith(
                'document_update',
                'document',
                'document-id',
                { title: '更新後のタイトル', content: 'updated' },
            );
        });

        it('Firestore更新に失敗した場合は監査ログを記録せず失敗を返す', async () => {
            mocks.updateDoc.mockRejectedValueOnce(new Error('update failed'));

            await expect(updateTranscription('document-id', { title: '更新後' }))
                .rejects.toThrow('文書の更新に失敗しました');

            expect(mocks.logAudit).not.toHaveBeenCalled();
        });

        it('原子更新後の監査ログ失敗を保存失敗として扱わない', async () => {
            mocks.logAudit.mockRejectedValueOnce(new Error('audit failed'));

            await expect(updateTranscription('document-id', { title: '更新後' }))
                .resolves.toBeUndefined();

            expect(mocks.updateDoc).toHaveBeenCalledOnce();
        });

        it('空のpatchを拒否する', async () => {
            await expect(updateTranscription('document-id', {}))
                .rejects.toThrow('更新内容が指定されていません');

            expect(mocks.updateDoc).not.toHaveBeenCalled();
        });
    });

    describe('restoreTranscription', () => {
        const sourceDocument = {
            id: 'document-id',
            title: '退避中のタイトル',
            fileName: 'recording.wav',
            text: '退避中の本文',
            promptName: '議事録',
            originalFileType: 'audio',
            generatedByModel: 'gemini-3.7-flash',
            generatedByThinkingLevel: 'HIGH',
            modelSelection: 'default' as const,
            ownerType: 'user' as const,
            ownerId: 'user-id',
            createdBy: 'user-id',
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
        };

        it('消えた文書を同じIDへ復元し、ユーザー件数を原子加算する', async () => {
            mocks.getCurrentUserId.mockReturnValue('user-id');
            mocks.getOwnerType.mockReturnValue('user');
            mocks.transactionGet
                .mockResolvedValueOnce({
                    exists: () => false,
                    data: () => ({}),
                })
                .mockResolvedValueOnce({
                    exists: () => true,
                    data: () => ({ documentCount: 4 }),
                });

            await restoreTranscription('document-id', sourceDocument, {
                title: '保存後のタイトル',
                transcription: '保存後の本文',
            });

            expect(mocks.validateDocumentSize).toHaveBeenCalledWith('保存後の本文');
            expect(mocks.runTransaction).toHaveBeenCalledWith(
                mocks.database,
                expect.any(Function),
            );
            expect(mocks.transactionGet).toHaveBeenCalledTimes(2);
            expect(mocks.transactionSet).toHaveBeenCalledWith(
                mocks.documentReference,
                {
                    title: '保存後のタイトル',
                    fileName: 'recording.wav',
                    originalFileType: 'audio',
                    transcription: '保存後の本文',
                    promptName: '議事録',
                    ownerType: 'user',
                    ownerId: 'user-id',
                    createdBy: 'user-id',
                    createdAt: sourceDocument.createdAt,
                    updatedAt: mocks.timestamp,
                    generatedByModel: 'gemini-3.7-flash',
                    generatedByThinkingLevel: 'HIGH',
                    modelSelection: 'default',
                },
                { merge: true },
            );
            expect(mocks.increment).toHaveBeenCalledWith(1);
            expect(mocks.transactionUpdate).toHaveBeenCalledWith(
                mocks.documentReference,
                { documentCount: { type: 'mock-increment', operand: 1 } },
            );
            expect(mocks.logAudit).toHaveBeenCalledWith(
                'document_update',
                'document',
                'document-id',
                { title: '保存後のタイトル', content: 'restored' },
            );
        });

        it('再作成では音声メタデータを引き継ぎStorage参照を失わない', async () => {
            mocks.getCurrentUserId.mockReturnValue('user-id');
            mocks.getOwnerType.mockReturnValue('user');
            mocks.transactionGet
                .mockResolvedValueOnce({
                    exists: () => false,
                    data: () => ({}),
                })
                .mockResolvedValueOnce({
                    exists: () => true,
                    data: () => ({ documentCount: 4 }),
                });

            await restoreTranscription('document-id', {
                ...sourceDocument,
                bitrate: '128kbps',
                sampleRate: 44100,
                audioStoragePath: 'audio/recording.wav',
            }, { transcription: '保存後の本文' });

            expect(mocks.transactionSet).toHaveBeenCalledWith(
                mocks.documentReference,
                expect.objectContaining({
                    bitrate: '128kbps',
                    sampleRate: 44100,
                    audioStoragePath: 'audio/recording.wav',
                }),
                { merge: true },
            );
        });

        it('音声メタデータを持たない文書の再作成では該当キーを書かない', async () => {
            mocks.getCurrentUserId.mockReturnValue('user-id');
            mocks.getOwnerType.mockReturnValue('user');
            mocks.transactionGet
                .mockResolvedValueOnce({
                    exists: () => false,
                    data: () => ({}),
                })
                .mockResolvedValueOnce({
                    exists: () => true,
                    data: () => ({ documentCount: 4 }),
                });

            await restoreTranscription('document-id', sourceDocument, {
                transcription: '保存後の本文',
            });

            const payload = mocks.transactionSet.mock.calls[0][1] as Record<string, unknown>;
            expect(payload).not.toHaveProperty('bitrate');
            expect(payload).not.toHaveProperty('sampleRate');
            expect(payload).not.toHaveProperty('audioStoragePath');
        });

        it('文書が存在していた場合は本文項目だけを更新し、既存metadataと件数を変更しない', async () => {
            mocks.getCurrentUserId.mockReturnValue('user-id');
            mocks.getOwnerType.mockReturnValue('user');
            mocks.transactionGet.mockResolvedValueOnce({
                exists: () => true,
                data: () => ({
                    ownerType: 'user',
                    ownerId: 'user-id',
                    fileName: 'server-side.wav',
                    originalFileType: 'video',
                    promptName: 'サーバー側プロンプト',
                    createdBy: 'original-creator',
                    createdAt: new Date('2025-01-01T00:00:00.000Z'),
                    generatedByModel: 'server-side-model',
                }),
            });

            await restoreTranscription('document-id', sourceDocument, {
                transcription: '保存後の本文',
            });

            expect(mocks.transactionGet).toHaveBeenCalledOnce();
            expect(mocks.transactionSet).not.toHaveBeenCalled();
            expect(mocks.transactionUpdate).toHaveBeenCalledOnce();
            expect(mocks.transactionUpdate).toHaveBeenCalledWith(
                mocks.documentReference,
                {
                    title: '退避中のタイトル',
                    transcription: '保存後の本文',
                    text: mocks.deleteFieldValue,
                    updatedAt: mocks.timestamp,
                },
            );
            expect(mocks.increment).not.toHaveBeenCalled();
        });

        it.each([
            {
                description: '別ユーザー所有',
                existingData: { ownerType: 'user', ownerId: 'other-user' },
            },
            {
                description: '所有者未設定のlegacy文書',
                existingData: {},
            },
        ])('$descriptionを現在のユーザーとして上書きしない', async ({ existingData }) => {
            mocks.getCurrentUserId.mockReturnValue('user-id');
            mocks.getOwnerType.mockReturnValue('user');
            mocks.transactionGet.mockResolvedValueOnce({
                exists: () => true,
                data: () => existingData,
            });

            await expect(restoreTranscription('document-id', sourceDocument, {
                transcription: '保存後の本文',
            })).rejects.toThrow('文書の復元に失敗しました');

            expect(mocks.transactionGet).toHaveBeenCalledOnce();
            expect(mocks.transactionSet).not.toHaveBeenCalled();
            expect(mocks.transactionUpdate).not.toHaveBeenCalled();
            expect(mocks.increment).not.toHaveBeenCalled();
            expect(mocks.logAudit).not.toHaveBeenCalled();
        });

        it('現在の認証主体と所有者が違う退避文書は復元しない', async () => {
            mocks.getCurrentUserId.mockReturnValue('other-user');
            mocks.getOwnerType.mockReturnValue('user');

            await expect(restoreTranscription('document-id', sourceDocument, {
                transcription: '保存後の本文',
            })).rejects.toThrow('所有者が変わった文書は復元できません');

            expect(mocks.validateDocumentSize).not.toHaveBeenCalled();
            expect(mocks.runTransaction).not.toHaveBeenCalled();
            expect(mocks.transactionSet).not.toHaveBeenCalled();
        });

        it('復元トランザクション失敗時は成功扱いにしない', async () => {
            mocks.getCurrentUserId.mockReturnValue('user-id');
            mocks.getOwnerType.mockReturnValue('user');
            mocks.runTransaction.mockRejectedValueOnce(new Error('restore failed'));

            await expect(restoreTranscription('document-id', sourceDocument, {
                transcription: '保存後の本文',
            })).rejects.toThrow('文書の復元に失敗しました');

            expect(mocks.logAudit).not.toHaveBeenCalled();
        });
    });

    describe('deleteTranscription', () => {
        const ownedByUser = (ownerId: string) => ({
            exists: () => true,
            data: () => ({ ownerType: 'user', ownerId }),
        });

        it('存在確認、本体削除、件数減算を同じトランザクションで行う', async () => {
            mocks.getCurrentUserId.mockReturnValue('user-id');
            mocks.getOwnerType.mockReturnValue('user');
            mocks.transactionGet
                .mockResolvedValueOnce(ownedByUser('user-id'))
                .mockResolvedValueOnce({
                    exists: () => true,
                    data: () => ({ documentCount: 3 }),
                });

            await expect(deleteTranscription('document-id')).resolves.toBe('deleted');

            expect(mocks.doc).toHaveBeenNthCalledWith(
                1,
                mocks.database,
                'transcriptions',
                'document-id',
            );
            expect(mocks.doc).toHaveBeenNthCalledWith(
                2,
                mocks.database,
                'users',
                'user-id',
            );
            expect(mocks.runTransaction).toHaveBeenCalledWith(
                mocks.database,
                expect.any(Function),
            );
            expect(mocks.transactionGet).toHaveBeenCalledTimes(2);
            expect(mocks.transactionGet).toHaveBeenNthCalledWith(1, mocks.documentReference);
            expect(mocks.transactionGet).toHaveBeenNthCalledWith(2, mocks.documentReference);
            expect(mocks.transactionDelete).toHaveBeenCalledWith(mocks.documentReference);
            expect(mocks.increment).toHaveBeenCalledWith(-1);
            expect(mocks.transactionUpdate).toHaveBeenCalledWith(
                mocks.documentReference,
                { documentCount: { type: 'mock-increment', operand: -1 } },
            );
            expect(mocks.transactionGet.mock.invocationCallOrder[1])
                .toBeLessThan(mocks.transactionDelete.mock.invocationCallOrder[0]);
            expect(mocks.transactionDelete.mock.invocationCallOrder[0])
                .toBeLessThan(mocks.transactionUpdate.mock.invocationCallOrder[0]);
            expect(mocks.collection).toHaveBeenCalledWith(mocks.database, 'auditLogs');
            expect(mocks.addDoc).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'collection' }),
                expect.objectContaining({
                    userId: 'user-id',
                    action: 'document_delete',
                    resourceType: 'document',
                    resourceId: 'document-id',
                    timestamp: mocks.timestamp,
                }),
            );
        });

        it.each([0, -1, 0.5, Number.NaN, undefined])(
            'documentCount=%s の場合は0未満へ減算しない',
            async documentCount => {
                mocks.getCurrentUserId.mockReturnValue('user-id');
                mocks.getOwnerType.mockReturnValue('user');
                mocks.transactionGet
                    .mockResolvedValueOnce(ownedByUser('user-id'))
                    .mockResolvedValueOnce({
                        exists: () => true,
                        data: () => ({ documentCount }),
                    });

                await expect(deleteTranscription('document-id')).resolves.toBe('deleted');

                expect(mocks.transactionDelete).toHaveBeenCalledOnce();
                expect(mocks.increment).not.toHaveBeenCalled();
                expect(mocks.transactionUpdate).not.toHaveBeenCalled();
            },
        );

        it('同時削除は同じ読取値から開始しても原子incrementで両方の減算を保持する', async () => {
            mocks.getCurrentUserId.mockReturnValue('user-id');
            mocks.getOwnerType.mockReturnValue('user');

            let documentCount = 2;
            let readCount = 0;
            let releaseReads!: () => void;
            const bothTransactionsRead = new Promise<void>(resolve => {
                releaseReads = resolve;
            });

            mocks.runTransaction.mockImplementation(
                async (
                    _database: unknown,
                    updateFunction: (transaction: {
                        get: (reference: unknown) => Promise<{
                            exists: () => boolean;
                            data: () => { documentCount: number };
                        }>;
                        delete: (reference: unknown) => void;
                        update: (
                            reference: unknown,
                            payload: { documentCount: { operand: number } },
                        ) => void;
                    }) => Promise<unknown>,
                ) => {
                    const pendingIncrements: number[] = [];
                    let transactionReadCount = 0;
                    const transaction = {
                        get: async (_reference: unknown) => {
                            transactionReadCount += 1;
                            if (transactionReadCount === 1) {
                                return {
                                    exists: () => true,
                                    data: () => ({
                                        ownerType: 'user',
                                        ownerId: 'user-id',
                                        documentCount,
                                    }),
                                };
                            }

                            const countAtRead = documentCount;
                            readCount += 1;
                            if (readCount === 2) releaseReads();
                            await bothTransactionsRead;
                            return {
                                exists: () => true,
                                data: () => ({ documentCount: countAtRead }),
                            };
                        },
                        delete: (reference: unknown) => {
                            mocks.transactionDelete(reference);
                        },
                        update: (
                            _reference: unknown,
                            payload: { documentCount: { operand: number } },
                        ) => {
                            pendingIncrements.push(payload.documentCount.operand);
                        },
                    };

                    const result = await updateFunction(transaction);
                    for (const operand of pendingIncrements) {
                        documentCount += operand;
                    }
                    return result;
                },
            );

            await expect(Promise.all([
                deleteTranscription('document-a'),
                deleteTranscription('document-b'),
            ])).resolves.toEqual(['deleted', 'deleted']);

            expect(readCount).toBe(2);
            expect(mocks.increment).toHaveBeenCalledTimes(2);
            expect(mocks.increment).toHaveBeenNthCalledWith(1, -1);
            expect(mocks.increment).toHaveBeenNthCalledWith(2, -1);
            expect(mocks.transactionDelete).toHaveBeenCalledTimes(2);
            expect(documentCount).toBe(0);
        });

        it('同一IDの削除を再実行しても本体削除、監査、件数減算を重複しない', async () => {
            mocks.getCurrentUserId.mockReturnValue('user-id');
            mocks.getOwnerType.mockReturnValue('user');

            let documentExists = true;
            let documentCount = 2;
            mocks.runTransaction.mockImplementation(
                async (
                    _database: unknown,
                    updateFunction: (transaction: {
                        get: (reference: unknown) => Promise<{
                            exists: () => boolean;
                            data: () => {
                                documentCount?: number;
                                ownerType?: string;
                                ownerId?: string;
                            };
                        }>;
                        delete: (reference: unknown) => void;
                        update: (
                            reference: unknown,
                            payload: { documentCount: { operand: number } },
                        ) => void;
                    }) => Promise<unknown>,
                ) => {
                    let transactionReadCount = 0;
                    let pendingDelete = false;
                    const pendingIncrements: number[] = [];
                    const transaction = {
                        get: async (_reference: unknown) => {
                            transactionReadCount += 1;
                            if (transactionReadCount === 1) {
                                return {
                                    exists: () => documentExists,
                                    data: () => ({
                                        ownerType: 'user',
                                        ownerId: 'user-id',
                                    }),
                                };
                            }

                            return {
                                exists: () => true,
                                data: () => ({ documentCount }),
                            };
                        },
                        delete: (reference: unknown) => {
                            pendingDelete = true;
                            mocks.transactionDelete(reference);
                        },
                        update: (
                            _reference: unknown,
                            payload: { documentCount: { operand: number } },
                        ) => {
                            pendingIncrements.push(payload.documentCount.operand);
                        },
                    };

                    const result = await updateFunction(transaction);
                    if (pendingDelete) {
                        documentExists = false;
                        for (const operand of pendingIncrements) {
                            documentCount += operand;
                        }
                    }
                    return result;
                },
            );

            await expect(deleteTranscription('same-document-id')).resolves.toBe('deleted');
            await expect(deleteTranscription('same-document-id')).resolves.toBe('deleted');

            expect(mocks.runTransaction).toHaveBeenCalledTimes(2);
            expect(mocks.transactionDelete).toHaveBeenCalledOnce();
            expect(mocks.increment).toHaveBeenCalledOnce();
            expect(mocks.increment).toHaveBeenCalledWith(-1);
            expect(mocks.addDoc).toHaveBeenCalledOnce();
            expect(documentCount).toBe(1);
        });

        it('件数は削除した人ではなく削除される文書の所有者から引く', async () => {
            mocks.getCurrentUserId.mockReturnValue('deleting-admin');
            mocks.getOwnerType.mockReturnValue('user');
            mocks.transactionGet
                .mockResolvedValueOnce(ownedByUser('document-owner'))
                .mockResolvedValueOnce({
                    exists: () => true,
                    data: () => ({ documentCount: 5 }),
                });

            await expect(deleteTranscription('document-id')).resolves.toBe('deleted');

            expect(mocks.doc).toHaveBeenNthCalledWith(
                2,
                mocks.database,
                'users',
                'document-owner',
            );
            expect(mocks.doc).not.toHaveBeenCalledWith(
                mocks.database,
                'users',
                'deleting-admin',
            );
            expect(mocks.increment).toHaveBeenCalledWith(-1);
            expect(mocks.transactionUpdate).toHaveBeenCalledOnce();
            // 監査ログだけは「誰が消したか」なので現在の認証主体で残す。
            expect(mocks.addDoc).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'collection' }),
                expect.objectContaining({ userId: 'deleting-admin' }),
            );
        });

        it('ゲスト所有の文書ではusersカウンタを読まず書かない', async () => {
            mocks.getCurrentUserId.mockReturnValue('user-id');
            mocks.getOwnerType.mockReturnValue('user');
            mocks.transactionGet.mockResolvedValueOnce({
                exists: () => true,
                data: () => ({ ownerType: 'guest', ownerId: 'GUEST' }),
            });

            await expect(deleteTranscription('document-id')).resolves.toBe('deleted');

            expect(mocks.transactionGet).toHaveBeenCalledOnce();
            expect(mocks.doc).toHaveBeenCalledOnce();
            expect(mocks.doc).toHaveBeenCalledWith(
                mocks.database,
                'transcriptions',
                'document-id',
            );
            expect(mocks.transactionDelete).toHaveBeenCalledOnce();
            expect(mocks.increment).not.toHaveBeenCalled();
            expect(mocks.transactionUpdate).not.toHaveBeenCalled();
        });

        it('本体削除後に監査ログが失敗した場合はdeletedWithWarningを返す', async () => {
            mocks.addDoc.mockRejectedValueOnce(new Error('audit failed'));

            await expect(deleteTranscription('document-id'))
                .resolves.toBe('deletedWithWarning');

            expect(mocks.transactionDelete).toHaveBeenCalledOnce();
        });

        it('削除トランザクションが失敗した場合は監査を開始せず削除失敗を返す', async () => {
            mocks.getCurrentUserId.mockReturnValue('user-id');
            mocks.getOwnerType.mockReturnValue('user');
            mocks.runTransaction.mockRejectedValueOnce(new Error('transaction failed'));

            await expect(deleteTranscription('document-id'))
                .rejects.toThrow('文書の削除に失敗しました');

            expect(mocks.addDoc).not.toHaveBeenCalled();
            expect(mocks.runTransaction).toHaveBeenCalledOnce();
            expect(mocks.transactionDelete).not.toHaveBeenCalled();
        });

        it('存在確認に失敗した場合は本体削除と監査を開始しない', async () => {
            mocks.getCurrentUserId.mockReturnValue('user-id');
            mocks.getOwnerType.mockReturnValue('user');
            mocks.transactionGet.mockRejectedValueOnce(new Error('read failed'));

            await expect(deleteTranscription('document-id'))
                .rejects.toThrow('文書の削除に失敗しました');

            expect(mocks.addDoc).not.toHaveBeenCalled();
            expect(mocks.runTransaction).toHaveBeenCalledOnce();
            expect(mocks.transactionGet).toHaveBeenCalledOnce();
            expect(mocks.transactionDelete).not.toHaveBeenCalled();
            expect(mocks.transactionUpdate).not.toHaveBeenCalled();
        });
    });

    describe('本文サイズの上限', () => {
        const overLimit = { valid: false, size: 4096, maxSize: 1024 };
        const savedSource = {
            id: 'document-id',
            title: '退避中のタイトル',
            fileName: 'recording.wav',
            text: '退避中の本文',
            promptName: '議事録',
            originalFileType: 'audio',
            ownerType: 'user' as const,
            ownerId: 'user-id',
            createdBy: 'user-id',
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
        };

        beforeEach(() => {
            mocks.getCurrentUserId.mockReturnValue('user-id');
            mocks.getOwnerType.mockReturnValue('user');
        });

        it('保存済みより大きい上限超過の本文は、updateでもrestoreでも同じく拒否する', async () => {
            mocks.validateDocumentSize.mockResolvedValue(overLimit);
            mocks.getDoc.mockResolvedValue({
                exists: () => true,
                data: () => ({ transcription: '短い保存済み本文' }),
            });

            await expect(updateTranscription('document-id', {
                transcription: '上限を超える本文',
            })).rejects.toThrow('文書のサイズが上限を超えています');
            await expect(restoreTranscription('document-id', savedSource, {
                transcription: '上限を超える本文',
            })).rejects.toThrow('文書のサイズが上限を超えています');

            expect(mocks.updateDoc).not.toHaveBeenCalled();
            expect(mocks.runTransaction).not.toHaveBeenCalled();
        });

        it('上限を超えていても保存済み本文より縮む更新は受理する', async () => {
            mocks.validateDocumentSize.mockResolvedValue(overLimit);
            mocks.getDoc.mockResolvedValue({
                exists: () => true,
                data: () => ({ transcription: 'x'.repeat(9000) }),
            });

            await expect(updateTranscription('document-id', {
                transcription: '削って縮めた本文',
            })).resolves.toBeUndefined();

            expect(mocks.updateDoc).toHaveBeenCalledOnce();
        });

        it('保存済み本文を読めない場合は上限超過を拒否する', async () => {
            mocks.validateDocumentSize.mockResolvedValue(overLimit);
            mocks.getDoc.mockRejectedValue(new Error('read failed'));

            await expect(updateTranscription('document-id', {
                transcription: '上限を超える本文',
            })).rejects.toThrow('文書のサイズが上限を超えています');

            expect(mocks.updateDoc).not.toHaveBeenCalled();
        });

        it('上限内の更新では保存済み本文を読みに行かない', async () => {
            await updateTranscription('document-id', { transcription: '普通の本文' });

            expect(mocks.validateDocumentSize).toHaveBeenCalledWith('普通の本文');
            expect(mocks.getDoc).not.toHaveBeenCalled();
            expect(mocks.updateDoc).toHaveBeenCalledOnce();
        });

        it('タイトルだけの更新では本文サイズを検証しない', async () => {
            await updateTranscription('document-id', { title: '新しいタイトル' });

            expect(mocks.validateDocumentSize).not.toHaveBeenCalled();
            expect(mocks.updateDoc).toHaveBeenCalledOnce();
        });
    });

    describe('本文の読出マッピング', () => {
        it('詳細形式で transcription を優先し、text と空文字へフォールバックする', async () => {
            mockQuerySnapshot();

            const documents = await getTranscriptionDocuments();

            expect(documents.map(document => document.transcription)).toEqual(
                mappingCases.map(row => row.expected),
            );
            expect(documents.map(document => document.updatedAt)).toEqual(
                mappingCases.map(row => row.data.updatedAt),
            );
            expect(documents.map(document => ({
                generatedByModel: document.generatedByModel,
                generatedByThinkingLevel: document.generatedByThinkingLevel,
                modelSelection: document.modelSelection,
            }))).toEqual(mappingCases.map(row => ({
                generatedByModel: row.data.generatedByModel,
                generatedByThinkingLevel: row.data.generatedByThinkingLevel,
                modelSelection: row.data.modelSelection,
            })));
        });

        it('簡略形式で transcription を優先し、text と空文字へフォールバックする', async () => {
            mockQuerySnapshot();

            const documents = await getTranscriptions();

            expect(documents.map(document => document.text)).toEqual(
                mappingCases.map(row => row.expected),
            );
            expect(documents.map(document => document.updatedAt)).toEqual(
                mappingCases.map(row => row.data.updatedAt),
            );
            expect(documents.map(document => ({
                generatedByModel: document.generatedByModel,
                generatedByThinkingLevel: document.generatedByThinkingLevel,
                modelSelection: document.modelSelection,
            }))).toEqual(mappingCases.map(row => ({
                generatedByModel: row.data.generatedByModel,
                generatedByThinkingLevel: row.data.generatedByThinkingLevel,
                modelSelection: row.data.modelSelection,
            })));
        });

        it('一覧の読出しで音声メタデータを落とさない', async () => {
            const audioDocument = {
                ...mappingCases[0].data,
                bitrate: '128kbps',
                sampleRate: 44100,
                audioStoragePath: 'audio/recording.wav',
            };
            mocks.getDocs.mockResolvedValueOnce({
                forEach: (callback: (snapshot: { id: string; data: () => MockDocumentData }) => void) => {
                    callback({ id: 'audio-document', data: () => audioDocument });
                },
            });

            const documents = await getTranscriptions();

            expect(documents[0]).toMatchObject({
                bitrate: '128kbps',
                sampleRate: 44100,
                audioStoragePath: 'audio/recording.wav',
            });
        });

        it('明示した所有主体へクエリを固定し、現在の認証主体を再読込しない', async () => {
            const scopedDocument = {
                ...mappingCases[0].data,
                ownerType: 'user' as const,
                ownerId: 'user-a',
            };
            mocks.getCurrentUserId.mockReturnValue('user-b');
            mocks.getOwnerType.mockReturnValue('user');
            mocks.getDocs.mockResolvedValueOnce({
                forEach: (callback: (snapshot: { id: string; data: () => MockDocumentData }) => void) => {
                    callback({ id: 'scoped-document', data: () => scopedDocument });
                },
            });

            const documents = await getTranscriptions(25, {
                ownerId: 'user-a',
                ownerType: 'user',
            });

            expect(mocks.where).toHaveBeenCalledWith('ownerId', '==', 'user-a');
            expect(mocks.limit).toHaveBeenCalledWith(25);
            expect(mocks.getCurrentUserId).not.toHaveBeenCalled();
            expect(mocks.getOwnerType).not.toHaveBeenCalled();
            expect(documents).toHaveLength(1);
            expect(documents[0]).toMatchObject({ id: 'scoped-document', text: mappingCases[0].expected });
        });

        it('所有者指定形式で transcription を優先し、text と空文字へフォールバックする', async () => {
            mockQuerySnapshot();

            const documents = await getTranscriptionsByOwnerId('owner-id');

            expect(documents.map(document => document.text)).toEqual(
                mappingCases.map(row => row.expected),
            );
            expect(documents.map(document => document.updatedAt)).toEqual(
                mappingCases.map(row => row.data.updatedAt),
            );
            expect(documents.map(document => ({
                generatedByModel: document.generatedByModel,
                generatedByThinkingLevel: document.generatedByThinkingLevel,
                modelSelection: document.modelSelection,
            }))).toEqual(mappingCases.map(row => ({
                generatedByModel: row.data.generatedByModel,
                generatedByThinkingLevel: row.data.generatedByThinkingLevel,
                modelSelection: row.data.modelSelection,
            })));
        });
    });
});
