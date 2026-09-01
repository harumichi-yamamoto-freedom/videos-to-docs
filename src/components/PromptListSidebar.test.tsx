import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prompt } from '@/lib/prompts';
import { PromptListSidebar } from './PromptListSidebar';

const mocks = vi.hoisted(() => ({
    addDoc: vi.fn(),
    collection: vi.fn((...segments: unknown[]) => ({ type: 'collection', segments })),
    deleteDoc: vi.fn(),
    doc: vi.fn((...segments: unknown[]) => ({ type: 'document', segments })),
    getCurrentUserId: vi.fn(() => 'GUEST'),
    getDefaultPrompts: vi.fn(),
    getDoc: vi.fn(),
    getDocs: vi.fn(),
    getOwnerType: vi.fn<() => 'guest' | 'user'>(() => 'guest'),
    useAuth: vi.fn((): { user: { uid: string } | null; loading: boolean } => ({
        user: null,
        loading: false,
    })),
    getPrompts: vi.fn(),
    limit: vi.fn((count: number) => ({ type: 'limit', count })),
    orderBy: vi.fn((field: string, direction: string) => ({ type: 'orderBy', field, direction })),
    query: vi.fn((...constraints: unknown[]) => ({ type: 'query', constraints })),
    serverTimestamp: vi.fn(() => ({ type: 'server-timestamp' })),
    setDoc: vi.fn(),
    updateDoc: vi.fn(),
    useCallback: vi.fn(),
    useEffect: vi.fn(),
    useRef: vi.fn(),
    useState: vi.fn(),
    where: vi.fn((field: string, operator: string, value: unknown) => ({
        type: 'where',
        field,
        operator,
        value,
    })),
}));

vi.mock('react', async importOriginal => {
    const actual = await importOriginal<typeof import('react')>();

    return {
        ...actual,
        useCallback: mocks.useCallback,
        useEffect: mocks.useEffect,
        useRef: mocks.useRef,
        useState: mocks.useState,
    };
});

vi.mock('@/hooks/useAuth', () => ({
    useAuth: mocks.useAuth,
}));

vi.mock('firebase/firestore', () => ({
    addDoc: mocks.addDoc,
    collection: mocks.collection,
    deleteDoc: mocks.deleteDoc,
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

vi.mock('@/lib/firebase', () => ({
    db: { name: 'mock-firestore' },
}));

vi.mock('@/lib/auth', () => ({
    getCurrentUserId: mocks.getCurrentUserId,
    getOwnerType: mocks.getOwnerType,
}));

vi.mock('@/lib/prompts', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/prompts')>();

    return {
        ...actual,
        addDefaultPrompts: vi.fn(),
        deletePrompt: vi.fn(),
        getPrompts: mocks.getPrompts,
    };
});

vi.mock('@/lib/adminSettings', () => ({
    getDefaultPrompts: mocks.getDefaultPrompts,
    validatePromptSize: vi.fn(),
}));

vi.mock('@/lib/auditLog', () => ({
    logAudit: vi.fn(),
}));

vi.mock('@/lib/userManagement', () => ({
    updateUserStats: vi.fn(),
}));

vi.mock('@/constants/geminiModels', () => ({
    getGeminiModelLabel: vi.fn((model: string) => model),
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn(), info: vi.fn() }),
}));

vi.mock('./AddDefaultPromptsModal', () => ({
    AddDefaultPromptsModal: () => null,
}));

type LoadStatus = 'loading' | 'success' | 'error';
interface TestCollectionState {
    ownerKey: string | null;
    status: LoadStatus;
    prompts: Prompt[];
    refreshWarning?: string;
}

type Effect = () => void | (() => void);
type ElementProps = {
    children?: React.ReactNode;
    className?: string;
    role?: string;
    'aria-label'?: string;
};

const GUEST_OWNER_KEY = JSON.stringify(['guest', 'GUEST']);
const USER_NAMED_GUEST_OWNER_KEY = JSON.stringify(['user', 'GUEST']);
const USER_A_OWNER_KEY = JSON.stringify(['user', 'user-a']);

const prompt: Prompt = {
    id: 'prompt-1',
    name: '議事録',
    content: '会議内容を要約してください。',
    model: 'gemini-test',
    isDefault: false,
    ownerType: 'guest',
    ownerId: 'GUEST',
    createdBy: 'GUEST',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
};

