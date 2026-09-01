/**
 * @vitest-environment jsdom
 */

import React, { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let modalStack: HTMLDialogElement[] = [];
let dispatchedCancelEvents: Event[] = [];
let handleNativeEscape: ((event: KeyboardEvent) => void) | null = null;

const originalShowModalDescriptor = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'showModal',
);
const originalCloseDescriptor = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'close',
);
const originalClientWidthDescriptor = Object.getOwnPropertyDescriptor(
    document.documentElement,
    'clientWidth',
);
const nativeFocus = HTMLElement.prototype.focus;

function restorePrototypeMethod(
    name: 'showModal' | 'close',
    descriptor: PropertyDescriptor | undefined,
) {
    if (descriptor) {
        Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    } else {
        delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)[name];
    }
}

function render(element: React.ReactNode) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
        root?.render(element);
    });
}

function elementById<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLElement)) {
        throw new Error(`#${id} was not rendered`);
    }
    return element as T;
}

async function flushQueuedTasks(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

function dispatchBackdropPointer(
    dialog: HTMLDialogElement,
    type: 'pointerdown' | 'pointerup',
    pointerId = 1,
): void {
    const event = new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX: -1,
        clientY: -1,
    });
    Object.defineProperties(event, {
        isPrimary: { value: true },
        pointerId: { value: pointerId },
    });
    dialog.dispatchEvent(event);
}

beforeEach(() => {
    modalStack = [];
    dispatchedCancelEvents = [];
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
    Object.defineProperty(document.documentElement, 'clientWidth', {
        configurable: true,
        value: window.innerWidth,
    });

    // jsdom does not implement the modal top layer. Keep a stack so these
    // polyfills exercise the component's showModal/close wiring directly.
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
        configurable: true,
        writable: true,
        value: vi.fn(function showModal(this: HTMLDialogElement) {
            this.setAttribute('open', '');
            modalStack = modalStack.filter((dialog) => dialog !== this);
            modalStack.push(this);
        }),
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
        configurable: true,
        writable: true,
        value: vi.fn(function close(this: HTMLDialogElement) {
            if (!this.open) return;
            this.removeAttribute('open');
            modalStack = modalStack.filter((dialog) => dialog !== this);
            // The spec queues the close event instead of dispatching it inline;
            // dispatching it inline would hide races with a controlled close.
            queueMicrotask(() => {
                this.dispatchEvent(new Event('close'));
            });
        }),
    });

    // Native showModal makes the rest of the document inert. Model the focus
    // part of that contract; a missing showModal call therefore fails the test.
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function focus(
        this: HTMLElement,
        options?: FocusOptions,
    ) {
        const topmostModal = modalStack.at(-1);
        if (topmostModal && !topmostModal.contains(this)) return;
        nativeFocus.call(this, options);
    });

    handleNativeEscape = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        const topmostModal = modalStack.at(-1);
        if (!topmostModal) return;

        const cancelEvent = new Event('cancel', { cancelable: true });
        const shouldPerformNativeClose = topmostModal.dispatchEvent(cancelEvent);
        dispatchedCancelEvents.push(cancelEvent);
        if (shouldPerformNativeClose) topmostModal.close();
    };
    document.addEventListener('keydown', handleNativeEscape);
});

afterEach(() => {
    if (root) {
        act(() => {
            root?.unmount();
        });
    }
    root = null;
    container?.remove();
    container = null;

    if (handleNativeEscape) {
        document.removeEventListener('keydown', handleNativeEscape);
        handleNativeEscape = null;
    }

    vi.restoreAllMocks();
    restorePrototypeMethod('showModal', originalShowModalDescriptor);
    restorePrototypeMethod('close', originalCloseDescriptor);
    if (originalClientWidthDescriptor) {
        Object.defineProperty(
            document.documentElement,
            'clientWidth',
            originalClientWidthDescriptor,
        );
    } else {
        Reflect.deleteProperty(document.documentElement, 'clientWidth');
    }
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
});

