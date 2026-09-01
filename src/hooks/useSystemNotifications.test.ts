import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StateAction<T> = T | ((previous: T) => T);
type Effect = () => void | (() => void);
type Dependencies = readonly unknown[] | undefined;

interface ReactHookAdapter {
    useState<T>(initialValue: T | (() => T)): [T, (action: StateAction<T>) => void];
    useEffect(effect: Effect, dependencies?: Dependencies): void;
    useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T;
    useRef<T>(initialValue: T): { current: T };
}

const mountedReactHook = vi.hoisted(() => ({
    current: null as ReactHookAdapter | null,
}));

const mocks = vi.hoisted(() => ({
    db: { name: 'firestore' },
    dismissalsRef: { path: 'notificationDismissals/user-1' },
    useAuth: vi.fn(),
    subscribeToDismissals: vi.fn(),
    subscribeToPublishedNotifications: vi.fn(),
    arrayRemove: vi.fn(),
    arrayUnion: vi.fn(),
    doc: vi.fn(),
    getDoc: vi.fn(),
    setDoc: vi.fn(),
}));

vi.mock('react', async importOriginal => {
    const actual = await importOriginal<typeof import('react')>();
    const adapter = (): ReactHookAdapter => {
        if (!mountedReactHook.current) {
            throw new Error('Hook lifecycle harness is not mounted');
        }
        return mountedReactHook.current;
    };

    return {
        ...actual,
        useCallback: ((callback: unknown, dependencies: readonly unknown[]) => (
            adapter().useMemo(() => callback, dependencies)
        )) as typeof actual.useCallback,
        useEffect: ((effect: Effect, dependencies?: Dependencies) => (
            adapter().useEffect(effect, dependencies)
        )) as typeof actual.useEffect,
        useMemo: ((factory: () => unknown, dependencies: readonly unknown[]) => (
            adapter().useMemo(factory, dependencies)
        )) as typeof actual.useMemo,
        useRef: ((initialValue: unknown) => (
            adapter().useRef(initialValue)
        )) as typeof actual.useRef,
        useState: ((initialValue: unknown) => (
            adapter().useState(initialValue)
        )) as typeof actual.useState,
    };
});

vi.mock('./useAuth', () => ({
    useAuth: mocks.useAuth,
}));

vi.mock('firebase/firestore', async importOriginal => {
    const actual = await importOriginal<typeof import('firebase/firestore')>();

    return {
        ...actual,
        arrayRemove: mocks.arrayRemove,
        arrayUnion: mocks.arrayUnion,
        doc: mocks.doc,
        getDoc: mocks.getDoc,
        setDoc: mocks.setDoc,
    };
});

vi.mock('../lib/firebase', () => ({
    db: mocks.db,
}));

vi.mock('@/lib/systemNotifications', async () => {
    const actual = await import('../lib/systemNotifications');

    return {
        ...actual,
        subscribeToDismissals: mocks.subscribeToDismissals,
        subscribeToPublishedNotifications: mocks.subscribeToPublishedNotifications,
    };
});

import { useAuth } from './useAuth';
import {
    dismissNotification,
    subscribeToDismissals,
    subscribeToPublishedNotifications,
    type SystemNotification,
    undismissNotification,
} from '@/lib/systemNotifications';
import { useSystemNotifications } from './useSystemNotifications';

type StateSlot = {
    kind: 'state';
    value: unknown;
    setValue: (action: StateAction<unknown>) => void;
};

type RefSlot = {
    kind: 'ref';
    value: { current: unknown };
};

type MemoSlot = {
    kind: 'memo';
    dependencies: readonly unknown[];
    value: unknown;
};

type EffectSlot = {
    kind: 'effect';
    cleanup?: () => void;
    dependencies?: Dependencies;
};

type HookSlot = StateSlot | RefSlot | MemoSlot | EffectSlot;

interface PendingEffect {
    index: number;
    effect: Effect;
    dependencies?: Dependencies;
}

