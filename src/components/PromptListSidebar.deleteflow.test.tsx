// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type MockInstance,
} from 'vitest';
import type { Prompt } from '@/lib/prompts';
import { PromptListSidebar } from './PromptListSidebar';

const { addDefaultPrompts, authState, deletePrompt, getDefaultPrompts, getPrompts } = vi.hoisted(() => ({
    addDefaultPrompts: vi.fn(),
    authState: {
        current: { user: { uid: 'owner-id' } as { uid: string } | null, loading: false },
    },
    deletePrompt: vi.fn(),
    getDefaultPrompts: vi.fn(),
    getPrompts: vi.fn(),
}));

vi.mock('@/lib/prompts', () => ({
    addDefaultPrompts,
    deletePrompt,
    getPrompts,
    initializeDefaultPrompts: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => authState.current,
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@/lib/adminSettings', () => ({
    getDefaultPrompts,
}));

vi.mock('./AddDefaultPromptsModal', () => ({
    AddDefaultPromptsModal: () => null,
}));

const prompt: Prompt = {
    id: 'prompt-id',
    name: '削除対象プロンプト',
    content: '本文',
    model: 'default',
    isDefault: false,
    ownerType: 'user',
    ownerId: 'owner-id',
    createdBy: 'owner-id',
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

// jsdomはshowModal/closeを実装していないため、他モーダルテストと同じ最小polyfillを当てる。
const originalShowModal = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'showModal',
);
const originalDialogClose = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'close',
);

function findButton(container: HTMLElement, name: string): HTMLButtonElement | null {
    return Array.from(container.querySelectorAll('button')).find(
        candidate => candidate.textContent?.trim() === name,
    ) ?? null;
}

