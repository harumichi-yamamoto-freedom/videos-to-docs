// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prompt } from '@/lib/prompts';
import { requestGuardedAction } from '@/hooks/useNavigationGuard';

/**
 * S2-2: 処理中 (実行中ジョブ or 保存待ち下書き) の離脱ガード。
 * 文書画面の未保存ガードのテストと同じ作法で、beforeunload / SPA内クリック / history.back /
 * ログアウト意図の 4 経路を jsdom で回す。
 */

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalDialogClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    hasActiveJobs: false,
    pendingSaveCount: 0,
    resetProcessing: vi.fn(),
    // ページの認証 effect は user の同一性で発火する。描画ごとに作ると無限に再実行される
    user: { uid: 'user-1' },
}));

vi.mock('next/navigation', () => ({
    usePathname: () => '/home',
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ user: state.user, loading: false }),
}));

// フック戻り値の関数は描画ごとに作り直さない。ページの effect 依存 (clearFiles /
// forceDiscardProcessing) が毎回変わると effect が無限に再実行され、worker が OOM で落ちる
vi.mock('@/hooks/usePromptManagement', () => {
    const promptManagement = {
        data: [],
        availablePrompts: [] as Prompt[],
        status: 'success',
        error: null,
        retry: vi.fn(),
        reloadPrompts: vi.fn(),
        bulkSelectedPromptIds: [],
        toggleBulkPrompt: vi.fn(),
    };
    return { usePromptManagement: () => promptManagement };
});

vi.mock('@/hooks/useFileManagement', () => {
    const fileManagement = {
        selectedFiles: [],
        handleFilesSelected: vi.fn(),
        handleRemoveFile: vi.fn(),
        toggleFilePrompt: vi.fn(),
        clearFiles: vi.fn(),
        cleanupDeletedPrompts: vi.fn(),
    };
    return { useFileManagement: () => fileManagement };
});

vi.mock('@/hooks/useVideoProcessing', () => {
    const stable = {
        processingStatuses: [],
        setProcessingStatuses: vi.fn(),
        isProcessing: false,
        setIsProcessing: vi.fn(),
        ffmpegLoaded: false,
        setFfmpegLoaded: vi.fn(),
        converterRef: { current: null },
        geminiClientRef: { current: null },
        audioConversionQueueRef: { current: false },
        processTranscription: vi.fn(),
        processTranscriptionResume: vi.fn(),
        isCanceling: false,
        claimJob: vi.fn(),
        cancelJob: vi.fn(),
        markJobCanceled: vi.fn(),
        forceDiscardProcessing: vi.fn(),
        countPendingSaves: vi.fn(() => 0),
        pendingSavesForFile: () => state.pendingSaveCount,
        needsRemovalConfirm: () => state.pendingSaveCount > 0,
    };
    return {
        useVideoProcessing: () => ({
            ...stable,
            activeJobIds: state.hasActiveJobs ? ['f1'] : [],
            hasActiveJobs: state.hasActiveJobs,
            pendingSaveCount: state.pendingSaveCount,
            needsDiscardConfirm: state.hasActiveJobs || state.pendingSaveCount > 0,
            resetProcessing: state.resetProcessing,
        }),
    };
});

vi.mock('@/hooks/useProcessingWorkflow', () => {
    const workflow = {
        handleStartProcessing: vi.fn(),
        handleResumeFile: vi.fn(),
        workflowError: null,
        clearWorkflowError: vi.fn(),
        reportWorkflowError: vi.fn(),
    };
    return { useProcessingWorkflow: () => workflow };
});

vi.mock('@/components/FileDropZone', () => ({ FileDropZone: () => <div data-testid="drop-zone" /> }));
vi.mock('@/components/ProcessingStatusList', () => ({ ProcessingStatusList: () => null }));
vi.mock('@/components/BulkPromptSelector', () => ({ BulkPromptSelector: () => null }));
vi.mock('@/components/FilePromptSelector', () => ({ FilePromptSelector: () => null }));
vi.mock('@/components/PromptListSidebar', () => ({ PromptListSidebar: () => null }));
vi.mock('@/components/prompts/PromptModals', () => ({ PromptModals: () => null }));
vi.mock('@/components/NotificationBanner', () => ({ NotificationBanner: () => null }));
vi.mock('@/components/DebugControls', () => ({ DebugControls: () => null }));
vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const HomePage = (await import('./page')).default;

type Mounted = { container: HTMLDivElement; root: Root };
const mountedPages = new Set<Mounted>();

const GUARD_KEY = '__homeProcessingGuard';