function dependenciesMatch(
    previous: Dependencies,
    next: Dependencies,
): boolean {
    if (!previous || !next || previous.length !== next.length) return false;
    return previous.every((value, index) => Object.is(value, next[index]));
}

/**
 * The project intentionally has no DOM renderer test dependency. This harness mounts the real
 * hook and supplies the minimum React lifecycle needed here: persistent state/refs, dependency
 * comparison, render-phase updates, effect commit/cleanup, rerendering, and unmounting.
 */
class HookLifecycleHarness<Result> implements ReactHookAdapter {
    private readonly slots: HookSlot[] = [];
    private hookIndex = 0;
    private pendingEffects: PendingEffect[] = [];
    private rendering = false;
    private committing = false;
    private needsRender = false;
    private mounted = false;
    private latestResult!: Result;

    constructor(private readonly renderHook: () => Result) {}

    mount(): this {
        this.mounted = true;
        mountedReactHook.current = this;
        this.needsRender = true;
        this.flush();
        return this;
    }

    rerender(): void {
        this.ensureMounted();
        this.needsRender = true;
        this.flush();
    }

    unmount(): void {
        if (!this.mounted) return;
        this.mounted = false;
        for (const slot of this.slots) {
            if (slot.kind === 'effect') slot.cleanup?.();
        }
        if (mountedReactHook.current === this) mountedReactHook.current = null;
    }

    get result(): Result {
        this.ensureMounted();
        return this.latestResult;
    }

    useState<T>(initialValue: T | (() => T)): [T, (action: StateAction<T>) => void] {
        const index = this.hookIndex++;
        let slot = this.slots[index];

        if (!slot) {
            const stateSlot: StateSlot = {
                kind: 'state',
                value: typeof initialValue === 'function'
                    ? (initialValue as () => T)()
                    : initialValue,
                setValue: action => {
                    if (!this.mounted) return;
                    const nextValue = typeof action === 'function'
                        ? (action as (previous: unknown) => unknown)(stateSlot.value)
                        : action;
                    if (Object.is(nextValue, stateSlot.value)) return;
                    stateSlot.value = nextValue;
                    this.needsRender = true;
                    if (!this.rendering && !this.committing) this.flush();
                },
            };
            slot = stateSlot;
            this.slots[index] = slot;
        }

        if (slot.kind !== 'state') throw new Error(`Hook ${index} changed type`);
        return [slot.value as T, slot.setValue as (action: StateAction<T>) => void];
    }

