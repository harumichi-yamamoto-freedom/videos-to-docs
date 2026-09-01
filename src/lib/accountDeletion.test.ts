import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockDocumentSnapshot {
    id: string;
    ref: { path: string };
}

function createSnapshotWithIds(ids: readonly string[], collectionName: string) {
    const docs: MockDocumentSnapshot[] = ids.map(id => ({
        id,
        ref: { path: `${collectionName}/${id}` },
    }));
    return {
        size: docs.length,
        docs,
        forEach: (callback: (documentSnapshot: MockDocumentSnapshot) => void) => {
            docs.forEach(callback);
        },
    };
}

function createSnapshot(count: number, collectionName: string) {
    return createSnapshotWithIds(
        Array.from({ length: count }, (_, index) => `${collectionName}-${index}`),
        collectionName,
    );
}

const mocks = vi.hoisted(() => {
    const database = { name: 'mock-firestore' };
    const batches: Array<{
        commit: ReturnType<typeof vi.fn>;
        delete: ReturnType<typeof vi.fn>;
    }> = [];
    const control: { commitFailureAt: number | null } = { commitFailureAt: null };

    return {
        database,
        batches,
        control,
        collection: vi.fn((...segments: unknown[]) => ({ type: 'collection', segments })),
        doc: vi.fn((...segments: unknown[]) => ({
            type: 'document',
            segments,
            path: segments.slice(1).join('/'),
        })),
        getDocs: vi.fn(),
        query: vi.fn((...constraints: unknown[]) => ({ type: 'query', constraints })),
        where: vi.fn((field: string, operator: string, value: unknown) => ({
            type: 'where',
            field,
            operator,
            value,
        })),
        writeBatch: vi.fn(() => {
            const batchIndex = batches.length;
            const batch = {
                delete: vi.fn(),
                commit: vi.fn(() => batchIndex === control.commitFailureAt
                    ? Promise.reject(new Error(`commit ${batchIndex + 1} failed`))
                    : Promise.resolve()),
            };
            batches.push(batch);
            return batch;
        }),
        logAudit: vi.fn(),
        loggerError: vi.fn(),
    };
});

vi.mock('firebase/firestore', () => ({
    collection: mocks.collection,
    doc: mocks.doc,
    getDocs: mocks.getDocs,
    query: mocks.query,
    where: mocks.where,
    writeBatch: mocks.writeBatch,
}));

vi.mock('./firebase', () => ({
    db: mocks.database,
}));

vi.mock('./auditLog', () => ({
    logAudit: mocks.logAudit,
}));

vi.mock('./logger', () => ({
    createLogger: vi.fn(() => ({
        error: mocks.loggerError,
        info: vi.fn(),
    })),
}));

import {
    deleteUserData,
    getUserDeletionInfo,
    UserDeletionInfoChangedError,
} from './accountDeletion';

