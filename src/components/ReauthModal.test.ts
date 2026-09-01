// @vitest-environment jsdom

import React, { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hookHarness = vi.hoisted(() => {
    interface EffectSlot {
        cleanup?: () => void;
        deps?: readonly unknown[];
    }

    interface HarnessState {
        stateCursor: number;
        effectCursor: number;
        states: unknown[];
        effects: EffectSlot[];
        pendingEffects: Array<{
            index: number;
            effect: () => void | (() => void);
            deps?: readonly unknown[];
        }>;
    }

    let activeHarness: HarnessState | null = null;

    // The helper-level tests below drive the component function directly with
    // these fake hooks. The mount-level tests render it for real in jsdom, and
    // there no harness is active, so the real hooks have to take over.
    interface ReactHookFallback {
        useState: <T>(initialValue: T | (() => T)) => [T, (value: T) => void];
        useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
    }
    let reactFallback: ReactHookFallback | null = null;
    const setReactFallback = (hooks: ReactHookFallback) => {
        reactFallback = hooks;
    };

    const useState = <T,>(initialValue: T | (() => T)) => {
        if (!activeHarness) {
            if (!reactFallback) throw new Error('React hook fallback was not installed');
            return reactFallback.useState(initialValue);
        }

        const harness = activeHarness;
        const index = harness.stateCursor;
        harness.stateCursor += 1;

        if (!(index in harness.states)) {
            harness.states[index] = typeof initialValue === 'function'
                ? (initialValue as () => T)()
                : initialValue;
        }

        const setValue = (nextValue: T | ((previousValue: T) => T)) => {
            const previousValue = harness.states[index] as T;
            harness.states[index] = typeof nextValue === 'function'
                ? (nextValue as (value: T) => T)(previousValue)
                : nextValue;
        };

        return [harness.states[index] as T, setValue] as const;
    };

    const useEffect = (
        effect: () => void | (() => void),
        deps?: readonly unknown[],
    ) => {
        if (!activeHarness) {
            if (!reactFallback) throw new Error('React hook fallback was not installed');
            reactFallback.useEffect(effect, deps);
            return;
        }

        const index = activeHarness.effectCursor;
        activeHarness.effectCursor += 1;
        const previous = activeHarness.effects[index];
        const changed = !previous
            || deps === undefined
            || previous.deps === undefined
            || deps.length !== previous.deps.length
            || deps.some((dependency, dependencyIndex) => (
                !Object.is(dependency, previous.deps?.[dependencyIndex])
            ));

        if (changed) {
            activeHarness.pendingEffects.push({ index, effect, deps });
        }
    };

    const create = <Props, Result>(component: (props: Props) => Result) => {
        const state: HarnessState = {
            stateCursor: 0,
            effectCursor: 0,
            states: [],
            effects: [],
            pendingEffects: [],
        };
        let output: Result;

        return {
            render(props: Props): Result {
                state.stateCursor = 0;
                state.effectCursor = 0;
                state.pendingEffects = [];
                activeHarness = state;
                try {
                    output = component(props);
                } finally {
                    activeHarness = null;
                }

                for (const pending of state.pendingEffects) {
                    state.effects[pending.index]?.cleanup?.();
                    const cleanup = pending.effect();
                    state.effects[pending.index] = {
                        cleanup: typeof cleanup === 'function' ? cleanup : undefined,
                        deps: pending.deps,
                    };
                }

                return output;
            },
            unmount() {
                for (const effect of state.effects) effect?.cleanup?.();
                state.effects = [];
                state.states = [];
            },
        };
    };

    return { create, setReactFallback, useEffect, useState };
});

const mocks = vi.hoisted(() => ({
    auth: { currentUser: null as unknown },
    credential: { provider: 'password' },
    createCredential: vi.fn(),
    reauthenticateWithCredential: vi.fn(),
    reauthenticateWithPopup: vi.fn(),
    loggerError: vi.fn(),
}));

vi.mock('react', async () => {
    const actual = await vi.importActual<typeof import('react')>('react');
    hookHarness.setReactFallback({
        useState: actual.useState as ReactHookFallbackShape['useState'],
        useEffect: actual.useEffect as ReactHookFallbackShape['useEffect'],
    });
    return {
        ...actual,
        useEffect: hookHarness.useEffect,
        useState: hookHarness.useState,
    };
});

interface ReactHookFallbackShape {
    useState: <T>(initialValue: T | (() => T)) => [T, (value: T) => void];
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
}

vi.mock('firebase/auth', () => ({
    EmailAuthProvider: { credential: mocks.createCredential },
    GoogleAuthProvider: vi.fn(),
    reauthenticateWithCredential: mocks.reauthenticateWithCredential,
    reauthenticateWithPopup: mocks.reauthenticateWithPopup,
}));

vi.mock('@/lib/firebase', () => ({
    auth: mocks.auth,
}));

vi.mock('@/lib/logger', () => ({
    createLogger: vi.fn(() => ({
        error: mocks.loggerError,
        info: vi.fn(),
    })),
}));

import ReauthModal from './ReauthModal';

interface ElementProps {
    children?: ReactNode;
    [key: string]: unknown;
}

function isElement(node: ReactNode): node is ReactElement<ElementProps> {
    return typeof node === 'object' && node !== null && 'props' in node;
}

function findElement(
    node: ReactNode,
    predicate: (element: ReactElement<ElementProps>) => boolean,
): ReactElement<ElementProps> {
    if (Array.isArray(node)) {
        for (const child of node) {
            try {
                return findElement(child, predicate);
            } catch {
                // Continue searching the remaining children.
            }
        }
    } else if (isElement(node)) {
        if (predicate(node)) return node;
        return findElement(node.props.children, predicate);
    }

    throw new Error('Expected element was not rendered');
}

function getText(node: ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(getText).join('');
    if (isElement(node)) return getText(node.props.children);
    return '';
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(promiseResolve => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

const emailUser = {
    uid: 'user-1',
    email: 'user@example.com',
    providerData: [{ providerId: 'password' }],
};

describe('ReauthModal UI lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.auth.currentUser = emailUser;
        mocks.createCredential.mockReturnValue(mocks.credential);
        mocks.reauthenticateWithCredential.mockResolvedValue(undefined);
        mocks.reauthenticateWithPopup.mockResolvedValue(undefined);
    });

    it('メールフォームから再認証し、後続処理の完了後に complete で閉じる', async () => {
        const onClose = vi.fn();
        const onSuccess = vi.fn().mockResolvedValue(undefined);
        const props = { isOpen: true, onClose, onSuccess };
        const harness = hookHarness.create(ReauthModal);
        let view = harness.render(props);

        const passwordInput = findElement(
            view,
            element => element.type === 'input' && element.props.type === 'password',
        );
        const onChange = passwordInput.props.onChange as (event: {
            target: { value: string };
        }) => void;
        onChange({ target: { value: 'correct-password' } });
        view = harness.render(props);

        const form = findElement(view, element => element.type === 'form');
        const preventDefault = vi.fn();
        await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)(
            { preventDefault },
        );

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(mocks.createCredential).toHaveBeenCalledWith(
            'user@example.com',
            'correct-password',
        );
        expect(mocks.reauthenticateWithCredential).toHaveBeenCalledWith(
            emailUser,
            mocks.credential,
        );
        expect(onSuccess).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledWith('complete');
        harness.unmount();
    });

    it('後続処理中は実UIを loading にして dismiss を受け付けない', async () => {
        const deferredSuccess = createDeferred<void>();
        const onClose = vi.fn();
        const onSuccess = vi.fn(() => deferredSuccess.promise);
        const props = { isOpen: true, onClose, onSuccess };
        const harness = hookHarness.create(ReauthModal);
        let view = harness.render(props);
        const form = findElement(view, element => element.type === 'form');
        const submission = (form.props.onSubmit as (
            event: { preventDefault: () => void },
        ) => Promise<void>)({ preventDefault: vi.fn() });

        await Promise.resolve();
        view = harness.render(props);
        const closeButton = findElement(
            view,
            element => element.props['aria-label'] === '再認証画面を閉じる',
        );
        expect(closeButton.props.disabled).toBe(true);
        (closeButton.props.onClick as () => void)();
        expect(onClose).not.toHaveBeenCalled();

        deferredSuccess.resolve(undefined);
        await submission;
        expect(onClose).toHaveBeenCalledWith('complete');
        harness.unmount();
    });

    it('再認証の完了前に閉じた場合はeffect cleanupで後続処理を開始しない', async () => {
        const deferredReauthentication = createDeferred<void>();
        mocks.reauthenticateWithCredential.mockReturnValueOnce(
            deferredReauthentication.promise,
        );
        const onClose = vi.fn();
        const onSuccess = vi.fn().mockResolvedValue(undefined);
        const harness = hookHarness.create(ReauthModal);
        const openProps = { isOpen: true, onClose, onSuccess };
        const view = harness.render(openProps);
        const form = findElement(view, element => element.type === 'form');
        const submission = (form.props.onSubmit as (
            event: { preventDefault: () => void },
        ) => Promise<void>)({ preventDefault: vi.fn() });

        harness.render({ ...openProps, isOpen: false });
        deferredReauthentication.resolve(undefined);
        await submission;

        expect(onSuccess).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        harness.unmount();
    });

    it('再認証エラーをフォーム内のメッセージとして表示する', async () => {
        mocks.reauthenticateWithCredential.mockRejectedValueOnce({
            code: 'auth/wrong-password',
        });
        const props = {
            isOpen: true,
            onClose: vi.fn(),
            onSuccess: vi.fn().mockResolvedValue(undefined),
        };
        const harness = hookHarness.create(ReauthModal);
        let view = harness.render(props);
        const form = findElement(view, element => element.type === 'form');

        await (form.props.onSubmit as (
            event: { preventDefault: () => void },
        ) => Promise<void>)({ preventDefault: vi.fn() });
        view = harness.render(props);

        expect(getText(view)).toContain('パスワードが正しくありません。');
        expect(props.onSuccess).not.toHaveBeenCalled();
        expect(props.onClose).not.toHaveBeenCalled();
        harness.unmount();
    });
});

