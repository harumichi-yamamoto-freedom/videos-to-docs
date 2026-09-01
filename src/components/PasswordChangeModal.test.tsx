// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import PasswordChangeModal from './PasswordChangeModal';

const {
    logAudit,
    logError,
    reauthenticateWithCredential,
    updatePassword,
} = vi.hoisted(() => ({
    logAudit: vi.fn(async (): Promise<void> => undefined),
    logError: vi.fn(),
    reauthenticateWithCredential: vi.fn(async (): Promise<void> => undefined),
    updatePassword: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('firebase/auth', () => ({
    EmailAuthProvider: { credential: vi.fn(() => ({ providerId: 'password' })) },
    reauthenticateWithCredential,
    updatePassword,
}));

vi.mock('@/lib/firebase', () => ({
    auth: { currentUser: { uid: 'user-id', email: 'user@example.com' } },
}));

vi.mock('@/lib/auditLog', () => ({ logAudit }));

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

describe('PasswordChangeModal', () => {
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
        logAudit.mockClear();
        logAudit.mockImplementation(async () => undefined);
        logError.mockClear();
        reauthenticateWithCredential.mockClear();
        reauthenticateWithCredential.mockImplementation(async () => undefined);
        updatePassword.mockClear();
        updatePassword.mockImplementation(async () => undefined);
        onClose = vi.fn();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        await act(async () => {
            root.render(<PasswordChangeModal isOpen onClose={onClose} />);
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

    function passwordInputs(): HTMLInputElement[] {
        return Array.from(
            container.querySelectorAll<HTMLInputElement>('input[type="password"]'),
        );
    }

    async function fillPasswords(): Promise<void> {
        const inputs = passwordInputs();
        if (inputs.length !== 3) throw new Error('password inputs not found');

        await act(async () => {
            setInputValue(inputs[0], 'current-secret');
            setInputValue(inputs[1], 'new-secret');
            setInputValue(inputs[2], 'new-secret');
        });
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

    it('親がisOpen=falseに更新するcontrolled closeでもhidden DOMのパスワードを消去する', async () => {
        await fillPasswords();
        expect(passwordInputs().map(input => input.value)).toEqual([
            'current-secret',
            'new-secret',
            'new-secret',
        ]);

        await act(async () => {
            root.render(<PasswordChangeModal isOpen={false} onClose={onClose} />);
        });

        const dialog = container.querySelector('dialog');
        expect(dialog).not.toBeNull();
        expect(dialog?.open).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        expect(passwordInputs()).toHaveLength(3);
        expect(passwordInputs().map(input => input.value)).toEqual(['', '', '']);
    });

    it('変更成功後にlogAuditが失敗しても成功として扱い記録のみの失敗を伝える', async () => {
        logAudit.mockRejectedValueOnce(new Error('audit write failed'));
        await fillPasswords();
        await submitForm();

        expect(updatePassword).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('パスワードを変更しました。');
        expect(container.textContent).toContain('変更履歴の記録には失敗しました。');
        expect(container.textContent).not.toContain('パスワードの変更に失敗しました。');
        expect(logError).toHaveBeenCalledTimes(1);

        // No form and no submit CTA: the succeeded change cannot be retried.
        expect(container.querySelector('form')).toBeNull();
        expect(findButton(container, '変更する')).toBeNull();
        expect(passwordInputs()).toHaveLength(0);

        // Both the result and the caveat live in the focused status region.
        const statusRegion = container.querySelector<HTMLElement>('[role="status"]');
        expect(document.activeElement).toBe(statusRegion);
        expect(statusRegion?.textContent).toContain('変更履歴の記録には失敗しました。');
    });

    it('変更もlogAuditも成功したときは記録失敗の注意を出さない', async () => {
        await fillPasswords();
        await submitForm();

        expect(updatePassword).toHaveBeenCalledTimes(1);
        expect(logAudit).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('パスワードを変更しました。');
        expect(container.textContent).not.toContain('変更履歴の記録には失敗しました。');
        expect(container.querySelector('form')).toBeNull();
    });

    it('再認証に失敗したときは入力を保持したままエラーを表示する', async () => {
        reauthenticateWithCredential.mockRejectedValueOnce({
            code: 'auth/wrong-password',
        });
        await fillPasswords();
        await submitForm();

        expect(updatePassword).not.toHaveBeenCalled();
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(
            '現在のパスワードが正しくありません。',
        );
        expect(passwordInputs().map(input => input.value)).toEqual([
            'current-secret',
            'new-secret',
            'new-secret',
        ]);
        expect(findButton(container, '変更する')).not.toBeNull();
    });
});
