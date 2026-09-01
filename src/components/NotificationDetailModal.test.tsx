// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationDetailModal } from './NotificationDetailModal';
import type { SystemNotification } from '@/lib/systemNotifications';

const { dismissNotification, undismissNotification, logError } = vi.hoisted(() => ({
    dismissNotification: vi.fn(async (): Promise<void> => undefined),
    undismissNotification: vi.fn(async (): Promise<void> => undefined),
    logError: vi.fn(),
}));

vi.mock('@/lib/systemNotifications', () => ({
    dismissNotification,
    undismissNotification,
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ user: { uid: 'reader-uid' }, loading: false }),
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

function findButton(container: HTMLElement, name: string): HTMLButtonElement | null {
    return Array.from(container.querySelectorAll('button')).find(
        candidate => candidate.textContent?.trim() === name,
    ) ?? null;
}

describe('NotificationDetailModal', () => {
    let container: HTMLDivElement;
    let root: Root;
    let onClose: ReturnType<typeof vi.fn>;

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
        dismissNotification.mockClear();
        dismissNotification.mockImplementation(async () => undefined);
        undismissNotification.mockClear();
        undismissNotification.mockImplementation(async () => undefined);
        logError.mockClear();
        onClose = vi.fn();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
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
        isDismissed?: boolean;
    } = {}): Promise<void> {
        const {
            isOpen = true,
            notification = NOTIFICATION,
            isDismissed = false,
        } = props;

        await act(async () => {
            root.render(
                <NotificationDetailModal
                    notification={notification}
                    isOpen={isOpen}
                    onClose={onClose}
                    isDismissed={isDismissed}
                />,
            );
        });
    }

    function getDialog(): HTMLDialogElement {
        const dialog = container.querySelector('dialog');
        if (!dialog) throw new Error('dialog not found');
        return dialog;
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
        expect(heading).not.toBeNull();
        expect(container.contains(heading)).toBe(true);
        expect(heading?.tagName).toBe('H2');
        expect(heading?.textContent).toBe(NOTIFICATION.title);
    });

    it('notificationがnullならisOpenでもdialogを開かない', async () => {
        await render({ notification: null });

        expect(getDialog().open).toBe(false);
        expect(container.textContent).toBe('');
    });

    it('Escでキャンセルすると onClose が1回だけ呼ばれる', async () => {
        await render();
        const dialog = getDialog();

        await act(async () => {
            dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
        });

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

    it('開いた瞬間に未読の通知を一度だけ自動dismissする', async () => {
        await render({ isDismissed: false });

        expect(dismissNotification).toHaveBeenCalledTimes(1);
        expect(dismissNotification).toHaveBeenCalledWith('reader-uid', NOTIFICATION.id);
    });

    it('既にdismiss済みなら自動dismissしない', async () => {
        await render({ isDismissed: true });

        expect(dismissNotification).not.toHaveBeenCalled();
    });

    it('未読に戻した後もモーダルを開いたままなら再dismissしない', async () => {
        await render({ isDismissed: false });
        expect(dismissNotification).toHaveBeenCalledTimes(1);

        // 自動 dismiss が反映されて isDismissed=true になる。
        await render({ isDismissed: true });
        expect(dismissNotification).toHaveBeenCalledTimes(1);

        // 「未読に戻す」で isDismissed=false へ戻っても再 dismiss してはいけない。
        await render({ isDismissed: false });
        expect(dismissNotification).toHaveBeenCalledTimes(1);
    });

    it('未読に戻すボタンで undismissNotification を呼ぶ', async () => {
        await render({ isDismissed: true });
        const undismissButton = findButton(container, '未読に戻す');
        expect(undismissButton).not.toBeNull();

        await act(async () => {
            undismissButton!.click();
        });

        expect(undismissNotification).toHaveBeenCalledTimes(1);
        expect(undismissNotification).toHaveBeenCalledWith('reader-uid', NOTIFICATION.id);
    });
});
