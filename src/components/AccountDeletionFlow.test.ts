import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StateAction<T> = T | ((previous: T) => T);
type Effect = () => void | (() => void);

interface HookAdapter {
    useEffect(effect: Effect, dependencies?: readonly unknown[]): void;
    useRef<T>(initialValue: T): { current: T };
    useState<T>(initialValue: T | (() => T)): [T, (action: StateAction<T>) => void];
}

const mountedHook = vi.hoisted(() => ({
    current: null as HookAdapter | null,
}));

interface MockAuthUser {
    uid: string;
    email: string | null;
    getIdToken: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => {
    class MockUserDataDeletionError extends Error {
        readonly failedStage: 'scan' | 'verification' | 'audit' | 'commit';
        readonly committedBatchCount: number;
        readonly failedBatchNumber?: number;
        readonly totalBatchCount?: number;

        constructor(
            message: string,
            failedStage: 'scan' | 'verification' | 'audit' | 'commit',
            details: {
                committedBatchCount?: number;
                failedBatchNumber?: number;
                totalBatchCount?: number;
            } = {},
        ) {
            super(message);
            this.name = 'UserDataDeletionError';
            this.failedStage = failedStage;
            this.committedBatchCount = details.committedBatchCount ?? 0;
            this.failedBatchNumber = details.failedBatchNumber;
            this.totalBatchCount = details.totalBatchCount;
        }
    }

    class MockUserDeletionInfoChangedError extends MockUserDataDeletionError {
        readonly expectedInfo: { promptCount: number; documentCount: number };
        readonly currentInfo: {
            status: 'success';
            promptCount: number;
            documentCount: number;
        };

        constructor(
            expectedInfo: { promptCount: number; documentCount: number },
            currentInfo: { promptCount: number; documentCount: number },
        ) {
            super(
                '削除対象が変更されました。最新の件数を確認してください',
                'verification',
            );
            this.name = 'UserDeletionInfoChangedError';
            this.expectedInfo = expectedInfo;
            this.currentInfo = { status: 'success', ...currentInfo };
        }
    }

    return {
        auth: { currentUser: null as MockAuthUser | null },
        deleteUserData: vi.fn(),
        getUserDeletionInfo: vi.fn(),
        loggerError: vi.fn(),
        loggerInfo: vi.fn(),
        reauthModal: vi.fn(() => null),
        UserDataDeletionError: MockUserDataDeletionError,
        UserDeletionInfoChangedError: MockUserDeletionInfoChangedError,
    };
});

vi.mock('react', async importOriginal => {
    const actual = await importOriginal<typeof import('react')>();
    const adapter = () => {
        if (!mountedHook.current) throw new Error('Hook harness is not mounted');
        return mountedHook.current;
    };

    return {
        ...actual,
        useCallback: ((callback: unknown) => callback) as typeof actual.useCallback,
        useEffect: ((effect: Effect, dependencies?: readonly unknown[]) => (
            adapter().useEffect(effect, dependencies)
        )) as typeof actual.useEffect,
        useRef: ((initialValue: unknown) => (
            adapter().useRef(initialValue)
        )) as typeof actual.useRef,
        useState: ((initialValue: unknown) => (
            adapter().useState(initialValue)
        )) as typeof actual.useState,
    };
});

vi.mock('../lib/firebase', () => ({
    auth: mocks.auth,
}));

vi.mock('../lib/accountDeletion', () => ({
    deleteUserData: mocks.deleteUserData,
    getUserDeletionInfo: mocks.getUserDeletionInfo,
    UserDataDeletionError: mocks.UserDataDeletionError,
    UserDeletionInfoChangedError: mocks.UserDeletionInfoChangedError,
}));

vi.mock('../lib/logger', () => ({
    createLogger: vi.fn(() => ({
        error: mocks.loggerError,
        info: mocks.loggerInfo,
    })),
}));

vi.mock('./ReauthModal', () => ({
    default: mocks.reauthModal,
}));

import {
    deleteAccountInStages,
    useAccountDeletionFlow,
} from './AccountDeletionFlow';

interface StateSlot {
    kind: 'state';
    value: unknown;
}

interface RefSlot {
    kind: 'ref';
    value: { current: unknown };
}

interface EffectSlot {
    kind: 'effect';
    cleanup?: () => void;
    dependencies?: readonly unknown[];
}

type HookSlot = StateSlot | RefSlot | EffectSlot;

function dependenciesMatch(
    previous: readonly unknown[] | undefined,
    next: readonly unknown[] | undefined,
): boolean {
    if (!previous || !next || previous.length !== next.length) return false;
    return previous.every((value, index) => Object.is(value, next[index]));
}

/**
 * The repository has no DOM renderer dependency, so this mounts the real hook with the minimum
 * state/ref/effect lifecycle needed to drive its returned UI and event handlers.
 */
