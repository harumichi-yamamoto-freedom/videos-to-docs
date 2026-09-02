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

/**
 * 操作可能なボタンだけを掴む。確認パネル表示中は背後のフォームが
 * hidden+inert で DOM に残るため、文言一致だけだと DOM 先頭の
 * 不活性ボタン（例: 編集フッターのキャンセル）を掴んで検査が空振りする。
 */
function findButton(container: HTMLElement, name: string): HTMLButtonElement | null {
    return Array.from(container.querySelectorAll('button')).find(
        candidate => candidate.textContent?.trim() === name
            && !candidate.closest('[inert]'),
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
        // 確認も結果表示もダイアログ内で完結する。ネイティブの confirm()/alert()
        // へ退行したらどのテストでもここで落ちる。
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
        expect(container.textContent).not.toContain('未保存の変更があります');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('表示モードのEscは確認パネルを出さずに閉じる', async () => {
        await render();
        await dispatchCancel();

        expect(container.textContent).not.toContain('未保存の変更があります');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('編集モードで未保存の変更があるEscはダイアログ内の破棄確認を出し、閉じない', async () => {
        await render();
        await switchToEditMode();
        await editBody('本文を書き換えました。');

        await dispatchCancel();

        const dialog = getDialog();
        expect(dialog.getAttribute('role')).toBe('alertdialog');
        expect(container.textContent).toContain('未保存の変更があります');
        expect(container.textContent).toContain('閉じると、保存していない変更は失われます。');
        expect(onClose).not.toHaveBeenCalled();

        // 安全な選択肢へ初期フォーカスが移り、背後の編集フォームは操作から外れる。
        const keepButton = findButton(container, '編集を続ける');
        expect(document.activeElement).toBe(keepButton);
        expect(container.querySelector('[inert]')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('破棄確認で「編集を続ける」を選ぶと編集内容が残ったまま戻る', async () => {
        await render();
        await switchToEditMode();
        await editBody('本文を書き換えました。');
        await dispatchCancel();

        const keepButton = findButton(container, '編集を続ける');
        await act(async () => {
            keepButton!.click();
        });

        expect(getDialog().getAttribute('role')).toBe('dialog');
        expect(onClose).not.toHaveBeenCalled();
        expect(container.querySelector('textarea')?.value).toBe('本文を書き換えました。');
    });

    it('破棄確認中のEscは確認だけを畳み、編集フォームへ戻す（閉じない）', async () => {
        await render();
        await switchToEditMode();
        await editBody('本文を書き換えました。');
        await dispatchCancel();
        expect(container.textContent).toContain('未保存の変更があります');

        await dispatchCancel();

        expect(container.textContent).not.toContain('未保存の変更があります');
        expect(onClose).not.toHaveBeenCalled();
        expect(container.querySelector('textarea')?.value).toBe('本文を書き換えました。');
    });

    it('破棄確認で破棄を選ぶと閉じる', async () => {
        await render();
        await switchToEditMode();
        await editBody('本文を書き換えました。');
        await dispatchCancel();

        const discardButton = findButton(container, '変更を破棄して閉じる');
        await act(async () => {
            discardButton!.click();
        });

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('削除はダイアログ内で対象名を含む確認を出し、承諾で削除して閉じる', async () => {
        await render();

        const deleteButton = findButton(container, '削除');
        await act(async () => {
            deleteButton!.click();
        });

        expect(deleteSystemNotification).not.toHaveBeenCalled();
        expect(getDialog().getAttribute('role')).toBe('alertdialog');
        expect(container.textContent).toContain('「メンテナンスのお知らせ」を削除しますか？');
        expect(container.textContent).toContain('削除したお知らせは元に戻せません。');

        const confirmButton = findButton(container, '削除する');
        await act(async () => {
            confirmButton!.click();
        });

        expect(deleteSystemNotification).toHaveBeenCalledWith(NOTIFICATION.id);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('削除確認をキャンセルすると削除せずに一覧表示へ戻る', async () => {
        await render();

        await act(async () => {
            const deleteButton = findButton(container, '削除')!;
            // 実ブラウザではクリックでフォーカスも移る。jsdom は click で
            // フォーカスを動かさないため、明示して同じ状況を作る。
            deleteButton.focus();
            deleteButton.click();
        });
        await act(async () => {
            findButton(container, 'キャンセル')!.click();
        });

        expect(deleteSystemNotification).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(getDialog().getAttribute('role')).toBe('dialog');
        // フォーカスは確認を開いた削除ボタンへ戻る。
        expect(document.activeElement).toBe(findButton(container, '削除'));
    });

    it('公開状態の変更を伴う保存はダイアログ内の確認を経由する', async () => {
        await render();
        await switchToEditMode();

        const publishedCheckbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
        expect(publishedCheckbox?.checked).toBe(true);
        await act(async () => {
            publishedCheckbox!.click();
        });

        await act(async () => {
            findButton(container, '保存')!.click();
        });

        expect(updateSystemNotification).not.toHaveBeenCalled();
        expect(getDialog().getAttribute('role')).toBe('alertdialog');
        expect(container.textContent).toContain('このお知らせを非公開（下書き）にしますか？');
        expect(container.textContent).toContain('既に閲覧したユーザーの既読状態はそのまま残ります');

        await act(async () => {
            findButton(container, '非公開にして保存する')!.click();
        });

        expect(updateSystemNotification).toHaveBeenCalledWith(NOTIFICATION.id, {
            title: NOTIFICATION.title,
            body: NOTIFICATION.body,
            severity: NOTIFICATION.severity,
            published: false,
        });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('公開状態変更の確認をキャンセルすると保存せず、パネルを畳んで編集へ戻る', async () => {
        await render();
        await switchToEditMode();
        await act(async () => {
            container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
        });

        await act(async () => {
            findButton(container, '保存')!.click();
        });
        expect(getDialog().getAttribute('role')).toBe('alertdialog');

        const cancelButton = findButton(container, 'キャンセル');
        // 掴んだのが確認パネル側のキャンセルであること（inert なフォーム側でないこと）。
        expect(cancelButton?.closest('[inert]')).toBeNull();
        await act(async () => {
            cancelButton!.click();
        });

        expect(updateSystemNotification).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        // パネルが実際に畳まれ、通常のダイアログへ復帰している。
        expect(getDialog().getAttribute('role')).toBe('dialog');
        expect(container.textContent).not.toContain('このお知らせを非公開（下書き）にしますか？');
        expect(container.textContent).not.toContain('非公開にして保存する');
        // 編集内容（非公開への変更）は保持されている。
        expect(
            container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
        ).toBe(false);
    });

    it('更新失敗はダイアログ内のrole=alertで伝え、編集内容を保持して閉じない', async () => {
        updateSystemNotification.mockRejectedValueOnce(new Error('unavailable'));

        await render();
        await switchToEditMode();
        await editBody('書き換えた本文。');
        await act(async () => {
            findButton(container, '保存')!.click();
        });

        const alert = container.querySelector('[role="alert"]');
        expect(alert?.textContent).toContain('お知らせを更新できませんでした。');
        expect(alert?.textContent).toContain('編集内容は保持されています。');
        expect(onClose).not.toHaveBeenCalled();
        expect(container.querySelector('textarea')?.value).toBe('書き換えた本文。');
        expect(logError).toHaveBeenCalledTimes(1);
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
