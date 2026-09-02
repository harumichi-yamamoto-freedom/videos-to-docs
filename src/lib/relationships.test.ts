import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    collection: vi.fn((...segments: unknown[]) => ({ type: 'collection', segments })),
    doc: vi.fn((col: unknown, id: string) => ({ type: 'document', col, id })),
    query: vi.fn((...constraints: unknown[]) => ({ type: 'query', constraints })),
    where: vi.fn((field: string, operator: string, value: unknown) => ({ type: 'where', field, operator, value })),
    getDocs: vi.fn(),
    getDoc: vi.fn(),
    setDoc: vi.fn(async () => undefined),
    updateDoc: vi.fn(async () => undefined),
    deleteDoc: vi.fn(async () => undefined),
    onSnapshot: vi.fn(),
    serverTimestamp: vi.fn(() => ({ type: 'serverTimestamp' })),
    getUserByEmail: vi.fn(),
    getUserProfile: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
    collection: mocks.collection,
    doc: mocks.doc,
    query: mocks.query,
    where: mocks.where,
    getDocs: mocks.getDocs,
    getDoc: mocks.getDoc,
    setDoc: mocks.setDoc,
    updateDoc: mocks.updateDoc,
    deleteDoc: mocks.deleteDoc,
    onSnapshot: mocks.onSnapshot,
    serverTimestamp: mocks.serverTimestamp,
    Timestamp: class {},
}));

vi.mock('./firebase', () => ({ db: { name: 'mock-db' } }));

vi.mock('./userManagement', () => ({
    getUserByEmail: mocks.getUserByEmail,
    getUserProfile: mocks.getUserProfile,
}));

vi.mock('./logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
    buildRelationshipId,
    isLegacyRelationship,
    requestSupervisorRelationship,
} from './relationships';

const supervisorProfile = {
    uid: 'supervisor-uid',
    email: 'boss@example.com',
    displayName: '上司 太郎',
};

const subordinateProfile = {
    uid: 'subordinate-uid',
    email: 'member@example.com',
    displayName: '部下 花子',
};

beforeEach(() => {
    mocks.setDoc.mockClear();
    mocks.doc.mockClear();
    mocks.getDocs.mockReset();
    mocks.getUserByEmail.mockReset();
    mocks.getUserProfile.mockReset();
});

describe('buildRelationshipId', () => {
    it('firestore.rules のアドレス解決と一致する supervisorId_subordinateId 形式を返す', () => {
        expect(buildRelationshipId('sup-1', 'sub-2')).toBe('sup-1_sub-2');
    });
});

describe('isLegacyRelationship', () => {
    it('複合キーIDの関係は旧形式ではない', () => {
        expect(
            isLegacyRelationship({ id: 'sup-1_sub-2', supervisorId: 'sup-1', subordinateId: 'sub-2' }),
        ).toBe(false);
    });

    it('addDoc 由来のランダムIDは旧形式と判定する', () => {
        expect(
            isLegacyRelationship({ id: 'aUtoRand0mId', supervisorId: 'sup-1', subordinateId: 'sub-2' }),
        ).toBe(true);
    });
});

describe('requestSupervisorRelationship', () => {
    it('複合キーIDのdocへ setDoc し、pending の申請として保存する', async () => {
        mocks.getUserByEmail.mockResolvedValue(supervisorProfile);
        mocks.getUserProfile.mockResolvedValue(subordinateProfile);
        mocks.getDocs.mockResolvedValue({ empty: true, docs: [] });

        await requestSupervisorRelationship(subordinateProfile.uid, supervisorProfile.email);

        expect(mocks.setDoc).toHaveBeenCalledTimes(1);
        const [ref, payload] = mocks.setDoc.mock.calls[0] as unknown as [
            { id: string },
            Record<string, unknown>,
        ];
        // 期待値は buildRelationshipId で組まず、Rules 側の契約(supervisorId_subordinateId)を
        // リテラルで固定する。関数のフォーマットが変わればここが赤くなる。
        expect(ref.id).toBe('supervisor-uid_subordinate-uid');
        expect(payload).toMatchObject({
            supervisorId: supervisorProfile.uid,
            subordinateId: subordinateProfile.uid,
            status: 'pending',
        });
    });

    it('自分自身を上司に指名できない', async () => {
        mocks.getUserByEmail.mockResolvedValue({ ...supervisorProfile, uid: subordinateProfile.uid });

        await expect(
            requestSupervisorRelationship(subordinateProfile.uid, supervisorProfile.email),
        ).rejects.toThrow('自分自身を上司に登録することはできません');
        expect(mocks.setDoc).not.toHaveBeenCalled();
    });

    it('同じ相手への申請が既に pending なら二重申請しない', async () => {
        mocks.getUserByEmail.mockResolvedValue(supervisorProfile);
        mocks.getUserProfile.mockResolvedValue(subordinateProfile);
        mocks.getDocs.mockResolvedValue({
            empty: false,
            docs: [{ id: 'sup_sub', data: () => ({ status: 'pending' }) }],
        });

        await expect(
            requestSupervisorRelationship(subordinateProfile.uid, supervisorProfile.email),
        ).rejects.toThrow('このユーザーにはすでに申請済みです');
        expect(mocks.setDoc).not.toHaveBeenCalled();
    });
});
