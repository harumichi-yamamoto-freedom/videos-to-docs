import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const database = { name: 'mock-firestore' };
    const timestamp = { type: 'server-timestamp' };

    return {
        database,
        timestamp,
        currentUserId: 'GUEST',
        ownerType: 'guest' as 'guest' | 'user',
        addDoc: vi.fn(),
        collection: vi.fn((...segments: unknown[]) => ({ type: 'collection', segments })),
        deleteDoc: vi.fn(),
        deleteField: vi.fn(() => ({ type: 'delete-field' })),
        doc: vi.fn((...segments: unknown[]) => ({ type: 'document', segments })),
        getDoc: vi.fn(),
        getDocs: vi.fn(),
        limit: vi.fn((count: number) => ({ type: 'limit', count })),
        orderBy: vi.fn((field: string, direction?: string) => ({
            type: 'orderBy',
            field,
            direction,
        })),
        query: vi.fn((...constraints: unknown[]) => ({ type: 'query', constraints })),
        serverTimestamp: vi.fn(() => timestamp),
        setDoc: vi.fn(),
        updateDoc: vi.fn(),
        where: vi.fn((field: string, operator: string, value: unknown) => ({
            type: 'where',
            field,
            operator,
            value,
        })),
        logAudit: vi.fn(),
        updateUserStats: vi.fn(),
        loggerError: vi.fn(),
    };
});

vi.mock('firebase/firestore', () => ({
    Timestamp: class MockTimestamp {},
    addDoc: mocks.addDoc,
    collection: mocks.collection,
    deleteDoc: mocks.deleteDoc,
    deleteField: mocks.deleteField,
    doc: mocks.doc,
    getDoc: mocks.getDoc,
    getDocs: mocks.getDocs,
    limit: mocks.limit,
    orderBy: mocks.orderBy,
    query: mocks.query,
    serverTimestamp: mocks.serverTimestamp,
    setDoc: mocks.setDoc,
    updateDoc: mocks.updateDoc,
    where: mocks.where,
}));

vi.mock('./firebase', () => ({
    db: mocks.database,
}));

vi.mock('./auth', () => ({
    getCurrentUserId: () => mocks.currentUserId,
    getOwnerType: () => mocks.ownerType,
}));

vi.mock('./auditLog', () => ({
    logAudit: mocks.logAudit,
}));

vi.mock('./userManagement', () => ({
    updateUserStats: mocks.updateUserStats,
}));

vi.mock('./logger', () => ({
    createLogger: () => ({
        error: mocks.loggerError,
        info: vi.fn(),
    }),
}));

import { saveTranscription } from './firestore';
import { createPrompt } from './prompts';

describe('runtime settings fallback creation flows', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.currentUserId = 'GUEST';
        mocks.ownerType = 'guest';
        mocks.addDoc.mockResolvedValue({ id: 'created-document' });
        mocks.logAudit.mockResolvedValue(undefined);
        mocks.updateUserStats.mockResolvedValue(undefined);
    });

    it('未認証ユーザーは管理設定を読めなくても既定値でプロンプトを作成し、設定へwriteしない', async () => {
        mocks.getDoc.mockRejectedValueOnce(new Error('permission-denied'));

        await expect(createPrompt('議事録', '短いプロンプト')).resolves.toBe('created-document');

        expect(mocks.getDoc).toHaveBeenCalledOnce();
        expect(mocks.doc).toHaveBeenCalledWith(mocks.database, 'adminSettings', 'config');
        expect(mocks.setDoc).not.toHaveBeenCalled();
        expect(mocks.addDoc).toHaveBeenCalledWith(
            expect.objectContaining({ segments: [mocks.database, 'prompts'] }),
            expect.objectContaining({
                name: '議事録',
                content: '短いプロンプト',
                ownerType: 'guest',
                ownerId: 'GUEST',
            }),
        );
    });

    it('一般ユーザーはconfig不在でも既定値で文書を作成し、設定の補完writeを行わない', async () => {
        mocks.currentUserId = 'user-1';
        mocks.ownerType = 'user';
        mocks.getDoc.mockResolvedValueOnce({
            exists: () => false,
        });

        await expect(saveTranscription(
            'recording.wav',
            '短い文書本文',
            '議事録',
            'audio',
        )).resolves.toBe('created-document');

        expect(mocks.getDoc).toHaveBeenCalledOnce();
        expect(mocks.doc).toHaveBeenCalledWith(mocks.database, 'adminSettings', 'config');
        expect(mocks.setDoc).not.toHaveBeenCalled();
        expect(mocks.addDoc).toHaveBeenCalledWith(
            expect.objectContaining({ segments: [mocks.database, 'transcriptions'] }),
            expect.objectContaining({
                fileName: 'recording.wav',
                transcription: '短い文書本文',
                ownerType: 'user',
                ownerId: 'user-1',
            }),
        );
        expect(mocks.updateUserStats).toHaveBeenCalledWith('user-1', 0, 1);
    });
});