const newerPrompt: Prompt = {
    ...prompt,
    id: 'prompt-2',
    name: '最新のプロンプト',
};

function getText(node: React.ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') {
        return String(node);
    }

    if (!React.isValidElement<ElementProps>(node)) {
        return '';
    }

    return React.Children.toArray(node.props.children).map(getText).join('');
}

function findElement(
    node: React.ReactNode,
    predicate: (element: React.ReactElement<ElementProps>) => boolean,
): React.ReactElement<ElementProps> | null {
    if (!React.isValidElement<ElementProps>(node)) {
        return null;
    }

    if (predicate(node)) {
        return node;
    }

    for (const child of React.Children.toArray(node.props.children)) {
        const match = findElement(child, predicate);

        if (match) {
            return match;
        }
    }

    return null;
}

function configureHookState(collectionState: TestCollectionState) {
    let stateIndex = 0;
    const setters: ReturnType<typeof vi.fn>[] = [];

    mocks.useState.mockImplementation((initialValue: unknown) => {
        const index = stateIndex++;
        const setter = vi.fn();
        setters[index] = setter;
        const value = index === 0
            ? collectionState
            : typeof initialValue === 'function'
                ? (initialValue as () => unknown)()
                : initialValue;
        return [value, setter];
    });

    return setters;
}

function renderSidebar(
    props: Partial<React.ComponentProps<typeof PromptListSidebar>> = {},
): React.ReactNode {
    return PromptListSidebar({
        onPromptClick: vi.fn(),
        onCreateClick: vi.fn(),
        ...props,
    }) as React.ReactNode;
}

