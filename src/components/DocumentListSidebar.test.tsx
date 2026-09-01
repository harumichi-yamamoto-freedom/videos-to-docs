import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getTranscriptions: vi.fn(),
    deleteTranscription: vi.fn(),
    updateTranscriptionTitle: vi.fn(),
    useAuth: vi.fn(),
    useCallback: vi.fn(),
    useId: vi.fn(),
    useLayoutEffect: vi.fn(),
    useMemo: vi.fn(),
    useRef: vi.fn(),
    useState: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return {
        ...actual,
        useCallback: mocks.useCallback,
        useId: mocks.useId,
        useLayoutEffect: mocks.useLayoutEffect,
        useMemo: mocks.useMemo,
        useRef: mocks.useRef,
        useState: mocks.useState,
    };
});

vi.mock('@/hooks/useAuth', () => ({
    useAuth: mocks.useAuth,
}));

vi.mock('@/lib/firestore', () => ({
    getTranscriptions: mocks.getTranscriptions,
    deleteTranscription: mocks.deleteTranscription,
    updateTranscriptionTitle: mocks.updateTranscriptionTitle,
}));

vi.mock('@/lib/logger', () => ({
    createLogger: vi.fn(() => ({
        error: vi.fn(),
    })),
}));

import {
    DocumentListSidebar,
    DocumentListStatus,
} from './DocumentListSidebar';
import type { Transcription } from '@/lib/firestore';

interface TestCollectionState {
    subjectKey: string | null;
    status: DocumentListStatus;
    documents: Transcription[];
}

type LayoutEffect = () => void | (() => void);

const documentFixture: Transcription = {
    id: 'document-a',
    title: '文書A',
    fileName: 'recording.wav',
    text: '本文',
    promptName: '議事録',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T01:00:00Z'),
};

const userSubjectKey = JSON.stringify(['user', 'user-a']);

function configureHookState(
    collectionState: TestCollectionState,
    stateOverrides: Record<number, unknown> = {},
) {
    let stateIndex = 0;
    const setters: ReturnType<typeof vi.fn>[] = [];

    mocks.useState.mockImplementation((initialValue: unknown) => {
        const index = stateIndex++;
        const setter = vi.fn();
        setters[index] = setter;
        const value = index === 0
            ? collectionState
            : index in stateOverrides
                ? stateOverrides[index]
                : typeof initialValue === 'function'
                    ? (initialValue as () => unknown)()
                    : initialValue;
        return [value, setter];
    });

    return setters;
}

function useDocumentsRef(documents: Transcription[]) {
    let refIndex = 0;
    mocks.useRef.mockImplementation((initialValue: unknown) => ({
        current: refIndex++ === 3 ? documents : initialValue,
    }));
}

function findElement(
    node: React.ReactNode,
    predicate: (props: Record<string, unknown>) => boolean,
): React.ReactElement<Record<string, unknown>> | undefined {
    if (Array.isArray(node)) {
        for (const child of node) {
            const match = findElement(child, predicate);
            if (match) return match;
        }
        return undefined;
    }

    if (!React.isValidElement<Record<string, unknown>>(node)) return undefined;
    if (predicate(node.props)) return node;
    return findElement(node.props.children as React.ReactNode, predicate);
}

function renderSidebar(props: Partial<React.ComponentProps<typeof DocumentListSidebar>> = {}) {
    return renderToStaticMarkup(
        <DocumentListSidebar
            onDocumentClick={vi.fn()}
            {...props}
        />,
    );
}