class HookHarness<Result> implements HookAdapter {
    private readonly slots: HookSlot[] = [];
    private hookIndex = 0;
    private pendingEffects: Array<{
        index: number;
        effect: Effect;
        dependencies?: readonly unknown[];
    }> = [];
    private mounted = true;
    private latestResult!: Result;

    constructor(private readonly renderHook: () => Result) {
        this.render();
    }

    render(): Result {
        if (!this.mounted) throw new Error('Hook harness is unmounted');
        this.hookIndex = 0;
        this.pendingEffects = [];
        mountedHook.current = this;
        try {
            this.latestResult = this.renderHook();
        } finally {
            mountedHook.current = null;
        }

        for (const pending of this.pendingEffects) {
            const slot = this.slots[pending.index];
            if (!slot || slot.kind !== 'effect') {
                throw new Error(`Hook ${pending.index} changed type`);
            }
            slot.cleanup?.();
            slot.dependencies = pending.dependencies;
            const cleanup = pending.effect();
            slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
        }
        return this.latestResult;
    }

    get result(): Result {
        return this.latestResult;
    }

    unmount(): void {
        if (!this.mounted) return;
        this.mounted = false;
        for (const slot of this.slots) {
            if (slot.kind === 'effect') slot.cleanup?.();
        }
        if (mountedHook.current === this) mountedHook.current = null;
    }

    useState<T>(initialValue: T | (() => T)): [T, (action: StateAction<T>) => void] {
        const index = this.hookIndex++;
        let slot = this.slots[index];
        if (!slot) {
            slot = {
                kind: 'state',
                value: typeof initialValue === 'function'
                    ? (initialValue as () => T)()
                    : initialValue,
            };
            this.slots[index] = slot;
        }
        if (slot.kind !== 'state') throw new Error(`Hook ${index} changed type`);

        const stateSlot = slot;
        const setValue = (action: StateAction<T>) => {
            const previous = stateSlot.value as T;
            stateSlot.value = typeof action === 'function'
                ? (action as (value: T) => T)(previous)
                : action;
        };
        return [stateSlot.value as T, setValue];
    }

    useRef<T>(initialValue: T): { current: T } {
        const index = this.hookIndex++;
        let slot = this.slots[index];
        if (!slot) {
            slot = { kind: 'ref', value: { current: initialValue } };
            this.slots[index] = slot;
        }
        if (slot.kind !== 'ref') throw new Error(`Hook ${index} changed type`);
        return slot.value as { current: T };
    }

    useEffect(effect: Effect, dependencies?: readonly unknown[]): void {
        const index = this.hookIndex++;
        let slot = this.slots[index];
        if (!slot) {
            slot = { kind: 'effect' };
            this.slots[index] = slot;
        }
        if (slot.kind !== 'effect') throw new Error(`Hook ${index} changed type`);
        if (!dependenciesMatch(slot.dependencies, dependencies)) {
            this.pendingEffects.push({ index, effect, dependencies });
        }
    }
}

interface ElementProps {
    children?: ReactNode;
    [key: string]: unknown;
}

function isElement(node: ReactNode): node is ReactElement<ElementProps> {
    return typeof node === 'object' && node !== null && 'props' in node;
}

function findElement(
    node: ReactNode,
    predicate: (element: ReactElement<ElementProps>) => boolean,
): ReactElement<ElementProps> {
    if (Array.isArray(node)) {
        for (const child of node) {
            try {
                return findElement(child, predicate);
            } catch {
                // Search the next child.
            }
        }
    } else if (isElement(node)) {
        if (predicate(node)) return node;
        return findElement(node.props.children, predicate);
    }
    throw new Error('Expected element was not rendered');
}

function getText(node: ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(getText).join('');
    if (isElement(node)) return getText(node.props.children);
    return '';
}

function findButton(node: ReactNode, label: string): ReactElement<ElementProps> {
    return findElement(
        node,
        element => element.type === 'button' && getText(element.props.children).includes(label),
    );
}

function createUser(uid = 'user-1'): MockAuthUser {
    return {
        uid,
        email: 'user@example.com',
        getIdToken: vi.fn().mockResolvedValue('token'),
        delete: vi.fn().mockResolvedValue(undefined),
    };
}

const mountedHarnesses: HookHarness<unknown>[] = [];

function mountDeletionFlow(user: MockAuthUser) {
    const harness = new HookHarness(() => useAccountDeletionFlow(user as never));
    mountedHarnesses.push(harness as HookHarness<unknown>);
    return harness;
}