describe('ReauthModal 共通Dialog移行', () => {
    let container: HTMLDivElement;
    let root: Root;
    let onClose: ReturnType<typeof vi.fn>;
    let onSuccess: ReturnType<typeof vi.fn>;

    const originalShowModal = Object.getOwnPropertyDescriptor(
        HTMLDialogElement.prototype,
        'showModal',
    );
    const originalClose = Object.getOwnPropertyDescriptor(
        HTMLDialogElement.prototype,
        'close',
    );

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
                // Native queues the close event; dispatching it inline would
                // hide races with a controlled close.
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
        vi.clearAllMocks();
        mocks.auth.currentUser = emailUser;
        mocks.createCredential.mockReturnValue(mocks.credential);
        mocks.reauthenticateWithCredential.mockResolvedValue(undefined);
        mocks.reauthenticateWithPopup.mockResolvedValue(undefined);
        onClose = vi.fn();
        onSuccess = vi.fn().mockResolvedValue(undefined);
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

    async function renderModal(isOpen = true): Promise<void> {
        await act(async () => {
            root.render(React.createElement(ReauthModal, { isOpen, onClose, onSuccess }));
        });
    }

    function dialogElement(): HTMLDialogElement {
        const dialog = container.querySelector('dialog');
        if (!dialog) throw new Error('dialog not found');
        return dialog;
    }

    function passwordInput(): HTMLInputElement {
        const input = container.querySelector<HTMLInputElement>('input[type="password"]');
        if (!input) throw new Error('password input not found');
        return input;
    }

    async function typePassword(value: string): Promise<void> {
        const input = passwordInput();
        const valueSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
        )?.set;
        await act(async () => {
            valueSetter?.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    async function pressEscape(): Promise<void> {
        await act(async () => {
            dialogElement().dispatchEvent(new Event('cancel', { cancelable: true }));
        });
    }

    async function submitForm(): Promise<void> {
        const form = container.querySelector('form');
        if (!form) throw new Error('form not found');
        await act(async () => {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
    }

    it('native dialogをmodalとして開き、見出しで命名して初期focusを中へ置く', async () => {
        const outsideButton = document.createElement('button');
        document.body.appendChild(outsideButton);
        outsideButton.focus();

        await renderModal();

        const dialog = dialogElement();
        expect(dialog.open).toBe(true);
        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');

        const labelId = dialog.getAttribute('aria-labelledby');
        expect(labelId).toBeTruthy();
        expect(document.getElementById(labelId ?? '')?.textContent).toBe('セキュリティ確認');
        expect(dialog.contains(document.activeElement)).toBe(true);
        expect(document.activeElement).toBe(passwordInput());

        outsideButton.remove();
    });

    it('親がisOpen=falseに更新するcontrolled closeでhidden DOMのパスワードを消去する', async () => {
        await renderModal();
        await typePassword('secret-password');
        expect(passwordInput().value).toBe('secret-password');

        await renderModal(false);

        const dialog = dialogElement();
        expect(dialog.open).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        expect(container.querySelector('input[type="password"]')).not.toBeNull();
        expect(passwordInput().value).toBe('');
    });

    it('処理中はEscで閉じられず、処理が終われば閉じられる', async () => {
        const deferred = createDeferred<void>();
        mocks.reauthenticateWithCredential.mockReturnValueOnce(deferred.promise);

        await renderModal();
        await typePassword('correct-password');
        await submitForm();

        expect(dialogElement().getAttribute('aria-busy')).toBe('true');
        await pressEscape();
        expect(onClose).not.toHaveBeenCalled();
        expect(dialogElement().open).toBe(true);

        await act(async () => {
            deferred.resolve(undefined);
        });

        // Negative control: the same gesture works once the attempt is over.
        expect(onClose).toHaveBeenCalledWith('complete');
    });

    it('失敗した試行のパスワードをDOMに残さない', async () => {
        mocks.reauthenticateWithCredential.mockRejectedValueOnce({
            code: 'auth/wrong-password',
        });

        await renderModal();
        await typePassword('wrong-password');
        await submitForm();

        expect(container.querySelector('[role="alert"]')?.textContent)
            .toBe('パスワードが正しくありません。');
        expect(passwordInput().value).toBe('');
        expect(onClose).not.toHaveBeenCalled();
        expect(dialogElement().open).toBe(true);

        // The dialog is dismissible again, so Esc closes it.
        await pressEscape();
        expect(onClose).toHaveBeenCalledWith('dismiss');
    });

    it('成功して閉じたあともパスワードをDOMに残さない', async () => {
        await renderModal();
        await typePassword('correct-password');
        await submitForm();

        expect(onSuccess).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledWith('complete');
        expect(passwordInput().value).toBe('');
    });
});