    useEffect(effect: Effect, dependencies?: Dependencies): void {
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

    useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T {
        const index = this.hookIndex++;
        let slot = this.slots[index];
        if (!slot) {
            slot = { kind: 'memo', dependencies, value: factory() };
            this.slots[index] = slot;
        }
        if (slot.kind !== 'memo') throw new Error(`Hook ${index} changed type`);
        if (!dependenciesMatch(slot.dependencies, dependencies)) {
            slot.dependencies = dependencies;
            slot.value = factory();
        }
        return slot.value as T;
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

    private ensureMounted(): void {
        if (!this.mounted) throw new Error('Hook lifecycle harness is not mounted');
    }

    private flush(): void {
        if (!this.mounted || this.rendering || this.committing) return;
        let renderCount = 0;

        do {
            if (++renderCount > 100) throw new Error('Hook exceeded the render limit');
            this.needsRender = false;
            this.hookIndex = 0;
            this.pendingEffects = [];
            this.rendering = true;
            mountedReactHook.current = this;
            try {
                this.latestResult = this.renderHook();
            } finally {
                this.rendering = false;
            }

            // React restarts a render-phase state update before committing its effects.
            if (this.needsRender) continue;

            const effects = this.pendingEffects;
            this.pendingEffects = [];
            this.committing = true;
            try {
                for (const pending of effects) {
                    const slot = this.slots[pending.index];
                    if (!slot || slot.kind !== 'effect') {
                        throw new Error(`Hook ${pending.index} changed type`);
                    }
                    slot.cleanup?.();
                    slot.dependencies = pending.dependencies;
                    const cleanup = pending.effect();
                    slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
                }
            } finally {
                this.committing = false;
            }
        } while (this.needsRender);
    }
}

const notificationOne: SystemNotification = {
    id: 'notification-1',
    title: 'メンテナンスのお知らせ',
    body: 'システムメンテナンスを実施します。',
    severity: 'info',
    published: true,
    publishedAt: new Date('2026-09-01T00:00:00.000Z'),
    publishedBy: 'admin-1',
};

const notificationTwo: SystemNotification = {
    ...notificationOne,
    id: 'notification-2',
    title: '機能追加のお知らせ',
    publishedAt: new Date('2026-08-31T00:00:00.000Z'),
};

const mountedHooks: HookLifecycleHarness<unknown>[] = [];

function mountNotificationsHook(): HookLifecycleHarness<ReturnType<typeof useSystemNotifications>> {
    const harness = new HookLifecycleHarness(useSystemNotifications).mount();
    mountedHooks.push(harness as HookLifecycleHarness<unknown>);
    return harness;
}

describe('useSystemNotifications lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(useAuth).mockReturnValue({
            user: { uid: 'user-1' },
            loading: false,
        } as never);
        vi.mocked(subscribeToPublishedNotifications).mockReturnValue(vi.fn());
        vi.mocked(subscribeToDismissals).mockReturnValue(vi.fn());
    });

    afterEach(() => {
        while (mountedHooks.length > 0) mountedHooks.pop()?.unmount();
        mountedReactHook.current = null;
    });

    it('mountで両購読を開始し、snapshot更新を実際のhook stateとバナーへ配線する', () => {
        const unsubscribePublished = vi.fn();
        const unsubscribeDismissals = vi.fn();
        vi.mocked(subscribeToPublishedNotifications).mockReturnValue(unsubscribePublished);
        vi.mocked(subscribeToDismissals).mockReturnValue(unsubscribeDismissals);

        const hook = mountNotificationsHook();

        expect(subscribeToPublishedNotifications).toHaveBeenCalledOnce();
        expect(subscribeToDismissals).toHaveBeenCalledWith(
            'user-1',
            expect.any(Function),
            expect.any(Function),
        );
        expect(hook.result.loading).toBe(true);

        const publish = vi.mocked(subscribeToPublishedNotifications).mock.calls[0][0];
        const publishDismissals = vi.mocked(subscribeToDismissals).mock.calls[0][1];
        publish([notificationOne, notificationTwo]);

        expect(hook.result.notifications).toEqual([notificationOne, notificationTwo]);
        expect(hook.result.loading).toBe(true);

        publishDismissals(['notification-1']);

        expect(hook.result.dismissedIds).toEqual(['notification-1']);
        expect(hook.result.bannerNotifications).toEqual([notificationTwo]);
        expect(hook.result.loading).toBe(false);

        hook.unmount();
        expect(unsubscribePublished).toHaveBeenCalledOnce();
        expect(unsubscribeDismissals).toHaveBeenCalledOnce();
    });

    it('購読エラー後のretryでcleanupして再購読し、古いlistenerの更新を無視する', () => {
        const firstUnsubscribe = vi.fn();
        const secondUnsubscribe = vi.fn();
        vi.mocked(subscribeToPublishedNotifications)
            .mockReturnValueOnce(firstUnsubscribe)
            .mockReturnValueOnce(secondUnsubscribe);

        const hook = mountNotificationsHook();
        const firstPublish = vi.mocked(subscribeToPublishedNotifications).mock.calls[0][0];
        const firstError = vi.mocked(subscribeToPublishedNotifications).mock.calls[0][1];
        const publishDismissals = vi.mocked(subscribeToDismissals).mock.calls[0][1];
        const outage = new Error('temporarily unavailable');
        firstPublish([notificationOne]);
        publishDismissals([]);
        firstError?.(outage);

        expect(hook.result.notifications).toEqual([notificationOne]);
        expect(hook.result.error).toBe(outage);
        expect(hook.result.stale).toBe(true);
        expect(hook.result.retrying).toBe(false);

        hook.result.retry();

        expect(firstUnsubscribe).toHaveBeenCalledOnce();
        expect(subscribeToPublishedNotifications).toHaveBeenCalledTimes(2);
        expect(hook.result.retrying).toBe(true);

        firstPublish([notificationTwo]);
        expect(hook.result.notifications).toEqual([notificationOne]);

        const secondPublish = vi.mocked(subscribeToPublishedNotifications).mock.calls[1][0];
        secondPublish([notificationTwo]);

        expect(hook.result.notifications).toEqual([notificationTwo]);
        expect(hook.result.error).toBeNull();
        expect(hook.result.stale).toBe(false);
        expect(hook.result.retrying).toBe(false);
    });

    it('uid変更で前ユーザーの既読状態とlistenerを破棄し、新ユーザーを購読する', () => {
        const firstUnsubscribe = vi.fn();
        const secondUnsubscribe = vi.fn();
        vi.mocked(subscribeToDismissals)
            .mockReturnValueOnce(firstUnsubscribe)
            .mockReturnValueOnce(secondUnsubscribe);

        const hook = mountNotificationsHook();
        const publish = vi.mocked(subscribeToPublishedNotifications).mock.calls[0][0];
        const firstDismissals = vi.mocked(subscribeToDismissals).mock.calls[0][1];
        publish([notificationOne, notificationTwo]);
        firstDismissals(['notification-1']);
        expect(hook.result.dismissedIds).toEqual(['notification-1']);

        vi.mocked(useAuth).mockReturnValue({
            user: { uid: 'user-2' },
            loading: false,
        } as never);
        hook.rerender();

        expect(firstUnsubscribe).toHaveBeenCalledOnce();
        expect(subscribeToDismissals).toHaveBeenNthCalledWith(
            2,
            'user-2',
            expect.any(Function),
            expect.any(Function),
        );
        expect(hook.result.dismissedIds).toEqual([]);
        expect(hook.result.loading).toBe(true);

        firstDismissals(['notification-2']);
        expect(hook.result.dismissedIds).toEqual([]);

        const secondDismissals = vi.mocked(subscribeToDismissals).mock.calls[1][1];
        secondDismissals(['notification-2']);
        expect(hook.result.dismissedIds).toEqual(['notification-2']);
        expect(hook.result.bannerNotifications).toEqual([notificationOne]);
        expect(hook.result.loading).toBe(false);
    });
});

