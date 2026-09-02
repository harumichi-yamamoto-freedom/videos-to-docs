import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DefaultPromptTemplate } from './adminSettings';

const mocks = vi.hoisted(() => {
    const timestamp = { type: 'server-timestamp' };
    const batch = {
        set: vi.fn(),
        delete: vi.fn(),
        commit: vi.fn(),
    };

    return {
        database: { name: 'mock-firestore' },
        timestamp,
        batch,
        writeBatch: vi.fn(() => batch),
        collection: vi.fn(() => ({ path: 'prompts' })),
        query: vi.fn((...parts: unknown[]) => ({ parts })),
        where: vi.fn((field: string, operator: string, value: unknown) => ({ field, operator, value })),
        orderBy: vi.fn(),
        limit: vi.fn(),
        getDocs: vi.fn(),
        getDoc: vi.fn(),
        doc: vi.fn((_database: unknown, path: string, id: string) => ({ path: `${path}/${id}`, id })),
        setDoc: vi.fn(),
        addDoc: vi.fn(),
        updateDoc: vi.fn(),
        deleteDoc: vi.fn(),
        serverTimestamp: vi.fn(() => timestamp),
        getDefaultPrompts: vi.fn(),
        loggerError: vi.fn(),
        loggerInfo: vi.fn(),
    };
});

vi.mock('firebase/firestore', () => ({
    collection: mocks.collection,
    addDoc: mocks.addDoc,
    getDocs: mocks.getDocs,
    getDoc: mocks.getDoc,
    query: mocks.query,
    orderBy: mocks.orderBy,
    deleteDoc: mocks.deleteDoc,
    doc: mocks.doc,
    setDoc: mocks.setDoc,
    updateDoc: mocks.updateDoc,
    where: mocks.where,
    serverTimestamp: mocks.serverTimestamp,
    limit: mocks.limit,
    writeBatch: mocks.writeBatch,
}));

vi.mock('./firebase', () => ({ db: mocks.database }));
vi.mock('./auth', () => ({
    getCurrentUserId: () => 'admin-1',
    getOwnerType: () => 'user',
}));
vi.mock('./auditLog', () => ({ logAudit: vi.fn() }));
vi.mock('./userManagement', () => ({ updateUserStats: vi.fn() }));
vi.mock('./logger', () => ({
    createLogger: () => ({ error: mocks.loggerError, info: mocks.loggerInfo }),
}));
vi.mock('./adminSettings', async importOriginal => {
    const actual = await importOriginal<typeof import('./adminSettings')>();
    return { ...actual, getDefaultPrompts: mocks.getDefaultPrompts };
});

import { syncGuestDefaultPrompts } from './prompts';

/*
 * 実装と同じ決定論的 ID 規則をここにも写す。ID 規則が変わると既存のゲスト doc を
 * 「別物」と見なして作り直す (createdAt が消える) ので、規則の踏襲そのものを錠にする。
 */
function deterministicHash(value: string): string {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = (hash << 5) - hash + value.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
}

function guestDefaultId(name: string): string {
    return `default_GUEST_${deterministicHash(`GUEST:${name}`)}`;
}

type StoredGuestDefault = {
    name: string;
    content: string;
    model?: string;
    thinkingLevel?: string;
};

function arrangeExistingGuestDefaults(stored: StoredGuestDefault[]) {
    mocks.getDocs.mockResolvedValue({
        docs: stored.map(data => ({
            id: guestDefaultId(data.name),
            data: () => ({
                ...data,
                isDefault: true,
                ownerType: 'guest',
                ownerId: 'GUEST',
                createdBy: 'GUEST',
                createdAt: { seconds: 1 },
                updatedAt: { seconds: 1 },
            }),
        })),
    });
}

const template = (name: string, content: string): DefaultPromptTemplate => ({
    name,
    content,
    model: 'default',
    thinkingLevel: 'default',
});

