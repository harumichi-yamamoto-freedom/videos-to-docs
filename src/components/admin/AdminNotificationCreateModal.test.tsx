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

function findButton(container: HTMLElement, name: string): HTMLButtonElement | null {
    return Array.from(container.querySelectorAll('button')).find(
        candidate => candidate.textContent?.trim() === name,
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

    it('下書きが無いときEscで確認せずに閉じる', async () => {
        await render();
        await dispatchCancel();

        expect(confirmSpy).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('下書きがあるときEscは確認を経由し、破棄しないなら閉じない', async () => {
        await render();
        await fillDraft();
        confirmSpy.mockReturnValue(false);

        await dispatchCancel();

        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(confirmSpy).toHaveBeenCalledWith('入力内容が破棄されます。閉じますか？');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('下書きがあるときEscで破棄を承諾すれば閉じる', async () => {
        await render();
        await fillDraft();
        confirmSpy.mockReturnValue(true);

        await dispatchCancel();

        expect(onClose).toHaveBeenCalledTimes(1);
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
