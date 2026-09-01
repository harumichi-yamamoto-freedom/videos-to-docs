import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const database = { name: 'mock-firestore' };

    return {
        database,
        collection: vi.fn((...segments: unknown[]) => ({ type: 'collection', segments })),
        getDocs: vi.fn(),
        orderBy: vi.fn((field: string, direction?: string) => ({
            type: 'orderBy',
            field,
            direction,
        })),
        query: vi.fn((...constraints: unknown[]) => ({ type: 'query', constraints })),
        where: vi.fn((field: string, operator: string, value: unknown) => ({
            type: 'where',
            field,
            operator,
            value,
        })),
        loggerError: vi.fn(),
    };
});

vi.mock('firebase/firestore', () => ({
    collection: mocks.collection,
    getDocs: mocks.getDocs,
    orderBy: mocks.orderBy,
    query: mocks.query,
    where: mocks.where,
}));

vi.mock('./firebase', () => ({
    db: mocks.database,
}));

vi.mock('./adminSettings', () => ({
    getAdminSettings: vi.fn(),
}));

vi.mock('./storage', () => ({
    audioExists: vi.fn(),
}));

vi.mock('./logger', () => ({
    createLogger: vi.fn(() => ({
        error: mocks.loggerError,
        info: vi.fn(),
    })),
}));

import { getAllAudioTranscriptions } from './adminAudioFiles';

interface MockDocumentData {
    title: string;
    fileName: string;
    transcription?: string | null;
    text?: string | null;
    promptName: string;
    ownerType: string;
    ownerId: string;
    createdAt: { toDate: () => Date };
    audioStoragePath: string;
}

interface MappingCase {
    id: string;
    content: Pick<MockDocumentData, 'transcription' | 'text'>;
    expected: string;
}

const mappingCases: MappingCase[] = [
    {
        id: 'canonical-and-legacy',
        content: {
            transcription: 'transcription の本文',
            text: '古い text の本文',
        },
        expected: 'transcription の本文',
    },
    {
        id: 'legacy-only',
        content: { text: 'text の本文' },
        expected: 'text の本文',
    },
    {
        id: 'canonical-null',
        content: {
            transcription: null,
            text: 'null からフォールバックした本文',
        },
        expected: 'null からフォールバックした本文',
    },
    {
        id: 'content-missing',
        content: {},
        expected: '',
    },
    {
        id: 'content-null',
        content: {
            transcription: null,
            text: null,
        },
        expected: '',
    },
    {
        id: 'canonical-empty-string',
        content: {
            transcription: '',
            text: 'フォールバックしてはいけない本文',
        },
        expected: '',
    },
];

function createDocumentData(row: MappingCase): MockDocumentData {
    return {
        title: row.id,
        fileName: `${row.id}.mp3`,
        promptName: 'テスト',
        ownerType: 'guest',
        ownerId: 'GUEST',
        createdAt: { toDate: () => new Date('2026-01-01T00:00:00.000Z') },
        audioStoragePath: `audio/${row.id}.mp3`,
        ...row.content,
    };
}

describe('getAllAudioTranscriptions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getDocs.mockResolvedValue({
            forEach: (
                callback: (snapshot: { id: string; data: () => MockDocumentData }) => void,
            ) => {
                for (const row of mappingCases) {
                    callback({
                        id: row.id,
                        data: () => createDocumentData(row),
                    });
                }
            },
        });
    });

    it('transcription を優先し、legacy text と空文字へ正しくフォールバックする', async () => {
        const documents = await getAllAudioTranscriptions();

        expect(documents.map(({ id, transcription }) => ({ id, transcription }))).toEqual(
            mappingCases.map(({ id, expected }) => ({ id, transcription: expected })),
        );
    });
});