async function enterConfirmationAndOpenReauthentication(
    harness: HookHarness<ReturnType<typeof useAccountDeletionFlow>>,
) {
    let dialog = harness.result.accountDeletionDialog;
    const input = findElement(
        dialog,
        element => element.props.id === 'account-deletion-confirmation',
    );
    (input.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: '削除' },
    });
    dialog = harness.render().accountDeletionDialog;
    (findButton(dialog, '再認証へ進む').props.onClick as () => void)();
    dialog = harness.render().accountDeletionDialog;
    return findElement(dialog, element => element.type === mocks.reauthModal);
}

describe('deleteAccountInStages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.auth.currentUser = createUser();
        mocks.deleteUserData.mockResolvedValue(undefined);
        mocks.getUserDeletionInfo.mockResolvedValue({
            status: 'success',
            promptCount: 0,
            documentCount: 0,
        });
    });

    it('確認件数でFirestoreを再走査・削除してからAuthを削除する', async () => {
        const expectedCounts = { promptCount: 3, documentCount: 2 };

        await expect(deleteAccountInStages(
            'user-1',
            'user@example.com',
            expectedCounts,
        )).resolves.toEqual({
            dataDeleted: true,
            authDeleted: true,
            failedStage: null,
        });

        expect(mocks.deleteUserData).toHaveBeenCalledWith(
            'user-1',
            'user@example.com',
            expectedCounts,
        );
        expect(mocks.deleteUserData.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.auth.currentUser!.delete.mock.invocationCallOrder[0],
        );
    });

    it('件数乖離時はAuthを削除せず最新件数を再確認結果として返す', async () => {
        mocks.deleteUserData.mockRejectedValueOnce(
            new mocks.UserDeletionInfoChangedError(
                { promptCount: 1, documentCount: 1 },
                { promptCount: 2, documentCount: 1 },
            ),
        );

        await expect(deleteAccountInStages('user-1', undefined, {
            promptCount: 1,
            documentCount: 1,
        })).resolves.toEqual({
            dataDeleted: false,
            authDeleted: false,
            failedStage: 'confirmation',
            latestDeletionInfo: {
                status: 'success',
                promptCount: 2,
                documentCount: 1,
            },
        });
        expect(mocks.auth.currentUser?.delete).not.toHaveBeenCalled();
    });

    it('Firestore削除失敗時はAuth削除を開始しない', async () => {
        mocks.deleteUserData.mockRejectedValueOnce(new Error('firestore failed'));

        await expect(deleteAccountInStages('user-1')).resolves.toEqual({
            dataDeleted: false,
            authDeleted: false,
            failedStage: 'data',
        });
        expect(mocks.auth.currentUser?.delete).not.toHaveBeenCalled();
    });

    it('途中の削除batch失敗情報を結果へ貫通させ、Auth削除を開始しない', async () => {
        mocks.deleteUserData.mockRejectedValueOnce(
            new mocks.UserDataDeletionError('batch 2 failed', 'commit', {
                committedBatchCount: 1,
                failedBatchNumber: 2,
                totalBatchCount: 2,
            }),
        );

        await expect(deleteAccountInStages('user-1')).resolves.toMatchObject({
            dataDeleted: false,
            authDeleted: false,
            failedStage: 'commit',
            committedBatchCount: 1,
            failedBatchNumber: 2,
            totalBatchCount: 2,
        });
        expect(mocks.auth.currentUser?.delete).not.toHaveBeenCalled();
    });
});