describe('notification dismissal writes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.doc.mockReturnValue(mocks.dismissalsRef);
        mocks.getDoc.mockResolvedValue({
            data: () => ({ uid: 'user-1', dismissedIds: [] }),
        });
        mocks.setDoc.mockResolvedValue(undefined);
    });

    it('単体既読をread-modify-writeせずarrayUnionでatomic追加する', async () => {
        const union = { transform: 'arrayUnion' };
        mocks.arrayUnion.mockReturnValue(union);

        await dismissNotification('user-1', 'notification-1');

        expect(mocks.getDoc).not.toHaveBeenCalled();
        expect(mocks.arrayUnion).toHaveBeenCalledWith('notification-1');
        expect(mocks.setDoc).toHaveBeenCalledWith(
            mocks.dismissalsRef,
            { uid: 'user-1', dismissedIds: union },
            { merge: true },
        );
    });

    it('単体未読戻しをread-modify-writeせずarrayRemoveでatomic削除する', async () => {
        const removal = { transform: 'arrayRemove' };
        mocks.arrayRemove.mockReturnValue(removal);

        await undismissNotification('user-1', 'notification-1');

        expect(mocks.getDoc).not.toHaveBeenCalled();
        expect(mocks.arrayRemove).toHaveBeenCalledWith('notification-1');
        expect(mocks.setDoc).toHaveBeenCalledWith(
            mocks.dismissalsRef,
            { uid: 'user-1', dismissedIds: removal },
            { merge: true },
        );
    });
});
