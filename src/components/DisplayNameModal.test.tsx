// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import DisplayNameModal from './DisplayNameModal';

const { updateUserDisplayName } = vi.hoisted(() => ({
    updateUserDisplayName: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('@/lib/firebase', () => ({
    auth: { currentUser: { uid: 'user-id', displayName: '保存済みの表示名' } },
}));

vi.mock('@/lib/auth', () => ({ updateUserDisplayName }));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const originalShowModal = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'showModal',
);
const originalClose = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'close',
);

function setInputValue(input: HTMLInputElement, value: string): void {
    const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
    )?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function findButton(container: HTMLElement, name: string): HTMLButtonElement | null {
    return Array.from(container.querySelectorAll('button')).find(
        candidate => candidate.textContent?.trim() === name,
    ) ?? null;
}

describe('DisplayNameModal', () => {
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
            globalThis as typeof globalThis & {
                IS_REACT_ACT_ENVIRONMENT?: boolean;
            }
        ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(async () => {
        updateUserDisplayName.mockClear();
        updateUserDisplayName.mockImplementation(async () => undefined);
        onClose = vi.fn();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        await act(async () => {
            root.render(<DisplayNameModal isOpen onClose={onClose} />);
        });
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
            globalThis as typeof globalThis & {
                IS_REACT_ACT_ENVIRONMENT?: boolean;
            }
        ).IS_REACT_ACT_ENVIRONMENT = false;
    });

    function dialogElement(): HTMLDialogElement {
        const dialog = container.querySelector('dialog');
        if (!dialog) throw new Error('dialog not found');
        return dialog;
    }

    function nameInput(): HTMLInputElement {
        const input = container.querySelector<HTMLInputElement>('input[type="text"]');
        if (!input) throw new Error('display name input not found');
        return input;
    }

    async function submitForm(): Promise<void> {
        const form = container.querySelector('form');
        if (!form) throw new Error('form not found');

        await act(async () => {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
    }

    it('native dialogをmodalとして開き、見出しでラベル付けする', () => {
        const dialog = dialogElement();
        expect(dialog.open).toBe(true);
        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');

        const labelledBy = dialog.getAttribute('aria-labelledby');
        expect(labelledBy).toBeTruthy();
        const heading = document.getElementById(labelledBy!);
        expect(heading).not.toBeNull();
        expect(dialog.contains(heading)).toBe(true);
        expect(heading?.tagName).toBe('H2');
        expect(heading?.textContent).toBe('表示名を編集');

        // 自前のオーバーレイdivを残していないこと（backdropはDialogが持つ）。
        expect(container.querySelector('div.fixed.inset-0')).toBeNull();
    });

    it('開いたときに現在の表示名を読み込み、入力欄へ初期フォーカスする', () => {
        const input = nameInput();
        expect(input.value).toBe('保存済みの表示名');
        expect(document.activeElement).toBe(input);
    });

    it('閉じるボタンは44pxのタップ標的でaria-labelを持ち、押すとonCloseを1回呼ぶ', async () => {
        const closeButton = container.querySelector<HTMLButtonElement>(
            'button[aria-label="閉じる"]',
        );
        expect(closeButton).not.toBeNull();
        expect(closeButton!.classList.contains('min-h-11')).toBe(true);
        expect(closeButton!.classList.contains('min-w-11')).toBe(true);

        await act(async () => {
            closeButton!.click();
        });

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('EscでonCloseを1回呼ぶ', async () => {
        await act(async () => {
            dialogElement().dispatchEvent(new Event('cancel', { cancelable: true }));
        });

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('更新処理中はEscで閉じない', async () => {
        // 決して解決しないPromiseでloading状態に留める。
        updateUserDisplayName.mockImplementation(() => new Promise<void>(() => {}));

        await act(async () => {
            setInputValue(nameInput(), '新しい表示名');
        });
        await act(async () => {
            const form = container.querySelector('form');
            if (!form) throw new Error('form not found');
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });

        expect(findButton(container, '更新中...')).not.toBeNull();

        await act(async () => {
            dialogElement().dispatchEvent(new Event('cancel', { cancelable: true }));
        });

        expect(onClose).not.toHaveBeenCalled();
    });

    it('CTAをblue-700系に保ち、blue-500を使わない', () => {
        const submit = container.querySelector<HTMLButtonElement>(
            'form button[type="submit"]',
        );
        expect(submit).not.toBeNull();
        expect(submit!.classList.contains('bg-blue-700')).toBe(true);
        expect(submit!.classList.contains('hover:bg-blue-800')).toBe(true);
        expect(submit!.classList.contains('bg-blue-500')).toBe(false);
    });

    it('更新成功後はダイアログ内の終端表示に切り替え、再送信できなくする', async () => {
        await act(async () => {
            setInputValue(nameInput(), '  新しい表示名  ');
        });
        await submitForm();

        expect(updateUserDisplayName).toHaveBeenCalledTimes(1);
        expect(updateUserDisplayName).toHaveBeenCalledWith('新しい表示名');

        // 成功はダイアログ内のstatus領域で伝え、フォームは残さない。
        const statusRegion = container.querySelector<HTMLElement>('[role="status"]');
        expect(statusRegion).not.toBeNull();
        expect(statusRegion!.textContent).toContain('表示名を更新しました。');
        expect(document.activeElement).toBe(statusRegion);
        expect(container.querySelector('form')).toBeNull();
        expect(findButton(container, '更新する')).toBeNull();
        expect(container.querySelector('input[type="text"]')).toBeNull();

        // 終端表示のままダイアログは開いており、閉じるのは利用者の操作。
        expect(dialogElement().open).toBe(true);
        expect(onClose).not.toHaveBeenCalled();

        const closePanelButton = findButton(container, '閉じる');
        expect(closePanelButton).not.toBeNull();
        await act(async () => {
            closePanelButton!.click();
        });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('更新に失敗したときは入力を保持したままエラーを表示する', async () => {
        updateUserDisplayName.mockRejectedValueOnce(new Error('ログインしていません'));

        await act(async () => {
            setInputValue(nameInput(), '新しい表示名');
        });
        await submitForm();

        expect(container.querySelector('[role="alert"]')?.textContent).toBe(
            'ログインしていません',
        );
        expect(nameInput().value).toBe('新しい表示名');
        expect(findButton(container, '更新する')).not.toBeNull();
        expect(container.querySelector('[role="status"]')).toBeNull();
    });

    it('isOpen=falseでもDialogはマウントされたまま閉じ、onCloseは呼ばない', async () => {
        await act(async () => {
            root.render(<DisplayNameModal isOpen={false} onClose={onClose} />);
        });

        const dialog = container.querySelector('dialog');
        expect(dialog).not.toBeNull();
        expect(dialog?.open).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
    });
});