function guardRole(): string | undefined {
    const marker = window.history.state?.[GUARD_KEY] as { role?: string } | undefined;
    return marker?.role;
}

function waitForPopStates(count: number): Promise<PopStateEvent[]> {
    return new Promise((resolve, reject) => {
        const events: PopStateEvent[] = [];
        const timeoutId = window.setTimeout(() => {
            window.removeEventListener('popstate', handlePopState);
            reject(new Error(`popstateが${count}回発火しませんでした`));
        }, 1000);
        const handlePopState = (event: PopStateEvent): void => {
            events.push(event);
            if (events.length < count) return;
            window.clearTimeout(timeoutId);
            window.removeEventListener('popstate', handlePopState);
            resolve(events);
        };
        window.addEventListener('popstate', handlePopState);
    });
}

async function mountPage(): Promise<Mounted> {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const mounted = { container, root };
    mountedPages.add(mounted);
    await act(async () => {
        root.render(<HomePage />);
    });
    return mounted;
}

async function rerender(mounted: Mounted): Promise<void> {
    await act(async () => {
        mounted.root.render(<HomePage />);
    });
}

async function unmountPage(mounted: Mounted): Promise<void> {
    if (!mountedPages.delete(mounted)) return;
    const sentinelCleanup = guardRole() === 'sentinel' ? waitForPopStates(1) : null;
    await act(async () => {
        mounted.root.unmount();
    });
    await sentinelCleanup;
    mounted.container.remove();
}

function dialogOf(mounted: Mounted): HTMLDialogElement | null {
    return mounted.container.querySelector('dialog');
}

function buttonByText(mounted: Mounted, label: string): HTMLButtonElement {
    const button = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>('button'))
        .find(element => element.textContent?.trim() === label);
    if (!button) throw new Error(`${label} ボタンがありません`);
    return button;
}

async function click(element: HTMLElement): Promise<void> {
    await act(async () => {
        element.click();
        await Promise.resolve();
    });
}

function dispatchBeforeUnload(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
}

/** 文書画面のテストと同じく、document 直下に SPA 内リンクを置いてクリック監視を試す */
function installInternalLink(): { anchor: HTMLAnchorElement; reached: () => number } {
    const anchor = document.createElement('a');
    anchor.href = '/documents';
    anchor.textContent = '文書へ';
    let reachedCount = 0;
    anchor.addEventListener('click', event => {
        if (!event.defaultPrevented) reachedCount += 1;
        // jsdom の未実装ナビゲーションを起こさない
        event.preventDefault();
    });
    document.body.append(anchor);
    return { anchor, reached: () => reachedCount };
}

async function clickInternalLink(anchor: HTMLAnchorElement): Promise<MouseEvent> {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
        anchor.dispatchEvent(event);
        await Promise.resolve();
    });
    return event;
}

