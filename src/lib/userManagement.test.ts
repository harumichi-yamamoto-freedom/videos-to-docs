import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * updateUserStats の競合安全性の錠。
 *
 * インメモリの Firestore 模型は本物と同じ口（doc/getDoc/setDoc/runTransaction）を
 * 持ち、runTransaction は本物同様に楽観的並行制御で動く: トランザクション内で
 * 読んだドキュメントの版がコミットまでに進んでいたら、コールバックを最初から
 * やり直す。絶対値書込（getDoc→setDoc）へ退行すると、この模型の上で並行更新の
 * 片方が巻き戻る（競合テストが赤くなる）。
 */

interface FakeDocState {
    data: Record<string, unknown>;
    version: number;
}

interface FakeDocRef {
    path: string;
}

const fakeFirestore = vi.hoisted(() => {
    const docs = new Map<string, { data: Record<string, unknown>; version: number }>();

    const snapshotOf = (path: string) => {
        const state = docs.get(path);
        return {
            exists: () => state !== undefined,
            data: () => ({ ...(state?.data ?? {}) }),
        };
    };

    return {
        docs,
        reset() {
            docs.clear();
        },
        seed(path: string, data: Record<string, unknown>) {
            docs.set(path, { data: { ...data }, version: 1 });
        },
        read(path: string): FakeDocState | undefined {
            return docs.get(path);
        },
        snapshotOf,
        merge(path: string, data: Record<string, unknown>) {
            const state = docs.get(path);
            docs.set(path, {
                data: { ...(state?.data ?? {}), ...data },
                version: (state?.version ?? 0) + 1,
            });
        },
        transactionRuns: 0,
    };
});

const mocks = vi.hoisted(() => ({
    db: { name: 'fake-firestore' },
    loggerError: vi.fn(),
    /** テストが差し込む、トランザクション読取直後の割り込み。並行順序を決定的にする。 */
    afterTransactionGet: null as ((path: string) => Promise<void>) | null,
}));

vi.mock('./firebase', () => ({
    db: mocks.db,
}));

vi.mock('./logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: mocks.loggerError,
    }),
}));

vi.mock('firebase/firestore', () => ({
    doc: (_db: unknown, ...segments: string[]): FakeDocRef => ({ path: segments.join('/') }),
    getDoc: async (ref: FakeDocRef) => fakeFirestore.snapshotOf(ref.path),
    setDoc: async (ref: FakeDocRef, data: Record<string, unknown>) => {
        fakeFirestore.merge(ref.path, data);
    },
    runTransaction: async (
        _db: unknown,
        callback: (transaction: {
            get: (ref: FakeDocRef) => Promise<ReturnType<typeof fakeFirestore.snapshotOf>>;
            update: (ref: FakeDocRef, data: Record<string, unknown>) => void;
        }) => Promise<void>,
    ) => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            fakeFirestore.transactionRuns += 1;
            const readVersions = new Map<string, number>();
            const writes: Array<[FakeDocRef, Record<string, unknown>]> = [];
            const transaction = {
                get: async (ref: FakeDocRef) => {
                    readVersions.set(ref.path, fakeFirestore.read(ref.path)?.version ?? 0);
                    const snapshot = fakeFirestore.snapshotOf(ref.path);
                    await mocks.afterTransactionGet?.(ref.path);
                    return snapshot;
                },
                update: (ref: FakeDocRef, data: Record<string, unknown>) => {
                    if (!fakeFirestore.read(ref.path)) {
                        throw new Error(`update on missing doc: ${ref.path}`);
                    }
                    writes.push([ref, data]);
                },
            };

            await callback(transaction);

            const conflicted = [...readVersions].some(
                ([path, version]) => (fakeFirestore.read(path)?.version ?? 0) !== version,
            );
            if (conflicted) continue;

            for (const [ref, data] of writes) {
                fakeFirestore.merge(ref.path, data);
            }
            return;
        }
        throw new Error('transaction retry limit exceeded');
    },
    // updateUserStats 以外の関数が使う口。ここでは呼ばれない前提で最低限だけ置く。
    collection: vi.fn(),
    getDocs: vi.fn(),
    query: vi.fn(),
    orderBy: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
    serverTimestamp: vi.fn(() => ({ server: 'timestamp' })),
    setLogLevel: vi.fn(),
    Timestamp: class {},
}));

import { updateUserStats } from './userManagement';

