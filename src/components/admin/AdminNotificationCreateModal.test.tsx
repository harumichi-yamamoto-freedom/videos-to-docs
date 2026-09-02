// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AdminNotificationCreateModal } from './AdminNotificationCreateModal';

const { createSystemNotification, logError } = vi.hoisted(() => ({
    createSystemNotification: vi.fn(async (): Promise<string> => 'created-id'),
    logError: vi.fn(),
}));

vi.mock('@/lib/systemNotifications', () => ({
    createSystemNotification,
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ user: { uid: 'admin-uid' }, loading: false }),
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: logError }),
}));

const originalShowModal = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'showModal',
);
const originalClose = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'close',
);

function setControlValue(
    control: HTMLInputElement | HTMLTextAreaElement,
    value: string,
): void {
    const prototype = control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    valueSetter?.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 操作可能なボタンだけを掴む（確認パネル表示中の hidden+inert 側を除外）。 */
function findButton(container: HTMLElement, name: string): HTMLButtonElement | null {
    return Array.from(container.querySelectorAll('button')).find(
        candidate => candidate.textContent?.trim() === name
            && !candidate.closest('[inert]'),
    ) ?? null;
}

describe('AdminNotificationCreateModal', () => {
    let container: HTMLDivElement;
    let root: Root;
    let onClose: ReturnType<typeof vi.fn>;
    let onCreated: ReturnType<typeof vi.fn>;
    let confirmSpy: MockInstance<(message?: string) => boolean>;
    let alertSpy: MockInstance<(message?: string) => void>;

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
            globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        createSystemNotification.mockClear();
        createSystemNotification.mockImplementation(async () => 'created-id');
        logError.mockClear();
        onClose = vi.fn();
        onCreated = vi.fn();
        confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        // 破棄確認もエラー表示もダイアログ内で完結する。ネイティブの
        // confirm()/alert() へ退行したらどのテストでもここで落ちる。
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(alertSpy).not.toHaveBeenCalled();
        confirmSpy.mockRestore();
        alertSpy.mockRestore();
    });

    afterAll(() => {
        if (originalShowModal) {
            Object.defineProperty(
                HTMLDialogElement.prototype,
                'showModal',
                originalShowModal,
            );
        } else {
            delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
        }
        if (originalClose) {
            Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
        } else {
            delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
        }
        (
            globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = false;
    });

    async function render(isOpen = true): Promise<void> {
        await act(async () => {
            root.render(
                <AdminNotificationCreateModal
                    isOpen={isOpen}
                    onClose={onClose}
                    onCreated={onCreated}
                />,
            );
        });
    }

    function getDialog(): HTMLDialogElement {
        const dialog = container.querySelector('dialog');
        if (!dialog) throw new Error('dialog not found');
        return dialog;
    }

    async function fillDraft(): Promise<void> {
        const input = container.querySelector<HTMLInputElement>('input[type="text"]');
        const textarea = container.querySelector('textarea');
        if (!input || !textarea) throw new Error('draft fields not found');

        await act(async () => {
            setControlValue(input, '障害のお知らせ');
            setControlValue(textarea, '一部機能が停止しています。');
        });
    }

    async function dispatchCancel(): Promise<void> {
        const dialog = getDialog();
        await act(async () => {
            dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
        });
    }

    it('isOpenのときネイティブdialogをモーダルとして開き見出しと結ぶ', async () => {
        await render();

        const dialog = getDialog();
        expect(dialog.open).toBe(true);
        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');

        const labelledBy = dialog.getAttribute('aria-labelledby');
        expect(labelledBy).toBeTruthy();
        const heading = document.getElementById(labelledBy!);
        expect(heading?.tagName).toBe('H2');
        expect(heading?.textContent).toBe('新しいお知らせを作成');
    });

    it('isOpen=falseにするとdialogは閉じるがonCloseは呼ばれない', async () => {
        await render();
        await render(false);

        expect(getDialog().open).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('下書きが無いときEscで確認パネルを出さずに閉じる', async () => {
        await render();
        await dispatchCancel();

        expect(container.textContent).not.toContain('入力内容を破棄しますか？');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('下書きがあるときEscはダイアログ内の破棄確認パネルを出し、閉じない', async () => {
        await render();
        await fillDraft();

        await dispatchCancel();

        const dialog = getDialog();
        expect(dialog.getAttribute('role')).toBe('alertdialog');
        expect(container.textContent).toContain('入力内容を破棄しますか？');
        expect(container.textContent).toContain('閉じると、入力したお知らせは失われます。');
        expect(onClose).not.toHaveBeenCalled();

        // 確認パネルの安全な選択肢へ初期フォーカスが移る。
        const keepButton = findButton(container, '入力を続ける');
        expect(keepButton).not.toBeNull();
        expect(document.activeElement).toBe(keepButton);

        // 確認パネルが見えている間、背後のフォームは操作から外れる。
        const hiddenForm = container.querySelector('[inert]');
        expect(hiddenForm?.getAttribute('aria-hidden')).toBe('true');
    });

    it('破棄確認で「入力を続ける」を選ぶとパネルが畳まれ、下書きが残る', async () => {
        await render();
        await fillDraft();
        await dispatchCancel();

        const keepButton = findButton(container, '入力を続ける');
        await act(async () => {
            keepButton!.click();
        });

        expect(getDialog().getAttribute('role')).toBe('dialog');
        expect(container.textContent).not.toContain('入力内容を破棄しますか？');
        expect(onClose).not.toHaveBeenCalled();
        const input = container.querySelector<HTMLInputElement>('input[type="text"]');
        expect(input?.value).toBe('障害のお知らせ');
    });

    it('破棄確認中のEscは確認だけを畳み、フォームへ戻す（閉じない）', async () => {
        await render();
        await fillDraft();
        await dispatchCancel();
        expect(container.textContent).toContain('入力内容を破棄しますか？');

        await dispatchCancel();

        expect(container.textContent).not.toContain('入力内容を破棄しますか？');
        expect(onClose).not.toHaveBeenCalled();
        const input = container.querySelector<HTMLInputElement>('input[type="text"]');
        expect(input?.value).toBe('障害のお知らせ');
    });

    it('破棄確認で破棄を選ぶと閉じる', async () => {
        await render();
        await fillDraft();
        await dispatchCancel();

        const discardButton = findButton(container, '入力内容を破棄して閉じる');
        await act(async () => {
            discardButton!.click();
        });

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('作成失敗はダイアログ内のrole=alertで伝え、入力を保持して閉じない', async () => {
        createSystemNotification.mockRejectedValueOnce(new Error('unavailable'));

        await render();
        await fillDraft();

        const publishButton = findButton(container, '公開');
        await act(async () => {
            publishButton!.click();
        });

        const alert = container.querySelector('[role="alert"]');
        expect(alert?.textContent).toContain('お知らせを作成できませんでした。');
        expect(alert?.textContent).toContain('入力内容は保持されています。');
        expect(onClose).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();
        const input = container.querySelector<HTMLInputElement>('input[type="text"]');
        expect(input?.value).toBe('障害のお知らせ');
        expect(logError).toHaveBeenCalledTimes(1);

        // 入力し直すと古いエラーは消える。
        await act(async () => {
            setControlValue(input!, '復旧のお知らせ');
        });
        expect(container.querySelector('[role="alert"]')).toBeNull();
    });

    it('公開処理中はEscで閉じない', async () => {
        let resolveCreate: (id: string) => void = () => undefined;
        createSystemNotification.mockImplementationOnce(
            () => new Promise<string>(resolve => { resolveCreate = resolve; }),
        );

        await render();
        await fillDraft();

        const publishButton = findButton(container, '公開');
        expect(publishButton).not.toBeNull();
        await act(async () => {
            publishButton!.click();
        });

        expect(container.textContent).toContain('公開中...');
        expect(getDialog().getAttribute('aria-busy')).toBe('true');

        await dispatchCancel();

        expect(confirmSpy).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        await act(async () => {
            resolveCreate('created-id');
        });
        expect(onCreated).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('ヘッダーの閉じるボタンで onClose が1回だけ呼ばれる', async () => {
        await render();
        const closeButton = container.querySelector<HTMLButtonElement>(
            'button[aria-label="閉じる"]',
        );
        expect(closeButton).not.toBeNull();

        await act(async () => {
            closeButton!.click();
        });

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('ヘッダーの閉じるボタンが44pxのタップ標的を満たす', async () => {
        await render();
        const closeButton = container.querySelector<HTMLButtonElement>(
            'button[aria-label="閉じる"]',
        );

        expect(closeButton?.classList.contains('min-h-11')).toBe(true);
        expect(closeButton?.classList.contains('min-w-11')).toBe(true);
    });
});