describe('deleteUserData', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getDocs.mockReset();
        mocks.logAudit.mockReset().mockResolvedValue(undefined);
        mocks.batches.length = 0;
        mocks.control.commitFailureAt = null;
    });

    it('削除直前の同じ走査結果を400件ずつの複数batchで削除する', async () => {
        const promptsSnapshot = createSnapshot(801, 'prompts');
        mocks.getDocs
            .mockResolvedValueOnce(promptsSnapshot)
            .mockResolvedValueOnce(createSnapshot(0, 'transcriptions'))
            .mockResolvedValueOnce(createSnapshot(0, 'supervisor-relationships'))
            .mockResolvedValueOnce(createSnapshot(0, 'subordinate-relationships'));

        await deleteUserData('user-1', 'user@example.com', {
            promptCount: 801,
            documentCount: 0,
        });

        expect(mocks.writeBatch).toHaveBeenCalledTimes(3);
        expect(mocks.batches.map(batch => batch.delete.mock.calls.length)).toEqual([400, 400, 2]);
        expect(mocks.batches.every(batch => batch.commit.mock.calls.length === 1)).toBe(true);
        expect(mocks.batches[0].delete).toHaveBeenCalledWith(promptsSnapshot.docs[0].ref);
        expect(mocks.logAudit).toHaveBeenCalledOnce();
    });

    it('確認時から件数が変わった場合は監査記録も削除も始めず最新件数を報告する', async () => {
        mocks.getDocs
            .mockResolvedValueOnce(createSnapshot(2, 'prompts'))
            .mockResolvedValueOnce(createSnapshot(1, 'transcriptions'))
            .mockResolvedValueOnce(createSnapshot(0, 'supervisor-relationships'))
            .mockResolvedValueOnce(createSnapshot(0, 'subordinate-relationships'));

        const deletion = deleteUserData('user-1', 'user@example.com', {
            promptCount: 1,
            documentCount: 1,
        });

        await expect(deletion).rejects.toMatchObject({
            name: 'UserDeletionInfoChangedError',
            failedStage: 'verification',
            expectedInfo: { promptCount: 1, documentCount: 1 },
            currentInfo: {
                status: 'success',
                promptCount: 2,
                documentCount: 1,
                targetSnapshot: {
                    promptIds: ['prompts-0', 'prompts-1'],
                    documentIds: ['transcriptions-0'],
                    relationshipIds: [],
                },
            },
        });
        await expect(deletion).rejects.toBeInstanceOf(UserDeletionInfoChangedError);
        expect(mocks.logAudit).not.toHaveBeenCalled();
        expect(mocks.writeBatch).not.toHaveBeenCalled();
    });

    it.each([
        {
            target: 'プロンプト',
            expectedPromptIds: ['prompt-old'],
            currentPromptIds: ['prompt-new'],
            expectedDocumentIds: ['document-stable'],
            currentDocumentIds: ['document-stable'],
        },
        {
            target: '文書',
            expectedPromptIds: ['prompt-stable'],
            currentPromptIds: ['prompt-stable'],
            expectedDocumentIds: ['document-old'],
            currentDocumentIds: ['document-new'],
        },
    ])('$targetが同数の別ドキュメントへ置換された場合は削除を始めない', async ({
        expectedPromptIds,
        currentPromptIds,
        expectedDocumentIds,
        currentDocumentIds,
    }) => {
        mocks.getDocs
            .mockResolvedValueOnce(createSnapshotWithIds(currentPromptIds, 'prompts'))
            .mockResolvedValueOnce(createSnapshotWithIds(currentDocumentIds, 'transcriptions'))
            .mockResolvedValueOnce(createSnapshotWithIds(['relationship-stable'], 'relationships'))
            .mockResolvedValueOnce(createSnapshotWithIds([], 'relationships'));

        const deletion = deleteUserData('user-1', 'user@example.com', {
            promptCount: 1,
            documentCount: 1,
            targetSnapshot: {
                promptIds: expectedPromptIds,
                documentIds: expectedDocumentIds,
                relationshipIds: ['relationship-stable'],
            },
        });

        await expect(deletion).rejects.toMatchObject({
            name: 'UserDeletionInfoChangedError',
            failedStage: 'verification',
            currentInfo: {
                status: 'success',
                promptCount: 1,
                documentCount: 1,
                targetSnapshot: {
                    promptIds: currentPromptIds,
                    documentIds: currentDocumentIds,
                    relationshipIds: ['relationship-stable'],
                },
            },
        });
        expect(mocks.logAudit).not.toHaveBeenCalled();
        expect(mocks.writeBatch).not.toHaveBeenCalled();
    });

    it.each([
        {
            change: '増加',
            expectedRelationshipIds: ['relationship-a'],
            currentRelationshipIds: ['relationship-a', 'relationship-b'],
        },
        {
            change: '減少',
            expectedRelationshipIds: ['relationship-a', 'relationship-b'],
            currentRelationshipIds: ['relationship-a'],
        },
        {
            change: '同数置換',
            expectedRelationshipIds: ['relationship-a'],
            currentRelationshipIds: ['relationship-b'],
        },
    ])('relationshipが$changeした場合は件数表示が同じでも削除を始めない', async ({
        expectedRelationshipIds,
        currentRelationshipIds,
    }) => {
        mocks.getDocs
            .mockResolvedValueOnce(createSnapshotWithIds([], 'prompts'))
            .mockResolvedValueOnce(createSnapshotWithIds([], 'transcriptions'))
            .mockResolvedValueOnce(createSnapshotWithIds(currentRelationshipIds, 'relationships'))
            .mockResolvedValueOnce(createSnapshotWithIds([], 'relationships'));

        const deletion = deleteUserData('user-1', undefined, {
            promptCount: 0,
            documentCount: 0,
            targetSnapshot: {
                promptIds: [],
                documentIds: [],
                relationshipIds: expectedRelationshipIds,
            },
        });

        await expect(deletion).rejects.toMatchObject({
            name: 'UserDeletionInfoChangedError',
            failedStage: 'verification',
            currentInfo: {
                promptCount: 0,
                documentCount: 0,
                targetSnapshot: { relationshipIds: currentRelationshipIds },
            },
        });
        expect(mocks.logAudit).not.toHaveBeenCalled();
        expect(mocks.writeBatch).not.toHaveBeenCalled();
    });

    it('3種類のID集合が完全一致する場合は順序差とrelationship重複を許容して削除する', async () => {
        const promptsSnapshot = createSnapshotWithIds(['prompt-a', 'prompt-b'], 'prompts');
        const documentsSnapshot = createSnapshotWithIds(['document-a'], 'transcriptions');
        const supervisorRelationships = createSnapshotWithIds(
            ['relationship-supervisor', 'relationship-shared'],
            'relationships',
        );
        const subordinateRelationships = createSnapshotWithIds(
            ['relationship-shared', 'relationship-subordinate'],
            'relationships',
        );
        mocks.getDocs
            .mockResolvedValueOnce(promptsSnapshot)
            .mockResolvedValueOnce(documentsSnapshot)
            .mockResolvedValueOnce(supervisorRelationships)
            .mockResolvedValueOnce(subordinateRelationships);

        await deleteUserData('user-1', undefined, {
            promptCount: 2,
            documentCount: 1,
            targetSnapshot: {
                promptIds: ['prompt-b', 'prompt-a'],
                documentIds: ['document-a'],
                relationshipIds: [
                    'relationship-subordinate',
                    'relationship-shared',
                    'relationship-supervisor',
                ],
            },
        });

        expect(mocks.logAudit).toHaveBeenCalledOnce();
        expect(mocks.writeBatch).toHaveBeenCalledOnce();
        expect(mocks.batches[0].delete).toHaveBeenCalledTimes(7);
        expect(mocks.batches[0].delete).toHaveBeenCalledWith(
            supervisorRelationships.docs[1].ref,
        );
        expect(mocks.batches[0].delete.mock.calls.filter(
            ([documentRef]) => documentRef.path === 'relationships/relationship-shared',
        )).toHaveLength(1);
    });

    it('途中のbatch commit失敗には段階と完了済みbatch数を残す', async () => {
        mocks.getDocs
            .mockResolvedValueOnce(createSnapshot(450, 'prompts'))
            .mockResolvedValueOnce(createSnapshot(0, 'transcriptions'))
            .mockResolvedValueOnce(createSnapshot(0, 'supervisor-relationships'))
            .mockResolvedValueOnce(createSnapshot(0, 'subordinate-relationships'));
        mocks.control.commitFailureAt = 1;

        await expect(deleteUserData('user-1', undefined, {
            promptCount: 450,
            documentCount: 0,
        })).rejects.toMatchObject({
            failedStage: 'commit',
            committedBatchCount: 1,
            failedBatchNumber: 2,
            totalBatchCount: 2,
        });

        expect(mocks.batches).toHaveLength(2);
        expect(mocks.batches[0].commit).toHaveBeenCalledOnce();
        expect(mocks.batches[1].commit).toHaveBeenCalledOnce();
        expect(mocks.loggerError).toHaveBeenCalledWith(
            'ユーザー関連データの削除に失敗',
            expect.objectContaining({ failedStage: 'commit' }),
            expect.objectContaining({
                failedStage: 'commit',
                committedBatchCount: 1,
                failedBatchNumber: 2,
            }),
        );
    });

    it('再走査失敗をscan段階として報告し削除を始めない', async () => {
        mocks.getDocs.mockRejectedValueOnce(new Error('permission-denied'));

        await expect(deleteUserData('user-1', undefined, {
            promptCount: 0,
            documentCount: 0,
        })).rejects.toMatchObject({
            failedStage: 'scan',
            committedBatchCount: 0,
        });
        expect(mocks.logAudit).not.toHaveBeenCalled();
        expect(mocks.writeBatch).not.toHaveBeenCalled();
    });
});