describe('DocumentListSidebar', () => {
    let layoutEffects: LayoutEffect[];

    beforeEach(() => {
        vi.clearAllMocks();
        layoutEffects = [];
        mocks.useLayoutEffect.mockImplementation((effect: LayoutEffect) => {
            layoutEffects.push(effect);
        });
        mocks.useCallback.mockImplementation((callback: unknown) => callback);
        mocks.useId.mockReturnValue('document-search-id');
        mocks.useMemo.mockImplementation((factory: () => unknown) => factory());
        mocks.useRef.mockImplementation((initialValue: unknown) => ({ current: initialValue }));
        mocks.useAuth.mockReturnValue({
            user: { uid: 'user-a' },
            loading: false,
        });
        mocks.getTranscriptions.mockResolvedValue([]);
        vi.stubGlobal('window', {
            setInterval: vi.fn(() => 1),
            clearInterval: vi.fn(),
            requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
                callback(0);
                return 1;
            }),
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('認証初期化中は未確定の0件を表示せず件数スケルトンを表示する', () => {
        mocks.useAuth.mockReturnValue({ user: null, loading: true });
        configureHookState({ subjectKey: null, status: 'loading', documents: [] });

        const markup = renderSidebar();

        expect(markup).toContain('aria-label="文書件数を読み込み中"');
        expect(markup).toContain('aria-label="文書一覧を読み込み中"');
        expect(markup).not.toContain('全0件');
        expect(markup).toContain('文書を検索');
        expect(markup).toContain('placeholder="キーワードを入力"');
    });

    it('取得失敗を空表示と分離する', () => {
        configureHookState({ subjectKey: userSubjectKey, status: 'error', documents: [] });

        const markup = renderSidebar();

        expect(markup).toContain('文書一覧を取得できませんでした');
        expect(markup).not.toContain('文書がまだありません');
        expect(markup).not.toContain('全0件');
    });

    it('成功後だけ件数を表示し、主操作と副操作の入力方式別UI契約を保つ', () => {
        configureHookState({
            subjectKey: userSubjectKey,
            status: 'success',
            documents: [documentFixture],
        });

        const markup = renderSidebar({ selectedDocumentId: documentFixture.id });
        const actionContainer = markup.match(/<div class="([^"]*transition-opacity[^"]*)">/)?.[1];

        expect(markup).toContain('全1件 / 表示1件');
        expect(markup).toContain('aria-label="「文書A」を選択"');
        expect(markup).toContain('aria-current="true"');
        expect(markup).toContain('focus-visible:ring-2');
        expect(actionContainer).toContain('[@media(hover:hover)_and_(pointer:fine)]:opacity-0');
        expect(actionContainer?.split(' ')).not.toContain('opacity-0');
        expect(markup.match(/min-w-11 min-h-11/g)?.length).toBeGreaterThanOrEqual(4);
    });

    it('未保存変更がある選択中文書は削除ボタンからdirty専用確認を経て削除する', async () => {
        const initialSetters = configureHookState({
            subjectKey: userSubjectKey,
            status: 'success',
            documents: [documentFixture],
        });
        const initialTree = DocumentListSidebar({
            onDocumentClick: vi.fn(),
            selectedDocumentId: documentFixture.id,
            isSelectedDocumentDirty: true,
        }) as React.ReactNode;
        const requestDeleteButton = findElement(
            initialTree,
            props => props['aria-label'] === '「文書A」を削除',
        );

        (requestDeleteButton?.props.onClick as (() => void) | undefined)?.();

        expect(initialSetters[4]).toHaveBeenCalledWith(documentFixture.id);
        expect(mocks.deleteTranscription).not.toHaveBeenCalled();

        configureHookState(
            {
                subjectKey: userSubjectKey,
                status: 'success',
                documents: [documentFixture],
            },
            { 4: documentFixture.id },
        );
        useDocumentsRef([documentFixture]);
        mocks.deleteTranscription.mockResolvedValueOnce('deleted');

        const confirmationTree = DocumentListSidebar({
            onDocumentClick: vi.fn(),
            selectedDocumentId: documentFixture.id,
            isSelectedDocumentDirty: true,
        }) as React.ReactNode;
        const confirmation = findElement(
            confirmationTree,
            props => props.role === 'alertdialog',
        );
        const confirmDeleteButton = findElement(
            confirmationTree,
            props => props.children === '削除する',
        );

        expect(confirmation).toBeDefined();
        expect(renderToStaticMarkup(confirmation)).toContain('未保存の変更がある文書を削除しますか');
        expect(renderToStaticMarkup(confirmation)).toContain('この操作は取り消せません。');

        (confirmDeleteButton?.props.onClick as (() => void) | undefined)?.();
        await vi.waitFor(() => expect(mocks.deleteTranscription).toHaveBeenCalledWith(documentFixture.id));
    });

    it('初回取得のrejectをerror状態として通知する', async () => {
        const setters = configureHookState({
            subjectKey: userSubjectKey,
            status: 'loading',
            documents: [],
        });
        const onDocumentsChange = vi.fn();
        const onListStateChange = vi.fn();
        mocks.getTranscriptions.mockRejectedValueOnce(new Error('fetch failed'));
        renderSidebar({ onDocumentsChange, onListStateChange });

        layoutEffects[0]();
        await vi.waitFor(() => {
            expect(onListStateChange).toHaveBeenCalledWith({ status: 'error' });
        });

        expect(onDocumentsChange).toHaveBeenNthCalledWith(1, []);
        const lastCollectionUpdate = setters[0].mock.calls.at(-1)?.[0];
        expect(typeof lastCollectionUpdate).toBe('function');
        expect(lastCollectionUpdate({
            subjectKey: userSubjectKey,
            status: 'loading',
            documents: [],
        })).toMatchObject({ status: 'error', documents: [] });
        expect(onListStateChange).not.toHaveBeenCalledWith(
            expect.objectContaining({ count: expect.any(Number) }),
        );
    });

    it('世代が終了した旧Promiseの結果を破棄する', async () => {
        configureHookState({
            subjectKey: userSubjectKey,
            status: 'loading',
            documents: [],
        });
        const onDocumentsChange = vi.fn();
        const onListStateChange = vi.fn();
        let resolveRequest!: (documents: Transcription[]) => void;
        mocks.getTranscriptions.mockReturnValueOnce(new Promise(resolve => {
            resolveRequest = resolve;
        }));
        renderSidebar({ onDocumentsChange, onListStateChange });

        const cleanup = layoutEffects[0]();
        expect(onDocumentsChange).toHaveBeenCalledWith([]);
        cleanup?.();
        resolveRequest([documentFixture]);
        await Promise.resolve();
        await Promise.resolve();

        expect(onDocumentsChange).toHaveBeenCalledTimes(1);
        expect(onListStateChange).not.toHaveBeenCalledWith({ status: 'success', count: 1 });
    });

    it('世代照合後の成功結果だけを件数付きで通知する', async () => {
        configureHookState({
            subjectKey: userSubjectKey,
            status: 'loading',
            documents: [],
        });
        const onDocumentsChange = vi.fn();
        const onListStateChange = vi.fn();
        mocks.getTranscriptions.mockResolvedValueOnce([documentFixture]);
        renderSidebar({ onDocumentsChange, onListStateChange });

        layoutEffects[0]();
        await vi.waitFor(() => {
            expect(onListStateChange).toHaveBeenCalledWith({ status: 'success', count: 1 });
        });

        expect(mocks.getTranscriptions).toHaveBeenCalledWith(100, {
            ownerId: 'user-a',
            ownerType: 'user',
        });
        expect(onDocumentsChange).toHaveBeenNthCalledWith(1, []);
        expect(onDocumentsChange).toHaveBeenLastCalledWith([documentFixture]);
    });

    it('ログインユーザーのUIDがGUESTでもゲスト所有者と衝突しない', async () => {
        mocks.useAuth.mockReturnValue({
            user: { uid: 'GUEST' },
            loading: false,
        });
        configureHookState({
            subjectKey: JSON.stringify(['user', 'GUEST']),
            status: 'loading',
            documents: [],
        });
        mocks.getTranscriptions.mockResolvedValueOnce([]);
        renderSidebar();

        layoutEffects[0]();
        await vi.waitFor(() => {
            expect(mocks.getTranscriptions).toHaveBeenCalledWith(100, {
                ownerId: 'GUEST',
                ownerType: 'user',
            });
        });
    });

    it('ポーリング結果のIDとupdatedAtが同じなら文書参照を維持する', async () => {
        configureHookState({
            subjectKey: userSubjectKey,
            status: 'loading',
            documents: [],
        });
        const firstDocument = { ...documentFixture };
        const unchangedPollDocument = {
            ...documentFixture,
            updatedAt: new Date('2026-09-01T01:00:00Z'),
        };
        const changedPollDocument = {
            ...documentFixture,
            text: '更新後の本文',
            updatedAt: new Date('2026-09-01T01:00:01Z'),
        };
        mocks.getTranscriptions
            .mockResolvedValueOnce([firstDocument])
            .mockResolvedValueOnce([unchangedPollDocument])
            .mockResolvedValueOnce([changedPollDocument]);
        const onDocumentsChange = vi.fn();
        renderSidebar({ onDocumentsChange });

        layoutEffects[0]();
        await vi.waitFor(() => expect(onDocumentsChange).toHaveBeenCalledTimes(2));
        const publishedFirstDocument = onDocumentsChange.mock.calls[1][0][0];
        const setIntervalMock = window.setInterval as unknown as ReturnType<typeof vi.fn>;
        const poll = setIntervalMock.mock.calls[0][0] as () => void;

        poll();
        await vi.waitFor(() => expect(onDocumentsChange).toHaveBeenCalledTimes(3));
        expect(onDocumentsChange.mock.calls[2][0][0]).toBe(publishedFirstDocument);

        poll();
        await vi.waitFor(() => expect(onDocumentsChange).toHaveBeenCalledTimes(4));
        expect(onDocumentsChange.mock.calls[3][0][0]).toBe(changedPollDocument);
        expect(onDocumentsChange.mock.calls[3][0][0]).not.toBe(publishedFirstDocument);
    });

    it('updatedAtが無いlegacy文書は内容不変なら参照を維持し、本文変更時だけ置き換える', async () => {
        configureHookState({
            subjectKey: userSubjectKey,
            status: 'loading',
            documents: [],
        });
        const firstDocument = { ...documentFixture, updatedAt: undefined };
        const unchangedPollDocument = {
            ...firstDocument,
            createdAt: new Date('2026-09-01T00:00:00Z'),
        };
        const changedPollDocument = {
            ...firstDocument,
            text: 'updatedAtの無い文書の更新後本文',
        };
        mocks.getTranscriptions
            .mockResolvedValueOnce([firstDocument])
            .mockResolvedValueOnce([unchangedPollDocument])
            .mockResolvedValueOnce([changedPollDocument]);
        const onDocumentsChange = vi.fn();
        renderSidebar({ onDocumentsChange });

        layoutEffects[0]();
        await vi.waitFor(() => expect(onDocumentsChange).toHaveBeenCalledTimes(2));
        const publishedFirstDocument = onDocumentsChange.mock.calls[1][0][0];
        const setIntervalMock = window.setInterval as unknown as ReturnType<typeof vi.fn>;
        const poll = setIntervalMock.mock.calls[0][0] as () => void;

        poll();
        await vi.waitFor(() => expect(onDocumentsChange).toHaveBeenCalledTimes(3));
        expect(onDocumentsChange.mock.calls[2][0][0]).toBe(publishedFirstDocument);

        poll();
        await vi.waitFor(() => expect(onDocumentsChange).toHaveBeenCalledTimes(4));
        expect(onDocumentsChange.mock.calls[3][0][0]).toBe(changedPollDocument);
        expect(onDocumentsChange.mock.calls[3][0][0]).not.toBe(publishedFirstDocument);
    });

    it('手動更新中に後発のquiet更新が失敗しても成功済み一覧へ戻して非遮断にする', async () => {
        const setters = configureHookState({
            subjectKey: userSubjectKey,
            status: 'success',
            documents: [documentFixture],
        });
        const onListStateChange = vi.fn();
        mocks.getTranscriptions
            .mockResolvedValueOnce([documentFixture])
            .mockReturnValueOnce(new Promise<Transcription[]>(() => undefined))
            .mockRejectedValueOnce(new Error('external refresh failed'));

        const tree = DocumentListSidebar({
            onDocumentClick: vi.fn(),
            onListStateChange,
            updateTrigger: 1,
        }) as React.ReactNode;
        layoutEffects[0]();
        await vi.waitFor(() => {
            expect(onListStateChange).toHaveBeenCalledWith({ status: 'success', count: 1 });
        });

        const refreshButton = findElement(tree, props => props['aria-label'] === '文書一覧を更新');
        (refreshButton?.props.onClick as (() => void) | undefined)?.();
        layoutEffects[1]();

        await vi.waitFor(() => {
            expect(onListStateChange).toHaveBeenLastCalledWith({ status: 'success', count: 1 });
        });
        expect(onListStateChange).not.toHaveBeenCalledWith({ status: 'error' });

        expect(setters[0]).toHaveBeenLastCalledWith({
            subjectKey: userSubjectKey,
            status: 'success',
            documents: [documentFixture],
            refreshWarning: '最新の文書一覧を取得できませんでした。',
        });
        const recoveredState = setters[0].mock.calls.at(-1)?.[0] as TestCollectionState;
        expect(recoveredState.documents[0]).toBe(documentFixture);
    });

    it('改名成功時はタイトルpatchだけを親へ通知し、一覧由来の本文を伝播しない', async () => {
        const latestDocument = {
            ...documentFixture,
            text: 'ポーリングで更新された本文',
            generatedByModel: 'gemini-latest',
        };
        configureHookState(
            {
                subjectKey: userSubjectKey,
                status: 'success',
                documents: [documentFixture],
            },
            {
                1: documentFixture.id,
                2: '更新後のタイトル',
            },
        );
        useDocumentsRef([latestDocument]);
        const onDocumentUpdated = vi.fn();
        const onDocumentsChange = vi.fn();
        const onListStateChange = vi.fn();
        mocks.updateTranscriptionTitle.mockResolvedValueOnce(undefined);

        const tree = DocumentListSidebar({
            onDocumentClick: vi.fn(),
            onDocumentUpdated,
            onDocumentsChange,
            onListStateChange,
        }) as React.ReactNode;
        const saveButton = findElement(tree, props => props['aria-label'] === 'タイトルを保存');
        (saveButton?.props.onClick as (() => void) | undefined)?.();
        (saveButton?.props.onClick as (() => void) | undefined)?.();

        expect(mocks.updateTranscriptionTitle).toHaveBeenCalledOnce();

        await vi.waitFor(() => {
            expect(onDocumentUpdated).toHaveBeenCalledWith(documentFixture.id, {
                title: '更新後のタイトル',
            });
        });
        expect(onDocumentsChange).not.toHaveBeenCalled();
        expect(onListStateChange).toHaveBeenCalledWith({ status: 'success', count: 1 });
    });

    it('改名中に対象が一覧から消えても成功したタイトルpatchを親へ通知する', async () => {
        configureHookState(
            {
                subjectKey: userSubjectKey,
                status: 'success',
                documents: [documentFixture],
            },
            {
                1: documentFixture.id,
                2: '一覧欠落中の新タイトル',
            },
        );
        useDocumentsRef([]);
        const onDocumentUpdated = vi.fn();
        mocks.updateTranscriptionTitle.mockResolvedValueOnce(undefined);

        const tree = DocumentListSidebar({
            onDocumentClick: vi.fn(),
            onDocumentUpdated,
        }) as React.ReactNode;
        const saveButton = findElement(tree, props => props['aria-label'] === 'タイトルを保存');
        (saveButton?.props.onClick as (() => void) | undefined)?.();

        await vi.waitFor(() => {
            expect(onDocumentUpdated).toHaveBeenCalledWith(documentFixture.id, {
                title: '一覧欠落中の新タイトル',
            });
        });
    });

    it('本体削除成功時は副処理警告の有無にかかわらず削除を親へ通知する', async () => {
        configureHookState(
            {
                subjectKey: userSubjectKey,
                status: 'success',
                documents: [documentFixture],
            },
            {
                4: documentFixture.id,
            },
        );
        useDocumentsRef([documentFixture]);
        const onDocumentDeleted = vi.fn();
        const onDocumentsChange = vi.fn();
        const onListStateChange = vi.fn();
        mocks.deleteTranscription.mockResolvedValueOnce('deletedWithWarning');

        const tree = DocumentListSidebar({
            onDocumentClick: vi.fn(),
            onDocumentDeleted,
            onDocumentsChange,
            onListStateChange,
        }) as React.ReactNode;
        const deleteButton = findElement(tree, props => props.children === '削除する');
        const deleteDialog = findElement(tree, props => props.role === 'alertdialog');
        const cancelButton = findElement(tree, props => props.children === 'キャンセル');

        expect(deleteDialog?.props['aria-labelledby']).toBe('delete-dialog-title-document-a');
        expect(deleteDialog?.props['aria-describedby']).toBe('delete-dialog-description-document-a');
        expect(cancelButton?.props.autoFocus).toBe(true);
        (deleteButton?.props.onClick as (() => void) | undefined)?.();
        (deleteButton?.props.onClick as (() => void) | undefined)?.();

        expect(mocks.deleteTranscription).toHaveBeenCalledOnce();

        await vi.waitFor(() => {
            expect(onDocumentDeleted).toHaveBeenCalledWith(documentFixture.id);
        });
        expect(onDocumentsChange).toHaveBeenCalledWith([]);
        expect(onListStateChange).toHaveBeenCalledWith({ status: 'success', count: 0 });
    });
});