describe('syncGuestDefaultPrompts (S2-5 差分 upsert)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.batch.commit.mockResolvedValue(undefined);
        mocks.getDefaultPrompts.mockResolvedValue([]);
        mocks.getDocs.mockResolvedValue({ docs: [] });
    });

    it('テンプレート1件の変更は該当docだけを上書きし、他は触らず、消えた分だけ削除する', async () => {
        arrangeExistingGuestDefaults([
            { name: '打ち合わせの流れ', content: '旧の流れ' },
            { name: '希望条件', content: '希望条件を整理' },
            { name: '廃止テンプレ', content: '消える' },
        ]);
        mocks.getDefaultPrompts.mockResolvedValue([
            template('打ち合わせの流れ', '新しい流れ'),
            template('希望条件', '希望条件を整理'),
        ]);

        await expect(syncGuestDefaultPrompts()).resolves.toBeUndefined();

        // 保存済み snapshot は最初の await で受け取る (adminSettings の override 受け渡し順序)
        expect(mocks.getDefaultPrompts.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.getDocs.mock.invocationCallOrder[0]);

        // 変更のあった doc だけ merge 上書き。createdAt と所有者は書かない
        expect(mocks.batch.set).toHaveBeenCalledTimes(1);
        expect(mocks.batch.set).toHaveBeenCalledWith(
            expect.objectContaining({ id: guestDefaultId('打ち合わせの流れ') }),
            {
                name: '打ち合わせの流れ',
                content: '新しい流れ',
                model: 'default',
                thinkingLevel: 'default',
                updatedAt: mocks.timestamp,
            },
            { merge: true },
        );
        expect(mocks.batch.set.mock.calls[0][1]).not.toHaveProperty('createdAt');

        // テンプレートから消えた ID だけ削除
        expect(mocks.batch.delete).toHaveBeenCalledTimes(1);
        expect(mocks.batch.delete).toHaveBeenCalledWith(
            expect.objectContaining({ id: guestDefaultId('廃止テンプレ') }),
        );

        // 全削除→再作成 (旧挙動) の痕跡が無い: 単発の deleteDoc/setDoc は使わず、1 batch で確定
        expect(mocks.deleteDoc).not.toHaveBeenCalled();
        expect(mocks.setDoc).not.toHaveBeenCalled();
        expect(mocks.writeBatch).toHaveBeenCalledTimes(1);
        expect(mocks.batch.commit).toHaveBeenCalledTimes(1);
    });

    it('内容が同じなら (未設定と既定値の違いだけなら) 何も書かない', async () => {
        arrangeExistingGuestDefaults([
            // model/thinkingLevel 未設定の旧 doc は正規化すると既定値と同じ
            { name: '打ち合わせの流れ', content: '流れ' },
            { name: 'お客様情報', content: '一覧', model: ' default ', thinkingLevel: 'low' },
        ]);
        mocks.getDefaultPrompts.mockResolvedValue([
            template('打ち合わせの流れ', '流れ'),
            { name: 'お客様情報', content: '一覧', model: 'default', thinkingLevel: 'low' },
        ]);

        await expect(syncGuestDefaultPrompts()).resolves.toBeUndefined();

        expect(mocks.batch.set).not.toHaveBeenCalled();
        expect(mocks.batch.delete).not.toHaveBeenCalled();
        expect(mocks.batch.commit).not.toHaveBeenCalled();
        expect(mocks.deleteDoc).not.toHaveBeenCalled();
        expect(mocks.setDoc).not.toHaveBeenCalled();
    });

    it('まだ無いテンプレートは所有者と createdAt を付けて新規作成する', async () => {
        arrangeExistingGuestDefaults([{ name: '希望条件', content: '希望条件を整理' }]);
        mocks.getDefaultPrompts.mockResolvedValue([
            template('希望条件', '希望条件を整理'),
            { name: '新規テンプレ', content: '新規', model: 'gemini-3.7-flash', thinkingLevel: 'high' },
        ]);

        await expect(syncGuestDefaultPrompts()).resolves.toBeUndefined();

        expect(mocks.batch.set).toHaveBeenCalledTimes(1);
        expect(mocks.batch.set).toHaveBeenCalledWith(
            expect.objectContaining({ id: guestDefaultId('新規テンプレ') }),
            {
                name: '新規テンプレ',
                content: '新規',
                model: 'gemini-3.7-flash',
                thinkingLevel: 'high',
                isDefault: true,
                ownerType: 'guest',
                ownerId: 'GUEST',
                createdBy: 'GUEST',
                createdAt: mocks.timestamp,
                updatedAt: mocks.timestamp,
            },
        );
        expect(mocks.batch.delete).not.toHaveBeenCalled();
        expect(mocks.batch.commit).toHaveBeenCalledTimes(1);
    });

    it('同名テンプレートは同じ ID に畳まれるため先勝ちで 1 回だけ書く', async () => {
        mocks.getDefaultPrompts.mockResolvedValue([
            template('重複', '先'),
            template('重複', '後'),
        ]);

        await expect(syncGuestDefaultPrompts()).resolves.toBeUndefined();

        expect(mocks.batch.set).toHaveBeenCalledTimes(1);
        expect(mocks.batch.set.mock.calls[0][1]).toEqual(expect.objectContaining({ content: '先' }));
    });

    it('batch の確定に失敗したら同期失敗として伝播する', async () => {
        arrangeExistingGuestDefaults([{ name: '廃止テンプレ', content: '消える' }]);
        mocks.batch.commit.mockRejectedValueOnce(new Error('permission-denied'));

        await expect(syncGuestDefaultPrompts())
            .rejects.toThrow('ゲストデフォルトプロンプトの同期に失敗しました');
        expect(mocks.loggerError).toHaveBeenCalled();
    });
});
