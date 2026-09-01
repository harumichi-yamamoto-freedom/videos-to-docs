import { beforeEach, describe, expect, it, vi } from 'vitest';

type Effect = () => void | (() => void);

const harness = vi.hoisted(() => ({
    auth: {
        user: null as { uid: string } | null,
        loading: true,
    },
    initialized: false,
    state: undefined as unknown,
    pendingEffect: null as Effect | null,
    cleanup: null as (() => void) | null,
}));

const mocks = vi.hoisted(() => ({
    database: { name: 'mock-firestore' },
    doc: vi.fn((...segments: unknown[]) => ({ segments })),
    getDoc: vi.fn(),
    loggerError: vi.fn(),
}));

vi.mock('react', async importOriginal => {
    const actual = await importOriginal<typeof import('react')>();

    return {
        ...actual,
        useState: vi.fn((initialValue: unknown) => {
            if (!harness.initialized) {
                harness.initialized = true;
                harness.state = initialValue;
            }

            const setState = (nextValue: unknown) => {
                harness.state = typeof nextValue === 'function'
                    ? (nextValue as (previous: unknown) => unknown)(harness.state)
                    : nextValue;
            };

            return [harness.state, setState];
        }),
        useEffect: vi.fn((effect: Effect) => {
            harness.pendingEffect = effect;
        }),
    };
});

vi.mock('./useAuth', () => ({
    useAuth: () => harness.auth,
}));

vi.mock('@/lib/firebase', () => ({
    db: mocks.database,
}));

vi.mock('firebase/firestore', () => ({
    doc: mocks.doc,
    getDoc: mocks.getDoc,
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        error: mocks.loggerError,
    }),
}));

import { useAdmin } from './useAdmin';

function AdminHookHarness(): ReturnType<typeof useAdmin> {
    return useAdmin();
}

function runPendingEffect(): void {
    harness.cleanup?.();
    harness.cleanup = harness.pendingEffect?.() ?? null;
    harness.pendingEffect = null;
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function adminSnapshot(superuser: boolean) {
    return {
        exists: () => true,
        data: () => ({ superuser }),
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return { promise, resolve, reject };
}

describe('useAdmin', () => {
    beforeEach(() => {
        harness.cleanup?.();
        harness.auth = { user: null, loading: true };
        harness.initialized = false;
        harness.state = undefined;
        harness.pendingEffect = null;
        harness.cleanup = null;
        vi.clearAllMocks();
        mocks.getDoc.mockReset();
    });

    it('権限取得成功をallowedと互換フィールドへ反映する', async () => {
        harness.auth = { user: { uid: 'admin-1' }, loading: false };
        mocks.getDoc.mockResolvedValueOnce(adminSnapshot(true));

        expect(AdminHookHarness()).toMatchObject({
            status: 'checking',
            checkedUid: null,
            isAdmin: false,
            loading: true,
        });

        runPendingEffect();
        await flushPromises();

        expect(AdminHookHarness()).toEqual({
            status: 'allowed',
            checkedUid: 'admin-1',
            isAdmin: true,
            loading: false,
        });
        expect(mocks.doc).toHaveBeenCalledWith(mocks.database, 'users', 'admin-1');
    });

    it('権限取得エラーをdeniedへ畳み込まずerrorとして公開する', async () => {
        harness.auth = { user: { uid: 'user-1' }, loading: false };
        mocks.getDoc.mockRejectedValueOnce(new Error('permission-denied'));

        AdminHookHarness();
        runPendingEffect();
        await flushPromises();

        expect(AdminHookHarness()).toEqual({
            status: 'error',
            checkedUid: 'user-1',
            isAdmin: false,
            loading: false,
        });
        expect(mocks.loggerError).toHaveBeenCalledWith(
            '管理者権限チェックに失敗',
            expect.any(Error),
            { userId: 'user-1' },
        );
    });

    it('UID切替直後は旧UIDのallowedを公開しない', async () => {
        harness.auth = { user: { uid: 'admin-1' }, loading: false };
        mocks.getDoc.mockResolvedValueOnce(adminSnapshot(true));

        AdminHookHarness();
        runPendingEffect();
        await flushPromises();
        expect(AdminHookHarness().status).toBe('allowed');

        harness.auth = { user: { uid: 'user-2' }, loading: false };

        expect(AdminHookHarness()).toMatchObject({
            status: 'checking',
            checkedUid: null,
            isAdmin: false,
            loading: true,
        });
    });

    it('切替前UIDの遅延結果で現在UIDの判定を上書きしない', async () => {
        const firstCheck = deferred<ReturnType<typeof adminSnapshot>>();
        const secondCheck = deferred<ReturnType<typeof adminSnapshot>>();
        mocks.getDoc
            .mockReturnValueOnce(firstCheck.promise)
            .mockReturnValueOnce(secondCheck.promise);

        harness.auth = { user: { uid: 'admin-1' }, loading: false };
        AdminHookHarness();
        runPendingEffect();

        harness.auth = { user: { uid: 'user-2' }, loading: false };
        expect(AdminHookHarness().status).toBe('checking');
        runPendingEffect();

        secondCheck.resolve(adminSnapshot(false));
        await flushPromises();
        expect(AdminHookHarness()).toMatchObject({
            status: 'denied',
            checkedUid: 'user-2',
            isAdmin: false,
        });

        firstCheck.resolve(adminSnapshot(true));
        await flushPromises();
        expect(AdminHookHarness()).toMatchObject({
            status: 'denied',
            checkedUid: 'user-2',
            isAdmin: false,
        });
    });
});