describe('useAccountDeletionFlow UI lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.deleteUserData.mockResolvedValue(undefined);
    });

    afterEach(() => {
        while (mountedHarnesses.length > 0) mountedHarnesses.pop()?.unmount();
        mountedHook.current = null;
    });

    it('Auth部分失敗後の再試行は最新件数を再走査・再確認し、新規データを削除してからAuthを再削除する', async () => {
        const user = createUser();
        user.delete
            .mockRejectedValueOnce(new Error('auth failed'))
            .mockResolvedValueOnce(undefined);
        mocks.auth.currentUser = user;
        mocks.getUserDeletionInfo
            .mockResolvedValueOnce({
                status: 'success',
                promptCount: 1,
                documentCount: 1,
            })
            .mockResolvedValueOnce({
                status: 'success',
                promptCount: 2,
                documentCount: 1,
            });
        const harness = mountDeletionFlow(user);

        await harness.result.beginAccountDeletion();
        harness.render();
        const firstReauthentication = await enterConfirmationAndOpenReauthentication(harness);
        await (firstReauthentication.props.onSuccess as () => Promise<void>)();
        (firstReauthentication.props.onClose as (reason: string) => void)('complete');
        let dialog = harness.render().accountDeletionDialog;

        expect(getText(dialog)).toContain('ログイン用アカウントを削除できませんでした');
        expect(mocks.deleteUserData).toHaveBeenCalledTimes(1);
        expect(user.delete).toHaveBeenCalledTimes(1);

        (findButton(dialog, '削除対象を再確認').props.onClick as () => void)();
        await Promise.resolve();
        dialog = harness.render().accountDeletionDialog;

        expect(mocks.getUserDeletionInfo).toHaveBeenCalledTimes(2);
        expect(getText(dialog)).toContain('所有しているプロンプト 2件');
        expect(mocks.deleteUserData).toHaveBeenCalledTimes(1);

        const secondReauthentication = await enterConfirmationAndOpenReauthentication(harness);
        await (secondReauthentication.props.onSuccess as () => Promise<void>)();

        expect(mocks.deleteUserData).toHaveBeenCalledTimes(2);
        expect(mocks.deleteUserData).toHaveBeenNthCalledWith(
            2,
            'user-1',
            'user@example.com',
            expect.objectContaining({ promptCount: 2, documentCount: 1 }),
        );
        expect(user.delete).toHaveBeenCalledTimes(2);
        expect(mocks.deleteUserData.mock.invocationCallOrder[1]).toBeLessThan(
            user.delete.mock.invocationCallOrder[1],
        );
    });

    it('削除直前の件数乖離を実UIへ戻し、最新件数の再確認を要求する', async () => {
        const user = createUser();
        mocks.auth.currentUser = user;
        mocks.getUserDeletionInfo.mockResolvedValueOnce({
            status: 'success',
            promptCount: 1,
            documentCount: 0,
        });
        mocks.deleteUserData.mockRejectedValueOnce(
            new mocks.UserDeletionInfoChangedError(
                { promptCount: 1, documentCount: 0 },
                { promptCount: 2, documentCount: 0 },
            ),
        );
        const harness = mountDeletionFlow(user);

        await harness.result.beginAccountDeletion();
        harness.render();
        const reauthentication = await enterConfirmationAndOpenReauthentication(harness);
        await (reauthentication.props.onSuccess as () => Promise<void>)();
        const dialog = harness.render().accountDeletionDialog;

        expect(getText(dialog)).toContain('削除対象が確認後に変わりました');
        expect(getText(dialog)).toContain('所有しているプロンプト 2件');
        expect(user.delete).not.toHaveBeenCalled();
    });

    it('途中のbatch失敗を削除済みbatch数と未完了の残りに分けて表示する', async () => {
        const user = createUser();
        mocks.auth.currentUser = user;
        mocks.getUserDeletionInfo.mockResolvedValueOnce({
            status: 'success',
            promptCount: 450,
            documentCount: 0,
        });
        mocks.deleteUserData.mockRejectedValueOnce(
            new mocks.UserDataDeletionError('batch 2 failed', 'commit', {
                committedBatchCount: 1,
                failedBatchNumber: 2,
                totalBatchCount: 2,
            }),
        );
        const harness = mountDeletionFlow(user);

        await harness.result.beginAccountDeletion();
        harness.render();
        const reauthentication = await enterConfirmationAndOpenReauthentication(harness);
        await (reauthentication.props.onSuccess as () => Promise<void>)();
        const dialog = harness.render().accountDeletionDialog;
        const text = getText(dialog);

        expect(text).toContain('1バッチ分が削除済みです');
        expect(text).toContain('第2バッチ（全2バッチ）で削除処理に失敗');
        expect(text).toContain('残りの対象データは削除完了を確認できませんでした');
        expect(text).toContain('一部削除済み（1バッチ）');
        expect(text).toContain('ログイン用アカウント削除は未実行');
        expect(text).not.toContain('Firestore の対象データ削除されていません');
        expect(findButton(dialog, '削除対象を再確認')).toBeDefined();
        expect(user.delete).not.toHaveBeenCalled();
    });

    it.each([
        ['scan', '削除バッチ未開始（再走査で失敗）'],
        ['audit', '削除バッチ未開始（監査記録で失敗）'],
        ['verification', '削除バッチ未開始（再確認で中断）'],
    ] as const)('%s段階の失敗を一部削除とは表示しない', async (failedStage, expectedStatus) => {
        const user = createUser();
        mocks.auth.currentUser = user;
        mocks.getUserDeletionInfo.mockResolvedValueOnce({
            status: 'success',
            promptCount: 0,
            documentCount: 0,
        });
        mocks.deleteUserData.mockRejectedValueOnce(
            new mocks.UserDataDeletionError(`${failedStage} failed`, failedStage),
        );
        const harness = mountDeletionFlow(user);

        await harness.result.beginAccountDeletion();
        harness.render();
        const reauthentication = await enterConfirmationAndOpenReauthentication(harness);
        await (reauthentication.props.onSuccess as () => Promise<void>)();
        const text = getText(harness.render().accountDeletionDialog);

        expect(text).toContain(expectedStatus);
        expect(text).toContain('削除は実行していません');
        expect(text).not.toContain('一部削除済み');
        expect(user.delete).not.toHaveBeenCalled();
    });
});