describe('PromptListSidebar 削除フローとインラインエラー', () => {
    let container: HTMLDivElement;
    let root: Root;
    let onPromptDeleted: ReturnType<typeof vi.fn>;
    let alertSpy: MockInstance<typeof window.alert>;
    let confirmSpy: MockInstance<typeof window.confirm>;

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
        (
            globalThis as typeof globalThis & {
                IS_REACT_ACT_ENVIRONMENT?: boolean;
            }
        ).IS_REACT_ACT_ENVIRONMENT = true;
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
        (
            globalThis as typeof globalThis & {
                IS_REACT_ACT_ENVIRONMENT?: boolean;
            }
        ).IS_REACT_ACT_ENVIRONMENT = false;
    });

    beforeEach(async () => {
        vi.useFakeTimers();
        authState.current = { user: { uid: 'owner-id' }, loading: false };
        addDefaultPrompts.mockReset();
        deletePrompt.mockReset();
        deletePrompt.mockResolvedValue(undefined);
        getDefaultPrompts.mockReset();
        getDefaultPrompts.mockResolvedValue([]);
        getPrompts.mockReset();
        getPrompts.mockResolvedValue([prompt]);
        onPromptDeleted = vi.fn();
        alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => false);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        await act(async () => {
            root.render(
                <PromptListSidebar
                    onPromptClick={vi.fn()}
                    onCreateClick={vi.fn()}
                    onPromptDeleted={onPromptDeleted}
                />,
            );
        });
        await act(async () => {
            await vi.runAllTimersAsync();
        });
    });

    afterEach(async () => {
        // ネイティブダイアログへ退行していないことの全テスト共通の錠。
        expect(alertSpy).not.toHaveBeenCalled();
        expect(confirmSpy).not.toHaveBeenCalled();
        await act(async () => {
            root.unmount();
        });
        container.remove();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    async function openDeleteDialog(): Promise<void> {
        const deleteButton = container.querySelector<HTMLButtonElement>('button[title="削除"]');
        expect(deleteButton).not.toBeNull();
        await act(async () => {
            deleteButton!.click();
        });
    }

    it('削除ボタンは対象名入りの確認ダイアログを開き、確定まで削除しない', async () => {
        await openDeleteDialog();

        const dialog = container.querySelector('dialog[open]');
        expect(dialog).not.toBeNull();
        expect(dialog?.textContent).toContain('「削除対象プロンプト」を削除しますか？');
        expect(dialog?.textContent).toContain('この操作は取り消せません。');
        expect(deletePrompt).not.toHaveBeenCalled();
    });

    it('キャンセルはダイアログを閉じるだけで削除しない', async () => {
        await openDeleteDialog();

        await act(async () => {
            findButton(container, 'キャンセル')!.click();
        });

        expect(container.querySelector('dialog[open]')).toBeNull();
        expect(deletePrompt).not.toHaveBeenCalled();
        expect(container.textContent).toContain('削除対象プロンプト');
    });

    it('削除するで削除を実行し、一覧を静かに更新して親へ通知する', async () => {
        // 0件にすると自動デフォルト生成が走るため、別の1件が残る一覧で削除の反映を見る。
        getPrompts.mockResolvedValueOnce([{
            ...prompt,
            id: 'remaining-prompt-id',
            name: '残りのプロンプト',
        }]);
        await openDeleteDialog();

        await act(async () => {
            findButton(container, '削除する')!.click();
            await vi.runAllTimersAsync();
        });

        expect(deletePrompt).toHaveBeenCalledWith('prompt-id');
        expect(onPromptDeleted).toHaveBeenCalledOnce();
        expect(container.querySelector('dialog[open]')).toBeNull();
        expect(container.textContent).toContain('残りのプロンプト');
        expect(container.textContent).not.toContain('削除対象プロンプト');
    });

    it('削除失敗はダイアログを閉じてインラインエラーで伝え、一覧は保持する', async () => {
        deletePrompt.mockRejectedValueOnce(new Error('delete failed'));
        await openDeleteDialog();

        await act(async () => {
            findButton(container, '削除する')!.click();
            await vi.runAllTimersAsync();
        });

        expect(container.querySelector('dialog[open]')).toBeNull();
        const inlineError = container.querySelector('[role="alert"]');
        expect(inlineError?.textContent)
            .toContain('プロンプトを削除できませんでした。時間をおいて再度お試しください。');
        expect(container.textContent).toContain('削除対象プロンプト');
        expect(onPromptDeleted).not.toHaveBeenCalled();

        await act(async () => {
            container.querySelector<HTMLButtonElement>('button[aria-label="エラーを閉じる"]')!.click();
        });
        expect(container.querySelector('[role="alert"]')).toBeNull();
    });

    it('削除continuationはowner切替を跨いだら何もしない(新ownerの取得を失効させない)', async () => {
        let resolveDelete!: () => void;
        deletePrompt.mockReturnValueOnce(new Promise<void>(resolve => {
            resolveDelete = resolve;
        }));
        await openDeleteDialog();
        await act(async () => {
            findButton(container, '削除する')!.click();
        });

        // 旧ownerの削除が未解決のままownerが切り替わる。
        const promptForNextOwner: Prompt = {
            ...prompt,
            id: 'next-owner-prompt',
            name: '次ownerのプロンプト',
            ownerId: 'owner-2',
        };
        getPrompts.mockResolvedValue([promptForNextOwner]);
        authState.current = { user: { uid: 'owner-2' }, loading: false };
        await act(async () => {
            root.render(
                <PromptListSidebar
                    onPromptClick={vi.fn()}
                    onCreateClick={vi.fn()}
                    onPromptDeleted={onPromptDeleted}
                />,
            );
        });
        await act(async () => {
            await vi.runOnlyPendingTimersAsync();
        });
        expect(container.textContent).toContain('次ownerのプロンプト');
        const fetchCallsBeforeStaleResolve = getPrompts.mock.calls.length;

        await act(async () => {
            resolveDelete();
            await vi.runOnlyPendingTimersAsync();
        });

        // 旧continuationが共有request IDを進めて新ownerの取得を失効させたり、
        // 親へ削除を通知したりしない。
        expect(getPrompts.mock.calls.length).toBe(fetchCallsBeforeStaleResolve);
        expect(onPromptDeleted).not.toHaveBeenCalled();
        expect(container.textContent).toContain('次ownerのプロンプト');
    });

    it('デフォルトプロンプト取得の失敗はインラインエラーで伝える', async () => {
        getDefaultPrompts.mockRejectedValueOnce(new Error('fetch failed'));

        await act(async () => {
            findButton(container, '新規プロンプト')!.click();
        });
        await act(async () => {
            findButton(container, 'テンプレートから追加')!.click();
            await vi.runAllTimersAsync();
        });

        const inlineError = container.querySelector('[role="alert"]');
        expect(inlineError?.textContent)
            .toContain('テンプレートを取得できませんでした。時間をおいて再度お試しください。');
    });
});