describe('PromptListSidebar', () => {
    let effects: Effect[];

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        effects = [];
        mocks.useCallback.mockImplementation((callback: unknown) => callback);
        mocks.useEffect.mockImplementation((effect: Effect) => {
            effects.push(effect);
        });
        mocks.useRef.mockImplementation((initialValue: unknown) => ({ current: initialValue }));
        mocks.useAuth.mockReturnValue({ user: null, loading: false });
        mocks.getCurrentUserId.mockReturnValue('GUEST');
        mocks.getOwnerType.mockReturnValue('guest');
        mocks.getDefaultPrompts.mockResolvedValue([]);
        mocks.getDoc.mockResolvedValue({ exists: () => false });
        mocks.getDocs.mockResolvedValue({ empty: false });
        mocks.getPrompts.mockResolvedValue([prompt]);
        mocks.setDoc.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('取得中は未確定の件数を表示せずスケルトンを表示する', () => {
        configureHookState({ ownerKey: GUEST_OWNER_KEY, status: 'loading', prompts: [] });

        const tree = renderSidebar();
        const skeleton = findElement(
            tree,
            element => element.props['aria-label'] === 'プロンプト件数を読み込み中',
        );

        expect(getText(tree)).not.toContain('0件のプロンプト');
        expect(skeleton?.props.role).toBe('status');
        expect(skeleton?.props.className).toContain('animate-pulse');
    });

    it('取得成功後だけプロンプト件数を表示する', () => {
        configureHookState({ ownerKey: GUEST_OWNER_KEY, status: 'success', prompts: [prompt] });

        const tree = renderSidebar();

        expect(getText(tree)).toContain('1件のプロンプト');
        expect(findElement(
            tree,
            element => element.props['aria-label'] === 'プロンプト件数を読み込み中',
        )).toBeNull();
    });

    it('初回取得失敗時は0件と確定表示しない', () => {
        configureHookState({ ownerKey: GUEST_OWNER_KEY, status: 'error', prompts: [] });

        const tree = renderSidebar();

        expect(getText(tree)).toContain('プロンプト件数を取得できませんでした');
        expect(getText(tree)).toContain('プロンプト一覧を取得できませんでした');
        expect(getText(tree)).not.toContain('0件のプロンプト');
        expect(getText(tree)).not.toContain('プロンプトがありません');
    });

    it('静かな更新失敗を非遮断で示し、成功済み一覧を表示し続ける', async () => {
        const setters = configureHookState({
            ownerKey: GUEST_OWNER_KEY,
            status: 'success',
            prompts: [prompt],
        });
        mocks.getPrompts
            .mockResolvedValueOnce([prompt])
            .mockRejectedValueOnce(new Error('quiet refresh failed'));
        renderSidebar({ updateTrigger: 1 });

        effects[0]();
        await vi.advanceTimersByTimeAsync(500);
        effects[1]();
        await Promise.resolve();
        await Promise.resolve();

        const warningUpdate = setters[0].mock.calls.at(-1)?.[0];
        expect(typeof warningUpdate).toBe('function');
        expect(warningUpdate({
            ownerKey: GUEST_OWNER_KEY,
            status: 'success',
            prompts: [prompt],
        })).toEqual({
            ownerKey: GUEST_OWNER_KEY,
            status: 'success',
            prompts: [prompt],
            refreshWarning: '最新化失敗：現在のプロンプト一覧を表示しています。',
        });
    });

    it('手動更新中に後発のquiet更新が失敗しても成功済み一覧へ戻して非遮断にする', async () => {
        const setters = configureHookState({
            ownerKey: GUEST_OWNER_KEY,
            status: 'success',
            prompts: [prompt],
        });
        let resolveManualRefresh!: (prompts: Prompt[]) => void;
        mocks.getPrompts
            .mockResolvedValueOnce([prompt])
            .mockReturnValueOnce(new Promise<Prompt[]>(resolve => {
                resolveManualRefresh = resolve;
            }))
            .mockRejectedValueOnce(new Error('quiet refresh failed'));
        const tree = renderSidebar({ updateTrigger: 1 });

        effects[0]();
        await vi.advanceTimersByTimeAsync(500);

        // 手動更新をloading中のまま残し、後発のquiet更新を失敗させる。
        const refreshButton = findElement(
            tree,
            element => element.type === 'button'
                && element.props['aria-label'] === 'プロンプト一覧を更新',
        );
        void (refreshButton?.props as { onClick?: () => Promise<void> }).onClick?.();
        await Promise.resolve();
        effects[1]();
        await vi.advanceTimersByTimeAsync(500);

        const manualLoadingState: TestCollectionState = {
            ownerKey: GUEST_OWNER_KEY,
            status: 'loading',
            prompts: [prompt],
        };
        const resolveUpdate = (update: unknown): TestCollectionState => (
            typeof update === 'function'
                ? (update as (previous: TestCollectionState) => TestCollectionState)(manualLoadingState)
                : update as TestCollectionState
        );

        expect(resolveUpdate(setters[0].mock.calls.at(-1)?.[0])).toEqual({
            ownerKey: GUEST_OWNER_KEY,
            status: 'success',
            prompts: [prompt],
            refreshWarning: '最新化失敗：現在のプロンプト一覧を表示しています。',
        });
        expect(
            setters[0].mock.calls.map(([update]) => resolveUpdate(update).status),
        ).not.toContain('error');

        resolveManualRefresh([prompt]);
        await vi.advanceTimersByTimeAsync(500);
    });

    it('最新化失敗表示と一覧を同時に描画する', () => {
        configureHookState({
            ownerKey: GUEST_OWNER_KEY,
            status: 'success',
            prompts: [prompt],
            refreshWarning: '最新化失敗：現在のプロンプト一覧を表示しています。',
        });

        const tree = renderSidebar();
        const warning = findElement(
            tree,
            element => element.props.role === 'status'
                && getText(element).includes('最新化失敗'),
        );

        expect(getText(tree)).toContain('最新化失敗');
        expect(getText(tree)).toContain('議事録');
        expect(getText(tree)).not.toContain('プロンプト一覧を取得できませんでした');
        expect(warning).not.toBeNull();
    });

    it('後発リクエストがある場合は旧Promiseの成功結果を破棄する', async () => {
        const setters = configureHookState({
            ownerKey: GUEST_OWNER_KEY,
            status: 'loading',
            prompts: [],
        });
        let resolveOlder!: (prompts: Prompt[]) => void;
        let resolveNewer!: (prompts: Prompt[]) => void;
        mocks.getPrompts
            .mockReturnValueOnce(new Promise(resolve => {
                resolveOlder = resolve;
            }))
            .mockReturnValueOnce(new Promise(resolve => {
                resolveNewer = resolve;
            }));
        renderSidebar({ updateTrigger: 1 });

        effects[0]();
        effects[1]();
        resolveNewer([newerPrompt]);
        await Promise.resolve();
        await Promise.resolve();
        resolveOlder([prompt]);
        await Promise.resolve();
        await Promise.resolve();

        expect(setters[0]).toHaveBeenCalledWith({
            ownerKey: GUEST_OWNER_KEY,
            status: 'success',
            prompts: [newerPrompt],
        });
        expect(setters[0]).not.toHaveBeenCalledWith(expect.objectContaining({
            status: 'success',
            prompts: [prompt],
        }));
    });

    it('所有世代終了後に解決したPromiseを破棄する', async () => {
        const setters = configureHookState({
            ownerKey: GUEST_OWNER_KEY,
            status: 'loading',
            prompts: [],
        });
        let resolveRequest!: (prompts: Prompt[]) => void;
        mocks.getPrompts.mockReturnValueOnce(new Promise(resolve => {
            resolveRequest = resolve;
        }));
        renderSidebar();

        const cleanup = effects[0]();
        cleanup?.();
        resolveRequest([prompt]);
        await Promise.resolve();
        await Promise.resolve();

        expect(setters[0]).not.toHaveBeenCalledWith(expect.objectContaining({
            status: 'success',
        }));
    });

    it('初期化待機中に認証主体が変わった場合は固定した旧ownerへ書き込まない', async () => {
        const defaultTemplate = {
            name: '初期プロンプト',
            content: '初期本文',
            model: 'gemini-test',
            thinkingLevel: 'default' as const,
        };
        let resolvePromptExistence!: (snapshot: { exists: () => boolean }) => void;
        mocks.useAuth.mockReturnValue({ user: { uid: 'user-a' }, loading: false });
        mocks.getCurrentUserId.mockReturnValue('user-a');
        mocks.getOwnerType.mockReturnValue('user');
        mocks.getPrompts
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ ...prompt, ownerType: 'user', ownerId: 'user-a' }]);
        mocks.getDocs.mockResolvedValue({ empty: true });
        mocks.getDefaultPrompts.mockResolvedValue([defaultTemplate]);
        mocks.getDoc.mockReturnValue(new Promise(resolve => {
            resolvePromptExistence = resolve;
        }));
        configureHookState({
            ownerKey: USER_A_OWNER_KEY,
            status: 'loading',
            prompts: [],
        });
        renderSidebar();

        effects[0]();
        for (let index = 0; index < 6; index += 1) {
            await Promise.resolve();
        }

        expect(mocks.getDoc).toHaveBeenCalledTimes(1);
        expect(mocks.where).toHaveBeenCalledWith('ownerType', '==', 'user');
        expect(mocks.where).toHaveBeenCalledWith('ownerId', '==', 'user-a');

        mocks.getCurrentUserId.mockReturnValue('user-b');
        resolvePromptExistence({ exists: () => false });
        for (let index = 0; index < 6; index += 1) {
            await Promise.resolve();
        }

        expect(mocks.setDoc).not.toHaveBeenCalled();
        expect(mocks.getOwnerType).toHaveBeenCalled();
        expect(mocks.getCurrentUserId).toHaveBeenCalled();
    });

    it('uidがGUESTのログインユーザーをゲストと同じ世代にしない', () => {
        mocks.useAuth.mockReturnValue({ user: { uid: 'GUEST' }, loading: false });
        const setters = configureHookState({
            ownerKey: GUEST_OWNER_KEY,
            status: 'success',
            prompts: [prompt],
        });

        const tree = renderSidebar();
        effects[0]();

        expect(getText(tree)).not.toContain('1件のプロンプト');
        expect(findElement(
            tree,
            element => element.props['aria-label'] === 'プロンプト件数を読み込み中',
        )).not.toBeNull();
        expect(setters[0]).toHaveBeenCalledWith({
            ownerKey: USER_NAMED_GUEST_OWNER_KEY,
            status: 'loading',
            prompts: [],
        });
    });

    it('新規作成を可視ラベル付き44pxボタンとし、更新も44pxの操作領域にする', () => {
        configureHookState({ ownerKey: GUEST_OWNER_KEY, status: 'success', prompts: [] });

        const tree = renderSidebar();
        const createButton = findElement(
            tree,
            element => element.type === 'button' && getText(element) === '新規プロンプト',
        );
        const refreshButton = findElement(
            tree,
            element => element.type === 'button'
                && element.props['aria-label'] === 'プロンプト一覧を更新',
        );

        expect(createButton?.props.className).toContain('min-h-11');
        expect(refreshButton?.props.className).toContain('min-h-11');
        expect(refreshButton?.props.className).toContain('min-w-11');
    });
});