describe('getUserDeletionInfo', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getDocs.mockReset();
    });

    it('取得した件数を success として返す', async () => {
        mocks.getDocs
            .mockResolvedValueOnce(createSnapshotWithIds(
                ['prompt-c', 'prompt-a', 'prompt-b'],
                'prompts',
            ))
            .mockResolvedValueOnce(createSnapshotWithIds(
                ['document-b', 'document-a'],
                'transcriptions',
            ))
            .mockResolvedValueOnce(createSnapshotWithIds(
                ['relationship-z', 'relationship-shared'],
                'relationships',
            ))
            .mockResolvedValueOnce(createSnapshotWithIds(
                ['relationship-shared', 'relationship-a'],
                'relationships',
            ));

        await expect(getUserDeletionInfo('user-1')).resolves.toEqual({
            status: 'success',
            promptCount: 3,
            documentCount: 2,
            targetSnapshot: {
                promptIds: ['prompt-a', 'prompt-b', 'prompt-c'],
                documentIds: ['document-a', 'document-b'],
                relationshipIds: [
                    'relationship-a',
                    'relationship-shared',
                    'relationship-z',
                ],
            },
        });
        expect(mocks.getDocs).toHaveBeenCalledTimes(4);
        expect(mocks.where).toHaveBeenCalledWith('supervisorId', '==', 'user-1');
        expect(mocks.where).toHaveBeenCalledWith('subordinateId', '==', 'user-1');
    });

    it('取得失敗を unavailable として返し、旧件数アクセスも fail-closed にする', async () => {
        mocks.getDocs.mockRejectedValueOnce(new Error('permission-denied'));

        const info = await getUserDeletionInfo('user-1');

        expect(Object.keys(info)).toEqual(['status']);
        expect(info.status).toBe('unavailable');
        if (info.status !== 'unavailable') {
            throw new Error('unavailable が返る必要があります');
        }
        expect(() => info.promptCount).toThrow('削除対象件数を取得できませんでした');
        expect(() => info.documentCount).toThrow('削除対象件数を取得できませんでした');
        expect(mocks.loggerError).toHaveBeenCalledOnce();
    });
});
