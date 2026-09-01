// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AdminNotificationEditModal } from './AdminNotificationEditModal';
import type { SystemNotification } from '@/lib/systemNotifications';

const { deleteSystemNotification, updateSystemNotification, logError } = vi.hoisted(() => ({
    deleteSystemNotification: vi.fn(async (): Promise<void> => undefined),
    updateSystemNotification: vi.fn(async (): Promise<void> => undefined),
    logError: vi.fn(),
}));

vi.mock('@/lib/systemNotifications', () => ({
    deleteSystemNotification,
    updateSystemNotification,
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: logError }),
}));

const NOTIFICATION: SystemNotification = {
    id: 'notification-1',
    title: 'メンテナンスのお知らせ',
    body: '本日22:00からメンテナンスを実施します。',
    severity: 'info',
    published: true,
    publishedAt: new Date('2026-01-15T10:00:00Z'),
    publishedBy: 'admin-uid',
};

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

describe('AdminNotificationEditModal', () => {
    let container: HTMLDivElement;
    let root: Root;
    let onClose: ReturnType<typeof vi.fn>;
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
        deleteSystemNotification.mockClear();
        deleteSystemNotification.mockImplementation(async () => undefined);
        updateSystemNotification.mockClear();
        updateSystemNotification.mockImplementation(async () => undefined);
        logError.mockClear();
        onClose = vi.fn();
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

    async function render(props: {
        isOpen?: boolean;
        notification?: SystemNotification | null;
    } = {}): Promise<void> {
        const { isOpen = true, notification = NOTIFICATION } = props;

        await act(async () => {
            root.render(
                <AdminNotificationEditModal
                    notification={notification}
                    isOpen={isOpen}
                    onClose={onClose}
                />,
            );
        });
    }

    function getDialog(): HTMLDialogElement {
        const dialog = container.querySelector('dialog');
        if (!dialog) throw new Error('dialog not found');
        return dialog;
    }

    async function dispatchCancel(): Promise<void> {
        const dialog = getDialog();
        await act(async () => {
            dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
        });
    }

    async function switchToEditMode(): Promise<void> {
        const editButton = findButton(container, '編集');
        if (!editButton) throw new Error('edit mode button not found');
        await act(async () => {
            editButton.click();
        });
    }

    async function editBody(value: string): Promise<void> {
        const textarea = container.querySelector('textarea');
        if (!textarea) throw new Error('body textarea not found');
        await act(async () => {
            setControlValue(textarea, value);
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
        expect(heading?.textContent).toBe(NOTIFICATION.title);
    });

    it('編集モードでも aria-labelledby が実在の見出しを指す', async () => {
        await render();
        await switchToEditMode();

        const labelledBy = getDialog().getAttribute('aria-labelledby');
        const heading = document.getElementById(labelledBy!);
        expect(heading).not.toBeNull();
        expect(heading?.tagName).toBe('H2');
        expect(heading?.textContent?.trim()).not.toBe('');
    });

    it('notificationがnullならisOpenでもdialogを開かない', async () => {
        await render({ notification: null });

        expect(getDialog().open).toBe(false);
        expect(container.textContent).toBe('');
    });

    it('通知を渡された状態でマウントされてもドラフトを通知から初期化する', async () => {
        await render();
        await switchToEditMode();

        const titleInput = container.querySelector<HTMLInputElement>('input[type="text"]');
        const bodyTextarea = container.querySelector('textarea');
        expect(titleInput?.value).toBe(NOTIFICATION.title);
        expect(bodyTextarea?.value).toBe(NOTIFICATION.body);

        // 未編集なので破棄の確認は出ずにそのまま閉じられる。
        await dispatchCancel();
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('表示モードのEscは確認せずに閉じる', async () => {
        await render();
        await dispatchCancel();

        expect(confirmSpy).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('編集モードで未保存の変更があるEscは確認を経由し、破棄しないなら閉じない', async () => {
        await render();
        await switchToEditMode();
        await editBody('本文を書き換えました。');
        confirmSpy.mockReturnValue(false);

        await dispatchCancel();

        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(confirmSpy).toHaveBeenCalledWith(
            '保存されていない変更があります。変更を破棄して閉じますか？',
        );
        expect(onClose).not.toHaveBeenCalled();
    });

    it('編集モードで未保存の変更を破棄承諾すればEscで閉じる', async () => {
        await render();
        await switchToEditMode();
        await editBody('本文を書き換えました。');
        confirmSpy.mockReturnValue(true);

        await dispatchCancel();

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('保存処理中はEscで閉じない', async () => {
        let resolveUpdate: () => void = () => undefined;
        updateSystemNotification.mockImplementationOnce(
            () => new Promise<void>(resolve => { resolveUpdate = resolve; }),
        );

        await render();
        await switchToEditMode();
        await editBody('本文を書き換えました。');

        const saveButton = findButton(container, '保存');
        expect(saveButton).not.toBeNull();
        await act(async () => {
            saveButton!.click();
        });

        expect(updateSystemNotification).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('保存中...');
        expect(getDialog().getAttribute('aria-busy')).toBe('true');

        confirmSpy.mockClear();
        await dispatchCancel();

        expect(confirmSpy).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        await act(async () => {
            resolveUpdate();
        });
        expect(getDialog().getAttribute('aria-busy')).toBeNull();
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
