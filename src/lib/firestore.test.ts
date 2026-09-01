import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const database = { name: 'mock-firestore' };
    const documentReference = { id: 'mock-document-reference' };
    const timestamp = { type: 'mock-server-timestamp' };
    const deleteFieldValue = { type: 'mock-delete-field' };

    return {
        database,
        deleteFieldValue,
        documentReference,
        timestamp,
        addDoc: vi.fn(),
        collection: vi.fn((...segments: unknown[]) => ({ type: 'collection', segments })),
        deleteDoc: vi.fn(),
        deleteField: vi.fn(() => deleteFieldValue),
        doc: vi.fn(() => documentReference),
        getDocs: vi.fn(),
        limit: vi.fn((count: number) => ({ type: 'limit', count })),
        orderBy: vi.fn((field: string, direction: string) => ({ type: 'orderBy', field, direction })),
        query: vi.fn((...constraints: unknown[]) => ({ type: 'query', constraints })),
        serverTimestamp: vi.fn(() => timestamp),
        updateDoc: vi.fn(),
        where: vi.fn((field: string, operator: string, value: unknown) => ({
            type: 'where',
            field,
            operator,
            value,
        })),
        getCurrentUserId: vi.fn(() => 'GUEST'),
        getOwnerType: vi.fn(() => 'guest' as const),
        logAudit: vi.fn(),
        updateUserStats: vi.fn(),
        validateDocumentSize: vi.fn(),
    };
});

vi.mock('firebase/firestore', () => ({
    Timestamp: class MockTimestamp {},
    addDoc: mocks.addDoc,
    collection: mocks.collection,
    deleteDoc: mocks.deleteDoc,
    deleteField: mocks.deleteField,
    doc: mocks.doc,
    getDocs: mocks.getDocs,
    limit: mocks.limit,
    orderBy: mocks.orderBy,
    query: mocks.query,
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
    getTranscriptionDocuments,
    getTranscriptions,
    getTranscriptionsByOwnerId,
    saveTranscription,
    updateTranscriptionContent,
} from './firestore';

interface MockDocumentData {
    title: string;
    fileName: string;
    originalFileType: string;
    promptName: string;
    ownerType: 'guest';
    ownerId: string;
    createdBy: string;
    transcription?: string | null;
    text?: string | null;
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
            });
            expect(payload).not.toHaveProperty('text');
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

    describe('本文の読出マッピング', () => {
        it('詳細形式で transcription を優先し、text と空文字へフォールバックする', async () => {
            mockQuerySnapshot();

            const documents = await getTranscriptionDocuments();

            expect(documents.map(document => document.transcription)).toEqual(
                mappingCases.map(row => row.expected),
            );
        });

        it('簡略形式で transcription を優先し、text と空文字へフォールバックする', async () => {
            mockQuerySnapshot();

            const documents = await getTranscriptions();

            expect(documents.map(document => document.text)).toEqual(
                mappingCases.map(row => row.expected),
            );
        });

        it('所有者指定形式で transcription を優先し、text と空文字へフォールバックする', async () => {
            mockQuerySnapshot();

            const documents = await getTranscriptionsByOwnerId('owner-id');

            expect(documents.map(document => document.text)).toEqual(
                mappingCases.map(row => row.expected),
            );
        });
    });
});