describe('Dialog', () => {
    it('showModalで開き、背景をinertにして初期focusと元triggerへの復帰を行う', () => {
        function Harness() {
            const [isOpen, setIsOpen] = useState(false);
            const initialFocusRef = useRef<HTMLButtonElement>(null);
            const explicitReturnFocusRef = useRef<HTMLButtonElement>(null);

            return (
                <>
                    <button id="launcher" type="button" onClick={() => setIsOpen(true)}>
                        開く
                    </button>
                    <button id="background-action" ref={explicitReturnFocusRef} type="button">
                        背景操作
                    </button>
                    <Dialog
                        id="basic-dialog"
                        isOpen={isOpen}
                        onClose={() => setIsOpen(false)}
                        initialFocusRef={initialFocusRef}
                        returnFocusRef={explicitReturnFocusRef}
                        aria-labelledby="basic-title"
                    >
                        <h2 id="basic-title">確認</h2>
                        <button id="initial-action" ref={initialFocusRef} type="button">
                            最初の操作
                        </button>
                        <button id="close-basic" type="button" onClick={() => setIsOpen(false)}>
                            閉じる
                        </button>
                    </Dialog>
                </>
            );
        }

        render(<Harness />);

        const dialog = elementById<HTMLDialogElement>('basic-dialog');
        const launcher = elementById<HTMLButtonElement>('launcher');
        expect(dialog.open).toBe(false);
        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe('basic-title');

        act(() => {
            launcher.focus();
            launcher.click();
        });

        expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
        expect(dialog.open).toBe(true);
        expect(document.body.style.overflow).toBe('hidden');
        expect(document.activeElement).toBe(elementById('initial-action'));

        elementById('background-action').focus();
        expect(document.activeElement).toBe(elementById('initial-action'));

        act(() => {
            elementById<HTMLButtonElement>('close-basic').click();
        });

        expect(dialog.open).toBe(false);
        expect(document.body.style.overflow).toBe('');
        expect(document.activeElement).toBe(launcher);
    });

    it('openのままinitialFocusRefのidentityが変わっても再showModalせず復帰先を保つ', () => {
        function Harness() {
            const [isOpen, setIsOpen] = useState(false);
            const [confirming, setConfirming] = useState(false);
            const headingRef = useRef<HTMLHeadingElement>(null);
            const confirmCancelRef = useRef<HTMLButtonElement>(null);

            return (
                <>
                    <button id="churn-launcher" type="button" onClick={() => setIsOpen(true)}>
                        開く
                    </button>
                    <Dialog
                        id="churn-dialog"
                        isOpen={isOpen}
                        onClose={() => setIsOpen(false)}
                        // The shape callers actually use: a different ref object per render.
                        initialFocusRef={confirming ? confirmCancelRef : headingRef}
                        aria-labelledby="churn-title"
                    >
                        <h2 id="churn-title" ref={headingRef} tabIndex={-1}>確認</h2>
                        {confirming ? (
                            <button
                                id="churn-confirm-cancel"
                                ref={confirmCancelRef}
                                type="button"
                                onClick={() => setIsOpen(false)}
                            >
                                閉じる
                            </button>
                        ) : (
                            <button id="churn-ask" type="button" onClick={() => setConfirming(true)}>
                                確認へ
                            </button>
                        )}
                    </Dialog>
                </>
            );
        }

        render(<Harness />);
        const launcher = elementById<HTMLButtonElement>('churn-launcher');

        act(() => {
            launcher.focus();
            launcher.click();
        });
        expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(elementById('churn-title'));

        act(() => {
            elementById<HTMLButtonElement>('churn-ask').click();
        });

        expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
        expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled();
        expect(elementById<HTMLDialogElement>('churn-dialog').open).toBe(true);

        act(() => {
            elementById<HTMLButtonElement>('churn-confirm-cancel').click();
        });

        expect(document.activeElement).toBe(launcher);
    });

    it('opening時のactiveElementが消えた場合は明示returnFocusRefを優先する', () => {
        function Harness() {
            const [isOpen, setIsOpen] = useState(false);
            const explicitReturnFocusRef = useRef<HTMLButtonElement>(null);

            return (
                <>
                    <button id="explicit-return" ref={explicitReturnFocusRef} type="button">
                        明示的な復帰先
                    </button>
                    <section id="stable-parent">
                        {!isOpen && (
                            <button id="removed-launcher" type="button" onClick={() => setIsOpen(true)}>
                                開くと消えるtrigger
                            </button>
                        )}
                    </section>
                    <Dialog
                        id="explicit-dialog"
                        isOpen={isOpen}
                        onClose={() => setIsOpen(false)}
                        returnFocusRef={explicitReturnFocusRef}
                        aria-labelledby="explicit-title"
                    >
                        <h2 id="explicit-title">確認</h2>
                        <button id="close-explicit" type="button" onClick={() => setIsOpen(false)}>
                            閉じる
                        </button>
                    </Dialog>
                </>
            );
        }

        render(<Harness />);
        const launcher = elementById<HTMLButtonElement>('removed-launcher');

        act(() => {
            launcher.focus();
            launcher.click();
        });
        expect(launcher.isConnected).toBe(false);

        act(() => {
            elementById<HTMLButtonElement>('close-explicit').click();
        });

        expect(document.activeElement).toBe(elementById('explicit-return'));
    });

    it('opening時のactiveElementと明示refが無ければtriggerの接続中の親へ復帰する', () => {
        function Harness() {
            const [isOpen, setIsOpen] = useState(false);

            return (
                <>
                    <section id="stable-trigger-parent">
                        {!isOpen && (
                            <button id="parent-fallback-launcher" type="button" onClick={() => setIsOpen(true)}>
                                開くと消えるtrigger
                            </button>
                        )}
                        <button id="unrelated-delete" type="button">削除</button>
                    </section>
                    <Dialog
                        id="parent-fallback-dialog"
                        isOpen={isOpen}
                        onClose={() => setIsOpen(false)}
                        aria-labelledby="parent-fallback-title"
                    >
                        <h2 id="parent-fallback-title">確認</h2>
                        <button id="close-parent-fallback" type="button" onClick={() => setIsOpen(false)}>
                            閉じる
                        </button>
                    </Dialog>
                </>
            );
        }

        render(<Harness />);
        const launcher = elementById<HTMLButtonElement>('parent-fallback-launcher');

        act(() => {
            launcher.focus();
            launcher.click();
        });

        act(() => {
            elementById<HTMLButtonElement>('close-parent-fallback').click();
        });

        expect(document.activeElement).toBe(elementById('stable-trigger-parent'));
        expect(document.activeElement).not.toBe(elementById('unrelated-delete'));
        expect(elementById('stable-trigger-parent').hasAttribute('tabindex')).toBe(false);
    });

    it('Escapeは最上位dialogだけを閉じ、body lockを最後のdialogまで維持する', () => {
        const outerClose = vi.fn();
        const innerClose = vi.fn();

        function Harness() {
            const [outerOpen, setOuterOpen] = useState(false);
            const [innerOpen, setInnerOpen] = useState(false);
            const outerInitialFocusRef = useRef<HTMLButtonElement>(null);
            const innerInitialFocusRef = useRef<HTMLButtonElement>(null);

            return (
                <>
                    <button id="outer-launcher" type="button" onClick={() => setOuterOpen(true)}>
                        外側を開く
                    </button>
                    <Dialog
                        id="outer-dialog"
                        isOpen={outerOpen}
                        onClose={() => {
                            outerClose();
                            setOuterOpen(false);
                        }}
                        initialFocusRef={outerInitialFocusRef}
                        aria-labelledby="outer-title"
                    >
                        <h2 id="outer-title">外側</h2>
                        <button
                            id="inner-launcher"
                            ref={outerInitialFocusRef}
                            type="button"
                            onClick={() => setInnerOpen(true)}
                        >
                            内側を開く
                        </button>
                        <Dialog
                            id="inner-dialog"
                            isOpen={innerOpen}
                            onClose={() => {
                                innerClose();
                                setInnerOpen(false);
                            }}
                            initialFocusRef={innerInitialFocusRef}
                            aria-labelledby="inner-title"
                        >
                            <h2 id="inner-title">内側</h2>
                            <button id="inner-action" ref={innerInitialFocusRef} type="button">
                                内側の操作
                            </button>
                        </Dialog>
                    </Dialog>
                </>
            );
        }

        render(<Harness />);
        const outerLauncher = elementById<HTMLButtonElement>('outer-launcher');

        act(() => {
            outerLauncher.focus();
            outerLauncher.click();
        });
        expect(elementById<HTMLDialogElement>('outer-dialog').open).toBe(true);
        expect(document.body.style.overflow).toBe('hidden');

        act(() => {
            elementById<HTMLButtonElement>('inner-launcher').click();
        });
        expect(elementById<HTMLDialogElement>('inner-dialog').open).toBe(true);
        expect(document.activeElement).toBe(elementById('inner-action'));

        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: 'Escape',
            }));
        });

        expect(innerClose).toHaveBeenCalledTimes(1);
        expect(dispatchedCancelEvents[0]?.defaultPrevented).toBe(true);
        expect(outerClose).not.toHaveBeenCalled();
        expect(elementById<HTMLDialogElement>('inner-dialog').open).toBe(false);
        expect(elementById<HTMLDialogElement>('outer-dialog').open).toBe(true);
        expect(document.body.style.overflow).toBe('hidden');
        expect(document.activeElement).toBe(elementById('inner-launcher'));

        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: 'Escape',
            }));
        });

        expect(outerClose).toHaveBeenCalledTimes(1);
        expect(dispatchedCancelEvents[1]?.defaultPrevented).toBe(true);
        expect(elementById<HTMLDialogElement>('outer-dialog').open).toBe(false);
        expect(document.body.style.overflow).toBe('');
        expect(document.activeElement).toBe(outerLauncher);
    });

    it('nested dialogを同じ更新で開いても親から子の順でtop layerへ積み、Escapeは内側だけを閉じる', () => {
        const outerClose = vi.fn();
        const innerClose = vi.fn();

        function Harness() {
            const [outerOpen, setOuterOpen] = useState(false);
            const [innerOpen, setInnerOpen] = useState(false);
            const outerInitialFocusRef = useRef<HTMLButtonElement>(null);
            const innerInitialFocusRef = useRef<HTMLButtonElement>(null);

            return (
                <>
                    <button
                        id="simultaneous-launcher"
                        type="button"
                        onClick={() => {
                            setOuterOpen(true);
                            setInnerOpen(true);
                        }}
                    >
                        両方を開く
                    </button>
                    <Dialog
                        id="simultaneous-outer-dialog"
                        isOpen={outerOpen}
                        onClose={() => {
                            outerClose();
                            setOuterOpen(false);
                        }}
                        initialFocusRef={outerInitialFocusRef}
                        aria-labelledby="simultaneous-outer-title"
                    >
                        <h2 id="simultaneous-outer-title">外側</h2>
                        <button id="simultaneous-outer-action" ref={outerInitialFocusRef} type="button">
                            外側の操作
                        </button>
                        <Dialog
                            id="simultaneous-inner-dialog"
                            isOpen={innerOpen}
                            onClose={() => {
                                innerClose();
                                setInnerOpen(false);
                            }}
                            initialFocusRef={innerInitialFocusRef}
                            aria-labelledby="simultaneous-inner-title"
                        >
                            <h2 id="simultaneous-inner-title">内側</h2>
                            <button id="simultaneous-inner-action" ref={innerInitialFocusRef} type="button">
                                内側の操作
                            </button>
                        </Dialog>
                    </Dialog>
                </>
            );
        }

        render(<Harness />);

        act(() => {
            elementById<HTMLButtonElement>('simultaneous-launcher').click();
        });

        expect(modalStack.map(dialog => dialog.id)).toEqual([
            'simultaneous-outer-dialog',
            'simultaneous-inner-dialog',
        ]);
        expect(document.activeElement).toBe(elementById('simultaneous-inner-action'));

        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: 'Escape',
            }));
        });

        expect(innerClose).toHaveBeenCalledTimes(1);
        expect(outerClose).not.toHaveBeenCalled();
        expect(elementById<HTMLDialogElement>('simultaneous-inner-dialog').open).toBe(false);
        expect(elementById<HTMLDialogElement>('simultaneous-outer-dialog').open).toBe(true);
    });

    it('閉じた親dialog配下のopen要求を保留し、子が閉じればpending要求を破棄する', () => {
        function Harness() {
            const [outerOpen, setOuterOpen] = useState(false);
            const [innerOpen, setInnerOpen] = useState(true);

            return (
                <>
                    <button
                        id="cancel-pending-child"
                        type="button"
                        onClick={() => {
                            setInnerOpen(false);
                            setOuterOpen(true);
                        }}
                    >
                        子を閉じて親を開く
                    </button>
                    <Dialog
                        id="pending-outer-dialog"
                        isOpen={outerOpen}
                        onClose={vi.fn()}
                        aria-labelledby="pending-outer-title"
                    >
                        <h2 id="pending-outer-title">外側</h2>
                        <Dialog
                            id="pending-inner-dialog"
                            isOpen={innerOpen}
                            onClose={vi.fn()}
                            aria-labelledby="pending-inner-title"
                        >
                            <h2 id="pending-inner-title">内側</h2>
                        </Dialog>
                    </Dialog>
                </>
            );
        }

        render(<Harness />);
        expect(modalStack).toEqual([]);
        expect(elementById<HTMLDialogElement>('pending-inner-dialog').open).toBe(false);

        act(() => {
            elementById<HTMLButtonElement>('cancel-pending-child').click();
        });

        expect(modalStack.map(dialog => dialog.id)).toEqual(['pending-outer-dialog']);
        expect(elementById<HTMLDialogElement>('pending-inner-dialog').open).toBe(false);
    });

    it('nested dialogのbackdrop操作は内側だけが所有し、外側へ閉鎖を伝播しない', () => {
        const outerClose = vi.fn();
        const innerClose = vi.fn();

        render(
            <Dialog
                id="backdrop-outer-dialog"
                isOpen
                onClose={outerClose}
                aria-labelledby="backdrop-outer-title"
            >
                <h2 id="backdrop-outer-title">外側</h2>
                <Dialog
                    id="backdrop-inner-dialog"
                    isOpen
                    onClose={innerClose}
                    aria-labelledby="backdrop-inner-title"
                >
                    <h2 id="backdrop-inner-title">内側</h2>
                </Dialog>
            </Dialog>,
        );

        const outerDialog = elementById<HTMLDialogElement>('backdrop-outer-dialog');
        const innerDialog = elementById<HTMLDialogElement>('backdrop-inner-dialog');
        outerDialog.getBoundingClientRect = () => ({
            bottom: 500,
            height: 400,
            left: 100,
            right: 500,
            top: 100,
            width: 400,
            x: 100,
            y: 100,
            toJSON: () => ({}),
        });
        innerDialog.getBoundingClientRect = () => ({
            bottom: 400,
            height: 200,
            left: 200,
            right: 400,
            top: 200,
            width: 200,
            x: 200,
            y: 200,
            toJSON: () => ({}),
        });

        act(() => {
            dispatchBackdropPointer(innerDialog, 'pointerdown');
            dispatchBackdropPointer(innerDialog, 'pointerup');
        });

        expect(innerClose).toHaveBeenCalledTimes(1);
        expect(outerClose).not.toHaveBeenCalled();
    });

    it('body lock解除時に既存のoverflowとpaddingRightをそのまま復元する', () => {
        document.body.style.overflow = 'scroll';
        document.body.style.paddingRight = '13px';
        Object.defineProperty(document.documentElement, 'clientWidth', {
            configurable: true,
            value: window.innerWidth - 20,
        });

        function Harness() {
            const [isOpen, setIsOpen] = useState(true);
            return (
                <Dialog
                    id="existing-body-style-dialog"
                    isOpen={isOpen}
                    onClose={() => setIsOpen(false)}
                    aria-labelledby="existing-body-style-title"
                >
                    <h2 id="existing-body-style-title">確認</h2>
                    <button type="button" id="close-existing-body-style" onClick={() => setIsOpen(false)}>
                        閉じる
                    </button>
                </Dialog>
            );
        }

        render(<Harness />);
        expect(document.body.style.overflow).toBe('hidden');
        expect(document.body.style.paddingRight).toBe('33px');

        act(() => {
            elementById<HTMLButtonElement>('close-existing-body-style').click();
        });

        expect(document.body.style.overflow).toBe('scroll');
        expect(document.body.style.paddingRight).toBe('13px');
    });

    it('open中にunmountしてもbody lock前のstyleを復元する', () => {
        document.body.style.overflow = 'auto';
        document.body.style.paddingRight = '7px';

        render(
            <Dialog
                id="unmount-open-dialog"
                isOpen
                onClose={vi.fn()}
                aria-labelledby="unmount-open-title"
            >
                <h2 id="unmount-open-title">確認</h2>
            </Dialog>,
        );

        const mountedRoot = root;
        act(() => {
            mountedRoot?.unmount();
        });
        root = null;

        expect(document.body.style.overflow).toBe('auto');
        expect(document.body.style.paddingRight).toBe('7px');
    });

    it('unmount時にdialog.closeが例外を投げてもbody lock前のstyleとfocusを復元する', async () => {
        document.body.style.overflow = 'clip';
        document.body.style.paddingRight = '9px';

        // Lives outside the React root so it survives the unmount and can be
        // observed as the focus return target.
        const trigger = document.createElement('button');
        trigger.type = 'button';
        document.body.appendChild(trigger);
        trigger.focus();

        function Harness() {
            const initialFocusRef = useRef<HTMLButtonElement>(null);
            return (
                <Dialog
                    id="exception-cleanup-dialog"
                    isOpen
                    onClose={vi.fn()}
                    initialFocusRef={initialFocusRef}
                    aria-labelledby="exception-cleanup-title"
                >
                    <h2 id="exception-cleanup-title">確認</h2>
                    <button id="exception-initial-action" ref={initialFocusRef} type="button">
                        最初の操作
                    </button>
                </Dialog>
            );
        }

        render(<Harness />);
        expect(document.activeElement).toBe(elementById('exception-initial-action'));

        Object.defineProperty(HTMLDialogElement.prototype, 'close', {
            configurable: true,
            writable: true,
            // The dialog leaves the top layer before close() reports failure, so
            // the focus polyfill does not mask where focus actually lands.
            value: vi.fn(function close(this: HTMLDialogElement) {
                modalStack = modalStack.filter((dialog) => dialog !== this);
                throw new Error('close failed');
            }),
        });

        const mountedRoot = root;
        expect(() => {
            act(() => {
                mountedRoot?.unmount();
            });
        }).toThrow('close failed');
        root = null;
        await flushQueuedTasks();

        expect(document.body.style.overflow).toBe('clip');
        expect(document.body.style.paddingRight).toBe('9px');
        expect(document.activeElement).toBe(trigger);
        trigger.remove();
    });

    it('controlled closeの後に届くcloseイベントをユーザー操作として扱わない', async () => {
        const onClose = vi.fn();
        const renderDialog = (isOpen: boolean) => (
            <Dialog
                id="deferred-controlled-dialog"
                isOpen={isOpen}
                onClose={onClose}
                aria-labelledby="deferred-controlled-title"
            >
                <h2 id="deferred-controlled-title">確認</h2>
            </Dialog>
        );

        render(renderDialog(true));
        const dialog = elementById<HTMLDialogElement>('deferred-controlled-dialog');
        expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);

        act(() => {
            root?.render(renderDialog(false));
        });
        expect(dialog.open).toBe(false);

        await flushQueuedTasks();

        expect(dialog.open).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
    });

    it('isOpenのまま外部からcloseされた場合は遅れて届くcloseイベントで再表示と閉鎖要求を行う', async () => {
        const onClose = vi.fn();

        render(
            <Dialog
                id="deferred-native-dialog"
                isOpen
                onClose={onClose}
                aria-labelledby="deferred-native-title"
            >
                <h2 id="deferred-native-title">確認</h2>
            </Dialog>,
        );

        const dialog = elementById<HTMLDialogElement>('deferred-native-dialog');
        expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);

        act(() => {
            dialog.close();
        });
        expect(dialog.open).toBe(false);
        expect(onClose).not.toHaveBeenCalled();

        await flushQueuedTasks();

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(dialog.open).toBe(true);
        expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(2);
    });

    it('open処理中の初期focusが例外でもbody lockと元styleを復元する', () => {
        document.body.style.overflow = 'scroll';
        document.body.style.paddingRight = '5px';
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(HTMLElement.prototype.focus).mockImplementationOnce(() => {
            throw new Error('focus failed');
        });

        function Harness() {
            const initialFocusRef = useRef<HTMLButtonElement>(null);
            return (
                <Dialog
                    id="focus-exception-dialog"
                    isOpen
                    onClose={vi.fn()}
                    initialFocusRef={initialFocusRef}
                    aria-labelledby="focus-exception-title"
                >
                    <h2 id="focus-exception-title">確認</h2>
                    <button ref={initialFocusRef} type="button">最初の操作</button>
                </Dialog>
            );
        }

        expect(() => render(<Harness />)).toThrow('focus failed');
        expect(document.body.style.overflow).toBe('scroll');
        expect(document.body.style.paddingRight).toBe('5px');
    });

    it('method=dialogのsubmitを既定抑止し、formのonSubmitへ伝播させない', () => {
        const onClose = vi.fn();
        const onSubmit = vi.fn();

        render(
            <Dialog
                id="submit-dialog"
                isOpen
                onClose={onClose}
                aria-labelledby="submit-title"
            >
                <h2 id="submit-title">確認</h2>
                <form id="dialog-form" method="dialog" onSubmit={onSubmit}>
                    <button id="dialog-submit" type="submit">決定</button>
                </form>
            </Dialog>,
        );

        const form = elementById<HTMLFormElement>('dialog-form');
        const submitter = elementById<HTMLButtonElement>('dialog-submit');
        const submitEvent = new SubmitEvent('submit', {
            bubbles: true,
            cancelable: true,
            submitter,
        });

        act(() => {
            form.dispatchEvent(submitEvent);
        });

        expect(submitEvent.defaultPrevented).toBe(true);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('nested dialogのmethod=dialog submitは最寄りdialogだけを閉じる', () => {
        const outerClose = vi.fn();
        const innerClose = vi.fn();
        const onSubmit = vi.fn();

        render(
            <Dialog
                id="outer-submit-dialog"
                isOpen
                onClose={outerClose}
                aria-labelledby="outer-submit-title"
            >
                <h2 id="outer-submit-title">外側</h2>
                <Dialog
                    id="inner-submit-dialog"
                    isOpen
                    onClose={innerClose}
                    aria-labelledby="inner-submit-title"
                >
                    <h2 id="inner-submit-title">内側</h2>
                    <form id="inner-dialog-form" method="dialog" onSubmit={onSubmit}>
                        <button id="inner-dialog-submit" type="submit">決定</button>
                    </form>
                </Dialog>
            </Dialog>,
        );

        const form = elementById<HTMLFormElement>('inner-dialog-form');
        const submitter = elementById<HTMLButtonElement>('inner-dialog-submit');
        const submitEvent = new SubmitEvent('submit', {
            bubbles: true,
            cancelable: true,
            submitter,
        });

        act(() => {
            form.dispatchEvent(submitEvent);
        });

        expect(submitEvent.defaultPrevented).toBe(true);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(innerClose).toHaveBeenCalledTimes(1);
        expect(outerClose).not.toHaveBeenCalled();
    });
});