describe('HomePage 離脱ガード (S2-2)', () => {
    beforeAll(() => {
        Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
            configurable: true,
            value(this: HTMLDialogElement) {
                this.setAttribute('open', '');
            },
        });
        Object.defineProperty(HTMLDialogElement.prototype, 'close', {
            configurable: true,
            value(this: HTMLDialogElement) {
                if (!this.open) return;
                this.removeAttribute('open');
                queueMicrotask(() => {
                    this.dispatchEvent(new Event('close'));
                });
            },
        });
    });

    afterAll(() => {
        if (originalShowModal) {
            Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
        } else {
            delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
        }
        if (originalDialogClose) {
            Object.defineProperty(HTMLDialogElement.prototype, 'close', originalDialogClose);
        } else {
            delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
        }
    });

    beforeEach(() => {
        state.hasActiveJobs = false;
        state.pendingSaveCount = 0;
        state.resetProcessing.mockReset().mockResolvedValue('settled');
        Object.defineProperty(window, 'requestAnimationFrame', {
            configurable: true,
            value: vi.fn((callback: FrameRequestCallback) => {
                callback(0);
                return 1;
            }),
        });
        window.history.replaceState(null, '', '/history-far');
        window.history.pushState(null, '', '/history-origin');
        window.history.pushState(null, '', '/home');
    });

    afterEach(async () => {
        for (const mounted of [...mountedPages]) {
            await unmountPage(mounted);
        }
        document.body.replaceChildren();
        vi.restoreAllMocks();
    });

    it('処理中でなければ何も止めない (beforeunload / リンク / ログアウト)', async () => {
        const mounted = await mountPage();
        const link = installInternalLink();

        expect(dispatchBeforeUnload()).toBe(false);
        expect(guardRole()).toBeUndefined();

        const linkClick = await clickInternalLink(link.anchor);
        // 監視は介入していない (preventDefault したのはテスト側のリスナーだけ)
        expect(link.reached()).toBe(1);
        expect(linkClick.defaultPrevented).toBe(true);
        expect(dialogOf(mounted)).toBeNull();

        const proceed = vi.fn();
        requestGuardedAction('signout', proceed);
        expect(proceed).toHaveBeenCalledTimes(1);
        expect(dialogOf(mounted)).toBeNull();
    });

    it('実行中ジョブがある間だけ beforeunload を止め、終わったら解除する', async () => {
        const mounted = await mountPage();
        expect(dispatchBeforeUnload()).toBe(false);

        state.hasActiveJobs = true;
        await rerender(mounted);
        expect(dispatchBeforeUnload()).toBe(true);
        expect(guardRole()).toBe('sentinel');

        state.hasActiveJobs = false;
        const cleanup = waitForPopStates(1);
        await rerender(mounted);
        await cleanup;
        expect(dispatchBeforeUnload()).toBe(false);
        expect(guardRole()).toBeUndefined();
    });

    it('保存待ちの下書きだけでもガードが立ち、件数を示す', async () => {
        state.pendingSaveCount = 2;
        const mounted = await mountPage();
        const link = installInternalLink();

        expect(dispatchBeforeUnload()).toBe(true);
        await clickInternalLink(link.anchor);

        const dialog = dialogOf(mounted);
        expect(dialog?.textContent).toContain('処理中です');
        expect(dialog?.textContent).toContain('移動すると変換・生成結果が失われます。移動しますか？');
        expect(dialog?.textContent).toContain('保存待ちの文書 2 件が失われます');
        expect(link.reached()).toBe(0);
    });

    it('SPA内リンクのクリックを握り、「このページに残る」で留まり「移動する」でクリックを再生する', async () => {
        state.hasActiveJobs = true;
        const mounted = await mountPage();
        const link = installInternalLink();

        const firstClick = await clickInternalLink(link.anchor);
        expect(firstClick.defaultPrevented).toBe(true);
        expect(link.reached()).toBe(0);
        expect(dialogOf(mounted)?.textContent).toContain('移動しますか？');

        await click(buttonByText(mounted, 'このページに残る'));
        expect(dialogOf(mounted)).toBeNull();
        expect(link.reached()).toBe(0);

        await clickInternalLink(link.anchor);
        expect(dialogOf(mounted)).not.toBeNull();
        const replay = waitForPopStates(1);
        await click(buttonByText(mounted, '移動する'));
        await replay;
        await act(async () => {
            await Promise.resolve();
        });

        expect(dialogOf(mounted)).toBeNull();
        // 承認後にだけ、元のリンクへクリックが届く
        expect(link.reached()).toBe(1);
    });

    it('history.back を sentinel で保留し、承認すると本来の離脱をやり直す', async () => {
        state.hasActiveJobs = true;
        const mounted = await mountPage();
        expect(guardRole()).toBe('sentinel');

        const held = waitForPopStates(2);
        await act(async () => {
            window.history.back();
            await held;
        });

        expect(window.location.pathname).toBe('/home');
        expect(guardRole()).toBe('sentinel');
        expect(dialogOf(mounted)?.textContent).toContain('移動しますか？');

        await click(buttonByText(mounted, 'このページに残る'));
        expect(dialogOf(mounted)).toBeNull();
        expect(window.location.pathname).toBe('/home');

        const heldAgain = waitForPopStates(2);
        await act(async () => {
            window.history.back();
            await heldAgain;
        });
        const approved = waitForPopStates(1);
        await click(buttonByText(mounted, '移動する'));
        await approved;

        expect(window.location.pathname).toBe('/history-origin');
        expect(dialogOf(mounted)).toBeNull();
    });

    it('ログアウト意図を止め、「続行する」で初めて実行する', async () => {
        state.hasActiveJobs = true;
        const mounted = await mountPage();

        const proceed = vi.fn();
        await act(async () => {
            requestGuardedAction('signout', proceed);
        });
        expect(proceed).not.toHaveBeenCalled();
        expect(dialogOf(mounted)?.textContent).toContain('続行すると変換・生成結果が失われます');

        await click(buttonByText(mounted, 'このページに残る'));
        expect(proceed).not.toHaveBeenCalled();
        expect(dialogOf(mounted)).toBeNull();

        await act(async () => {
            requestGuardedAction('signout', proceed);
        });
        await click(buttonByText(mounted, '続行する'));
        expect(proceed).toHaveBeenCalledTimes(1);
        expect(dialogOf(mounted)).toBeNull();
    });
});
