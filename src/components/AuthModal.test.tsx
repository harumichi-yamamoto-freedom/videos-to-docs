// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import AuthModal from './AuthModal';

const { signIn, signUp, signInWithGoogle, logError } = vi.hoisted(() => ({
    signIn: vi.fn(async (): Promise<void> => undefined),
    signUp: vi.fn(async (): Promise<void> => undefined),
    signInWithGoogle: vi.fn(async (): Promise<void> => undefined),
    logError: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    signIn,
    signUp,
    signInWithGoogle,
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

function setInputValue(input: HTMLInputElement, value: string): void {
    const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
    )?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function findButton(container: HTMLElement, name: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll('button')).find(
        candidate => candidate.textContent?.trim() === name,
    );
    if (!button) throw new Error(`button not found: ${name}`);
    return button;
}

function dispatchBackdropPointer(
    dialog: HTMLDialogElement,
    type: 'pointerdown' | 'pointerup',
): void {
    const event = new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX: -1,
        clientY: -1,
    });
    Object.defineProperties(event, {
        isPrimary: { value: true },
        pointerId: { value: 1 },
    });
    dialog.dispatchEvent(event);
}

describe('AuthModal', () => {
    let container: HTMLDivElement;
    let root: Root;
    let onClose: ReturnType<typeof vi.fn>;
    let onSuccess: ReturnType<typeof vi.fn>;

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
                this.removeAttribute('open');
                this.dispatchEvent(new Event('close'));
            },
        });
        (
            globalThis as typeof globalThis & {
                IS_REACT_ACT_ENVIRONMENT?: boolean;
            }
        ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(async () => {
        signIn.mockClear();
        signUp.mockClear();
        signInWithGoogle.mockClear();
        logError.mockClear();
        onClose = vi.fn();
        onSuccess = vi.fn();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        await act(async () => {
            root.render(
                <AuthModal
                    isOpen
                    onClose={onClose}
                    onSuccess={onSuccess}
                />,
            );
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
            Object.defineProperty(
                HTMLDialogElement.prototype,
                'close',
                originalClose,
            );
        } else {
            delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
        }
        (
            globalThis as typeof globalThis & {
                IS_REACT_ACT_ENVIRONMENT?: boolean;
            }
        ).IS_REACT_ACT_ENVIRONMENT = false;
    });

    async function fillSignupForm(): Promise<void> {
        await act(async () => {
            findButton(container, 'アカウント作成').click();
        });

        const displayName = container.querySelector<HTMLInputElement>(
            'input[autocomplete="name"]',
        );
        const email = container.querySelector<HTMLInputElement>('input[type="email"]');
        const password = container.querySelector<HTMLInputElement>('input[type="password"]');
        if (!displayName || !email || !password) throw new Error('auth inputs not found');

        await act(async () => {
            setInputValue(displayName, '資格情報ユーザー');
            setInputValue(email, 'secret@example.com');
            setInputValue(password, 'secret-password');
        });
    }

    async function expectFormCleared(): Promise<void> {
        expect(container.querySelector('h2')?.textContent).toBe('ログイン');
        expect(
            container.querySelector<HTMLInputElement>('input[type="email"]')?.value,
        ).toBe('');
        expect(
            container.querySelector<HTMLInputElement>('input[type="password"]')?.value,
        ).toBe('');
        expect(container.querySelector('input[autocomplete="name"]')).toBeNull();

        await act(async () => {
            findButton(container, 'アカウント作成').click();
        });
        expect(
            container.querySelector<HTMLInputElement>('input[autocomplete="name"]')?.value,
        ).toBe('');
    }

    it.each([
        ['閉じるボタン', (dialog: HTMLDialogElement) => {
            const closeButton = dialog.querySelector<HTMLButtonElement>(
                'button[aria-label="閉じる"]',
            );
            if (!closeButton) throw new Error('close button not found');
            closeButton.click();
        }],
        ['Esc', (dialog: HTMLDialogElement) => {
            dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
        }],
        ['背景クリック', (dialog: HTMLDialogElement) => {
            dialog.getBoundingClientRect = () => ({
                bottom: 100,
                height: 100,
                left: 0,
                right: 100,
                top: 0,
                width: 100,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            });
            dispatchBackdropPointer(dialog, 'pointerdown');
            dispatchBackdropPointer(dialog, 'pointerup');
        }],
    ])('%sで閉じると資格情報とmodeを初期化する', async (_name, dismiss) => {
        await fillSignupForm();
        const dialog = container.querySelector('dialog');
        if (!dialog) throw new Error('dialog not found');

        await act(async () => {
            dismiss(dialog);
        });

        expect(onClose).toHaveBeenCalledTimes(1);
        await expectFormCleared();
    });

    it('親がisOpen=falseに更新するcontrolled closeでもhidden DOMの資格情報を消去する', async () => {
        await fillSignupForm();

        await act(async () => {
            root.render(
                <AuthModal
                    isOpen={false}
                    onClose={onClose}
                    onSuccess={onSuccess}
                />,
            );
        });

        const dialog = container.querySelector('dialog');
        expect(dialog).not.toBeNull();
        expect(dialog?.open).toBe(false);
        expect(container.querySelector('form')).not.toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        await expectFormCleared();
    });

    it('メール認証成功も共通の閉鎖処理で資格情報を消去する', async () => {
        await fillSignupForm();
        const form = container.querySelector('form');
        if (!form) throw new Error('form not found');

        await act(async () => {
            form.dispatchEvent(new Event('submit', {
                bubbles: true,
                cancelable: true,
            }));
            await Promise.resolve();
        });

        expect(signUp).toHaveBeenCalledWith(
            'secret@example.com',
            'secret-password',
            '資格情報ユーザー',
        );
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        await expectFormCleared();
    });

    it('onSuccessがthrowしても認証失敗として表示せず閉鎖と消去を完遂する', async () => {
        onSuccess.mockImplementationOnce(() => {
            throw new Error('success callback failed');
        });
        await fillSignupForm();
        const form = container.querySelector('form');
        if (!form) throw new Error('form not found');

        await act(async () => {
            form.dispatchEvent(new Event('submit', {
                bubbles: true,
                cancelable: true,
            }));
            await Promise.resolve();
        });

        expect(signUp).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(logError).toHaveBeenCalledTimes(1);
        await expectFormCleared();
    });

    it('モード切替は入力済みの資格情報を持ち越さない', async () => {
        await fillSignupForm();

        await act(async () => {
            findButton(container, 'ログイン').click();
        });

        expect(container.querySelector('h2')?.textContent).toBe('ログイン');
        expect(
            container.querySelector<HTMLInputElement>('input[type="email"]')?.value,
        ).toBe('');
        expect(
            container.querySelector<HTMLInputElement>('input[type="password"]')?.value,
        ).toBe('');

        await act(async () => {
            findButton(container, 'アカウント作成').click();
        });
        expect(
            container.querySelector<HTMLInputElement>('input[autocomplete="name"]')?.value,
        ).toBe('');
    });

    it('ログイン欄に入力してから作成へ切り替えてもsignUpへ持ち越さない', async () => {
        const email = container.querySelector<HTMLInputElement>('input[type="email"]');
        const password = container.querySelector<HTMLInputElement>('input[type="password"]');
        if (!email || !password) throw new Error('auth inputs not found');

        await act(async () => {
            setInputValue(email, 'signin@example.com');
            setInputValue(password, 'signin-password');
        });

        await act(async () => {
            findButton(container, 'アカウント作成').click();
        });

        const displayName = container.querySelector<HTMLInputElement>(
            'input[autocomplete="name"]',
        );
        const signupEmail = container.querySelector<HTMLInputElement>('input[type="email"]');
        const signupPassword = container.querySelector<HTMLInputElement>('input[type="password"]');
        if (!displayName || !signupEmail || !signupPassword) {
            throw new Error('signup inputs not found');
        }
        expect(signupEmail.value).toBe('');
        expect(signupPassword.value).toBe('');

        await act(async () => {
            setInputValue(displayName, '新規ユーザー');
            setInputValue(signupEmail, 'signup@example.com');
            setInputValue(signupPassword, 'signup-password');
        });

        const form = container.querySelector('form');
        if (!form) throw new Error('form not found');
        await act(async () => {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            await Promise.resolve();
        });

        expect(signUp).toHaveBeenCalledWith(
            'signup@example.com',
            'signup-password',
            '新規ユーザー',
        );
        expect(signUp).not.toHaveBeenCalledWith(
            expect.anything(),
            'signin-password',
            expect.anything(),
        );
    });

    it('onCloseがthrowしても認証失敗として表示せず記録する', async () => {
        onClose.mockImplementationOnce(() => {
            throw new Error('close handler failed');
        });
        await fillSignupForm();
        const form = container.querySelector('form');
        if (!form) throw new Error('form not found');

        await act(async () => {
            form.dispatchEvent(new Event('submit', {
                bubbles: true,
                cancelable: true,
            }));
            await Promise.resolve();
        });

        expect(signUp).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(logError).toHaveBeenCalledTimes(1);
        await expectFormCleared();
    });

    it('Google認証のonSuccessがthrowしても認証失敗として表示しない', async () => {
        onSuccess.mockImplementationOnce(() => {
            throw new Error('success callback failed');
        });
        await fillSignupForm();

        await act(async () => {
            findButton(container, 'Googleでログイン').click();
            await Promise.resolve();
        });

        expect(signInWithGoogle).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(logError).toHaveBeenCalledTimes(1);
        await expectFormCleared();
    });

    it('Google認証成功も共通の閉鎖処理で入力済み資格情報を消去する', async () => {
        await fillSignupForm();

        await act(async () => {
            findButton(container, 'Googleでログイン').click();
            await Promise.resolve();
        });

        expect(signInWithGoogle).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        await expectFormCleared();
    });
});