const USER_PATH = 'users/user-1';

describe('updateUserStats', () => {
    beforeEach(() => {
        fakeFirestore.reset();
        fakeFirestore.transactionRuns = 0;
        mocks.afterTransactionGet = null;
        mocks.loggerError.mockClear();
    });

    it('増分をトランザクションで適用し、現在値へ相対加算する', async () => {
        fakeFirestore.seed(USER_PATH, { promptCount: 2, documentCount: 5 });

        await updateUserStats('user-1', 1, 0);

        expect(fakeFirestore.read(USER_PATH)?.data).toMatchObject({
            promptCount: 3,
            documentCount: 5,
        });
        expect(mocks.loggerError).not.toHaveBeenCalled();
    });

    it('並行する2本の更新が両方とも反映される（巻き戻らない）', async () => {
        fakeFirestore.seed(USER_PATH, { promptCount: 0, documentCount: 0 });

        // 両方のトランザクションが「読み終わってから」どちらかがコミットする
        // 交錯を強制する: 先着2回の読取をバリアで足止めする。
        let readCount = 0;
        let releaseBarrier!: () => void;
        const barrier = new Promise<void>(resolve => {
            releaseBarrier = resolve;
        });
        mocks.afterTransactionGet = async () => {
            readCount += 1;
            if (readCount === 2) releaseBarrier();
            if (readCount <= 2) await barrier;
        };

        await Promise.all([
            updateUserStats('user-1', 1, 0),
            updateUserStats('user-1', 0, 1),
        ]);

        expect(fakeFirestore.read(USER_PATH)?.data).toMatchObject({
            promptCount: 1,
            documentCount: 1,
        });
        // 陽性統制: 交錯が実際に起き、少なくとも1本が再試行している。
        expect(fakeFirestore.transactionRuns).toBeGreaterThanOrEqual(3);
        expect(mocks.loggerError).not.toHaveBeenCalled();
    });

    it('同一カウンタへの並行加算も合計が落ちない', async () => {
        fakeFirestore.seed(USER_PATH, { promptCount: 0, documentCount: 0 });

        let readCount = 0;
        let releaseBarrier!: () => void;
        const barrier = new Promise<void>(resolve => {
            releaseBarrier = resolve;
        });
        mocks.afterTransactionGet = async () => {
            readCount += 1;
            if (readCount === 2) releaseBarrier();
            if (readCount <= 2) await barrier;
        };

        await Promise.all([
            updateUserStats('user-1', 1, 0),
            updateUserStats('user-1', 1, 0),
        ]);

        expect(fakeFirestore.read(USER_PATH)?.data).toMatchObject({ promptCount: 2 });
    });

    it('減算してもカウンタは0未満に沈まない', async () => {
        fakeFirestore.seed(USER_PATH, { promptCount: 0, documentCount: 3 });

        await updateUserStats('user-1', -1, -1);

        expect(fakeFirestore.read(USER_PATH)?.data).toMatchObject({
            promptCount: 0,
            documentCount: 2,
        });
    });

    it('カウンタ未初期化の既存プロファイルは0起点で加算する', async () => {
        fakeFirestore.seed(USER_PATH, { email: 'user@example.com' });

        await updateUserStats('user-1', 1, 1);

        expect(fakeFirestore.read(USER_PATH)?.data).toMatchObject({
            promptCount: 1,
            documentCount: 1,
        });
    });

    it('プロファイルが無いユーザーには書き込まない', async () => {
        await updateUserStats('user-1', 1, 0);

        expect(fakeFirestore.read(USER_PATH)).toBeUndefined();
        expect(mocks.loggerError).not.toHaveBeenCalled();
    });

    it('トランザクション失敗は投げずにログへ落とす（統計はベストエフォート）', async () => {
        fakeFirestore.seed(USER_PATH, { promptCount: 1, documentCount: 1 });
        mocks.afterTransactionGet = async () => {
            throw new Error('firestore unavailable');
        };

        await expect(updateUserStats('user-1', 1, 0)).resolves.toBeUndefined();

        expect(mocks.loggerError).toHaveBeenCalledWith(
            'ユーザー統計情報の更新に失敗',
            expect.any(Error),
            { uid: 'user-1', incrementPrompts: 1, incrementDocuments: 0 },
        );
        expect(fakeFirestore.read(USER_PATH)?.data).toMatchObject({
            promptCount: 1,
            documentCount: 1,
        });
    });
});
