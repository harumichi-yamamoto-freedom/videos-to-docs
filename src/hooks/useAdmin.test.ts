// @vitest-environment jsdom

/**
 * useAdmin の挙動の錠。
 *
 * ハーネスは実 React に委譲する（createRoot + act で本物のフックを回す）。
 * 旧ハーネスは useState を単一スロットでモックしていたため、フック側の
 * 実装自由度を縛っていた。ここでは probe コンポーネントが「描画のたびに」
 * 返り値を記録するので、コミット後の値だけでなく描画フレーム単位の
 * 一瞬の漏れ（旧UIDの allowed が見えるフレーム）も検査できる。
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
    user: null as { uid: string } | null,
    loading: true,
}));

const mocks = vi.hoisted(() => ({
    database: { name: 'mock-firestore' },
    doc: vi.fn((...segments: unknown[]) => ({ segments })),
    getDoc: vi.fn(),
    loggerError: vi.fn(),
}));

vi.mock('./useAuth', () => ({
    useAuth: () => ({ user: authState.user, loading: authState.loading }),
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

import { clearInFlightAdminChecks, useAdmin } from './useAdmin';

type AdminHookResult = ReturnType<typeof useAdmin>;

const probeLog = {
    first: [] as AdminHookResult[],
    second: [] as AdminHookResult[],
};

function FirstProbe(): null {
    probeLog.first.push(useAdmin());
    return null;
}

function SecondProbe(): null {
    probeLog.second.push(useAdmin());
    return null;
}

function latestFirst(): AdminHookResult {
    const result = probeLog.first.at(-1);
    if (!result) throw new Error('FirstProbe has not rendered');
    return result;
}

function latestSecond(): AdminHookResult {
    const result = probeLog.second.at(-1);
    if (!result) throw new Error('SecondProbe has not rendered');
    return result;
}

function statusesSince(log: AdminHookResult[], startIndex: number): string[] {
    return log.slice(startIndex).map(result => result.status);
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
    let container: HTMLDivElement;
    let root: Root;

    beforeAll(() => {
        (
            globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterAll(() => {
        (
            globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = false;
    });

    beforeEach(() => {
        authState.user = null;
        authState.loading = true;
        probeLog.first = [];
        probeLog.second = [];
        vi.clearAllMocks();
        mocks.getDoc.mockReset();
        mocks.doc.mockImplementation((...segments: unknown[]) => ({ segments }));
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        // モジュール共有の in-flight Map を明示的に空へ戻し、
        // 未解決 deferred の残留がテスト間の暗黙結合にならないようにする。
        clearInFlightAdminChecks();
    });

    async function renderProbe(): Promise<void> {
        await act(async () => {
            root.render(React.createElement(FirstProbe));
        });
    }

    async function renderTwoProbes(): Promise<void> {
        await act(async () => {
            root.render(React.createElement(
                React.Fragment,
                null,
                React.createElement(FirstProbe),
                React.createElement(SecondProbe),
            ));
        });
    }

    it('権限取得成功をallowedと互換フィールドへ反映する', async () => {
        authState.user = { uid: 'admin-1' };
        authState.loading = false;
        const check = deferred<ReturnType<typeof adminSnapshot>>();
        mocks.getDoc.mockReturnValueOnce(check.promise);

        await renderProbe();

        // 判定が返るまでは checking として振る舞う。
        expect(latestFirst()).toMatchObject({
            status: 'checking',
            checkedUid: null,
            isAdmin: false,
            loading: true,
        });

        await act(async () => {
            check.resolve(adminSnapshot(true));
        });

        expect(latestFirst()).toEqual({
            status: 'allowed',
            checkedUid: 'admin-1',
            isAdmin: true,
            loading: false,
            retry: expect.any(Function),
        });
        expect(mocks.doc).toHaveBeenCalledWith(mocks.database, 'users', 'admin-1');
    });

    it('権限取得エラーをdeniedへ畳み込まずerrorとして公開する', async () => {
        authState.user = { uid: 'user-1' };
        authState.loading = false;
        mocks.getDoc.mockRejectedValueOnce(new Error('permission-denied'));

        await renderProbe();

        expect(latestFirst()).toEqual({
            status: 'error',
            checkedUid: 'user-1',
            isAdmin: false,
            loading: false,
            retry: expect.any(Function),
        });
        expect(mocks.loggerError).toHaveBeenCalledWith(
            '管理者権限チェックに失敗',
            expect.any(Error),
            { userId: 'user-1' },
        );
    });

    it('UID切替後は旧UIDのallowedをどの描画フレームでも公開しない', async () => {
        authState.user = { uid: 'admin-1' };
        authState.loading = false;
        mocks.getDoc.mockResolvedValueOnce(adminSnapshot(true));

        await renderProbe();
        expect(latestFirst().status).toBe('allowed');

        const secondCheck = deferred<ReturnType<typeof adminSnapshot>>();
        mocks.getDoc.mockReturnValueOnce(secondCheck.promise);
        authState.user = { uid: 'user-2' };
        const switchPoint = probeLog.first.length;

        await renderProbe();

        // 旧UIDの allowed は切替後のどのフレームにも漏れない（描画ログ全数検査）。
        expect(statusesSince(probeLog.first, switchPoint)).not.toContain('allowed');
        expect(latestFirst()).toMatchObject({
            status: 'checking',
            checkedUid: null,
            isAdmin: false,
            loading: true,
        });

        await act(async () => {
            secondCheck.resolve(adminSnapshot(false));
        });
    });

    it('切替前UIDの遅延結果で現在UIDの判定を上書きしない', async () => {
        const firstCheck = deferred<ReturnType<typeof adminSnapshot>>();
        const secondCheck = deferred<ReturnType<typeof adminSnapshot>>();
        mocks.getDoc
            .mockReturnValueOnce(firstCheck.promise)
            .mockReturnValueOnce(secondCheck.promise);

        authState.user = { uid: 'admin-1' };
        authState.loading = false;
        await renderProbe();

        authState.user = { uid: 'user-2' };
        await renderProbe();
        expect(latestFirst().status).toBe('checking');

        await act(async () => {
            secondCheck.resolve(adminSnapshot(false));
        });
        expect(latestFirst()).toMatchObject({
            status: 'denied',
            checkedUid: 'user-2',
            isAdmin: false,
        });

        const settledPoint = probeLog.first.length;
        await act(async () => {
            firstCheck.resolve(adminSnapshot(true));
        });
        expect(statusesSince(probeLog.first, settledPoint)).not.toContain('allowed');
        expect(latestFirst()).toMatchObject({
            status: 'denied',
            checkedUid: 'user-2',
            isAdmin: false,
        });
    });

    it('同時マウントの2購読でusers読取を1回に束ね、両者へ同じ判定を配る', async () => {
        authState.user = { uid: 'admin-1' };
        authState.loading = false;
        const check = deferred<ReturnType<typeof adminSnapshot>>();
        mocks.getDoc.mockReturnValue(check.promise);

        await renderTwoProbes();

        expect(latestFirst().status).toBe('checking');
        expect(latestSecond().status).toBe('checking');
        expect(mocks.getDoc).toHaveBeenCalledTimes(1);

        await act(async () => {
            check.resolve(adminSnapshot(true));
        });

        expect(latestFirst()).toMatchObject({ status: 'allowed', isAdmin: true });
        expect(latestSecond()).toMatchObject({ status: 'allowed', isAdmin: true });
        expect(mocks.getDoc).toHaveBeenCalledTimes(1);
    });

    it('判定の確定後にマウントした購読者は判定し直す（結果を固定キャッシュしない）', async () => {
        authState.user = { uid: 'admin-1' };
        authState.loading = false;
        mocks.getDoc.mockResolvedValue(adminSnapshot(true));

        await renderProbe();
        expect(latestFirst().status).toBe('allowed');
        expect(mocks.getDoc).toHaveBeenCalledTimes(1);

        await renderTwoProbes();

        expect(latestSecond().status).toBe('allowed');
        // 追加購読者は新しいマウントなので読取が1回増える（確定済み結果の使い回しはしない）。
        expect(mocks.getDoc).toHaveBeenCalledTimes(2);
    });

    it('errorからretryで判定をやり直し、復旧すればallowedへ抜ける', async () => {
        authState.user = { uid: 'admin-1' };
        authState.loading = false;
        mocks.getDoc.mockRejectedValueOnce(new Error('unavailable'));

        await renderProbe();
        expect(latestFirst().status).toBe('error');

        mocks.getDoc.mockResolvedValueOnce(adminSnapshot(true));
        await act(async () => {
            latestFirst().retry();
        });

        expect(mocks.getDoc).toHaveBeenCalledTimes(2);
        expect(latestFirst()).toMatchObject({
            status: 'allowed',
            checkedUid: 'admin-1',
            isAdmin: true,
        });
    });

    it('retryは滞留中の判定を掴み直さず、新しい読取を張る', async () => {
        authState.user = { uid: 'admin-1' };
        authState.loading = false;
        const stalled = deferred<ReturnType<typeof adminSnapshot>>();
        const fresh = deferred<ReturnType<typeof adminSnapshot>>();
        mocks.getDoc
            .mockReturnValueOnce(stalled.promise)
            .mockReturnValueOnce(fresh.promise);

        await renderProbe();
        expect(latestFirst().status).toBe('checking');
        expect(mocks.getDoc).toHaveBeenCalledTimes(1);

        await act(async () => {
            latestFirst().retry();
        });

        // 長期滞留中の古い読取を共有せず、再取得の読取が実際に張られる。
        expect(mocks.getDoc).toHaveBeenCalledTimes(2);

        await act(async () => {
            fresh.resolve(adminSnapshot(true));
        });
        expect(latestFirst().status).toBe('allowed');

        // 古い判定が遅れて確定しても、retry後の判定を上書きしない。
        const settledPoint = probeLog.first.length;
        await act(async () => {
            stalled.resolve(adminSnapshot(false));
        });
        expect(statusesSince(probeLog.first, settledPoint)).not.toContain('denied');
        expect(latestFirst().status).toBe('allowed');
    });

    it('retry後の新しい判定エントリは、古い判定のsettleで消えない', async () => {
        authState.user = { uid: 'admin-1' };
        authState.loading = false;
        const stalled = deferred<ReturnType<typeof adminSnapshot>>();
        const fresh = deferred<ReturnType<typeof adminSnapshot>>();
        // 3回目以降の読取（=ガード欠落の症状）は永遠に確定しない promise で受け、
        // 回数の assert だけで綺麗に落とせるようにする。
        mocks.getDoc.mockImplementation(() => new Promise(() => undefined));
        mocks.getDoc
            .mockReturnValueOnce(stalled.promise)
            .mockReturnValueOnce(fresh.promise);

        await renderProbe();
        await act(async () => {
            latestFirst().retry();
        });
        expect(mocks.getDoc).toHaveBeenCalledTimes(2);

        // 古い判定が retry 後に遅れて settle する（新エントリより先に確定）。
        await act(async () => {
            stalled.resolve(adminSnapshot(false));
        });

        // この時点で新しいエントリが Map に残っているなら、後続の購読者は
        // 進行中の読取を共有し、読取回数は増えない。古い settle が新エントリを
        // 消してしまう退行では、ここで3回目の読取が張られて落ちる。
        await renderTwoProbes();
        expect(mocks.getDoc).toHaveBeenCalledTimes(2);

        await act(async () => {
            fresh.resolve(adminSnapshot(true));
        });
        expect(latestFirst()).toMatchObject({ status: 'allowed', isAdmin: true });
        expect(latestSecond()).toMatchObject({ status: 'allowed', isAdmin: true });
    });

    it('未認証はdeniedとし、usersを読まない', async () => {
        authState.user = null;
        authState.loading = false;

        await renderProbe();

        expect(latestFirst()).toMatchObject({
            status: 'denied',
            checkedUid: null,
            isAdmin: false,
            loading: false,
        });
        expect(mocks.getDoc).not.toHaveBeenCalled();
    });

    it('認証の解決前はcheckingのまま読取を始めず、解決後に判定する', async () => {
        authState.user = null;
        authState.loading = true;

        await renderProbe();

        expect(latestFirst().status).toBe('checking');
        expect(mocks.getDoc).not.toHaveBeenCalled();

        authState.user = { uid: 'admin-1' };
        authState.loading = false;
        mocks.getDoc.mockResolvedValueOnce(adminSnapshot(true));
        await renderProbe();

        expect(latestFirst().status).toBe('allowed');
    });
});
