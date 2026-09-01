'use client';

import React, {
    forwardRef,
    useCallback,
    useLayoutEffect,
    useRef,
} from 'react';

interface BackdropPointerState {
    pointerId: number;
    startedOutside: boolean;
}

const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    'a[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

interface FocusReturnState {
    openingActiveElement: HTMLElement | null;
    triggerParents: HTMLElement[];
}

interface DialogOpenRequest {
    dialog: HTMLDialogElement;
    open: () => void;
    abort: () => void;
}

export interface DialogProps extends Omit<
    React.DialogHTMLAttributes<HTMLDialogElement>,
    | 'open'
    | 'onCancel'
    | 'onClose'
    | 'onPointerCancel'
    | 'onPointerDown'
    | 'onPointerUp'
    | 'onSubmitCapture'
> {
    isOpen: boolean;
    onClose: () => void;
    'aria-labelledby': string;
    initialFocusRef?: React.RefObject<HTMLElement | null>;
    returnFocusRef?: React.RefObject<HTMLElement | null>;
    dismissible?: boolean;
    closeOnBackdrop?: boolean;
}

let bodyScrollLockCount = 0;
let originalBodyOverflow = '';
let originalBodyPaddingRight = '';
const pendingDialogOpenRequests: DialogOpenRequest[] = [];
let isFlushingDialogOpenRequests = false;

function findParentDialog(dialog: HTMLDialogElement): HTMLDialogElement | null {
    return dialog.parentElement?.closest<HTMLDialogElement>('dialog') ?? null;
}

function flushDialogOpenRequests(): void {
    if (isFlushingDialogOpenRequests) return;
    isFlushingDialogOpenRequests = true;
    const openedRequests: DialogOpenRequest[] = [];

    try {
        let openedDialog = false;
        do {
            openedDialog = false;

            for (let index = 0; index < pendingDialogOpenRequests.length;) {
                const request = pendingDialogOpenRequests[index];
                if (!request.dialog.isConnected) {
                    pendingDialogOpenRequests.splice(index, 1);
                    continue;
                }

                const parentDialog = findParentDialog(request.dialog);
                if (parentDialog && !parentDialog.open) {
                    index += 1;
                    continue;
                }

                pendingDialogOpenRequests.splice(index, 1);
                request.open();
                openedRequests.push(request);
                openedDialog = true;
            }
        } while (openedDialog);
    } catch (error) {
        for (const request of openedRequests.reverse()) {
            try {
                request.abort();
            } catch {
                // Preserve the error which interrupted the open sequence.
            }
        }
        throw error;
    } finally {
        isFlushingDialogOpenRequests = false;
    }
}

function enqueueDialogOpen(request: DialogOpenRequest): () => void {
    pendingDialogOpenRequests.push(request);

    try {
        flushDialogOpenRequests();
    } catch (error) {
        const requestIndex = pendingDialogOpenRequests.indexOf(request);
        if (requestIndex >= 0) pendingDialogOpenRequests.splice(requestIndex, 1);
        throw error;
    }

    return () => {
        const requestIndex = pendingDialogOpenRequests.indexOf(request);
        if (requestIndex >= 0) pendingDialogOpenRequests.splice(requestIndex, 1);
    };
}

function lockBodyScroll(): () => void {
    const body = document.body;

    if (bodyScrollLockCount === 0) {
        const previousOverflow = body.style.overflow;
        const previousPaddingRight = body.style.paddingRight;

        try {
            const scrollbarWidth = Math.max(
                0,
                window.innerWidth - document.documentElement.clientWidth,
            );
            if (scrollbarWidth > 0) {
                const currentPaddingRight = Number.parseFloat(
                    window.getComputedStyle(body).paddingRight,
                ) || 0;
                body.style.paddingRight = `${currentPaddingRight + scrollbarWidth}px`;
            }
            body.style.overflow = 'hidden';
        } catch (error) {
            body.style.overflow = previousOverflow;
            body.style.paddingRight = previousPaddingRight;
            throw error;
        }

        originalBodyOverflow = previousOverflow;
        originalBodyPaddingRight = previousPaddingRight;
    }

    bodyScrollLockCount += 1;
    let released = false;

    return () => {
        if (released) return;
        released = true;
        bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);

        if (bodyScrollLockCount === 0) {
            body.style.overflow = originalBodyOverflow;
            body.style.paddingRight = originalBodyPaddingRight;
        }
    };
}

function isOutsideDialogRectangle(
    dialog: HTMLDialogElement,
    clientX: number,
    clientY: number,
): boolean {
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    return clientX < left || clientX > right || clientY < top || clientY > bottom;
}

function isEventOwnedByDialog(
    target: EventTarget | null,
    dialog: HTMLDialogElement,
): boolean {
    return target instanceof Element && target.closest('dialog') === dialog;
}

function setForwardedRef<T>(
    forwardedRef: React.ForwardedRef<T>,
    value: T | null,
): void {
    if (typeof forwardedRef === 'function') {
        forwardedRef(value);
        return;
    }
    if (forwardedRef) forwardedRef.current = value;
}

function findDialogTrigger(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element
        ? target.closest<HTMLElement>(FOCUSABLE_SELECTOR)
        : null;
}

function collectTriggerParents(trigger: HTMLElement | null): HTMLElement[] {
    const parents: HTMLElement[] = [];
    let parent = trigger?.parentElement ?? null;

    while (parent && parent !== document.body && parent !== document.documentElement) {
        parents.push(parent);
        parent = parent.parentElement;
    }

    return parents;
}

function canRestoreFocus(target: HTMLElement): boolean {
    if (!target.isConnected || target === document.body) return false;
    if (target.closest('[inert], [aria-hidden="true"], [hidden]')) return false;
    if (target.matches(':disabled')) return false;

    const style = window.getComputedStyle(target);
    return style.display !== 'none' && style.visibility !== 'hidden';
}

function focusElement(target: HTMLElement, allowTemporaryTabIndex = false): boolean {
    if (!canRestoreFocus(target)) return false;

    const needsTemporaryTabIndex = allowTemporaryTabIndex
        && !target.matches(FOCUSABLE_SELECTOR);
    const originalTabIndex = target.getAttribute('tabindex');
    if (needsTemporaryTabIndex) target.setAttribute('tabindex', '-1');

    target.focus({ preventScroll: true });
    const focusWasRestored = document.activeElement === target;

    if (needsTemporaryTabIndex) {
        if (originalTabIndex === null) target.removeAttribute('tabindex');
        else target.setAttribute('tabindex', originalTabIndex);
    }
    return focusWasRestored;
}

export const Dialog = forwardRef<HTMLDialogElement, DialogProps>(function Dialog(
    {
        isOpen,
        onClose,
        initialFocusRef,
        returnFocusRef,
        dismissible = true,
        closeOnBackdrop = true,
        className = '',
        children,
        ...dialogProps
    },
    forwardedRef,
) {
    const dialogRef = useRef<HTMLDialogElement | null>(null);
    const latestTriggerParentsRef = useRef<HTMLElement[]>([]);
    const focusReturnStateRef = useRef<FocusReturnState>({
        openingActiveElement: null,
        triggerParents: [],
    });
    const focusReturnPendingRef = useRef(false);
    const isOpenRef = useRef(isOpen);
    const pendingControlledCloseCountRef = useRef(0);
    const backdropPointerRef = useRef<BackdropPointerState | null>(null);

    const latestInitialFocusRef = useRef(initialFocusRef);
    const latestReturnFocusRef = useRef(returnFocusRef);

    // Callers legitimately pass a different ref object per render (for example
    // `confirming ? cancelRef : headingRef`). Reading them through a ref keeps
    // that identity out of the open effect's dependencies, so an already-open
    // dialog is never closed and re-shown — which would re-capture the focus
    // return target from inside the dialog and lose the real trigger.
    useLayoutEffect(() => {
        latestInitialFocusRef.current = initialFocusRef;
        latestReturnFocusRef.current = returnFocusRef;
    });

    const assignDialogRef = useCallback((dialog: HTMLDialogElement | null) => {
        dialogRef.current = dialog;
        setForwardedRef(forwardedRef, dialog);
    }, [forwardedRef]);

    const closeDialogElement = useCallback((dialog: HTMLDialogElement) => {
        if (!dialog.open) return;
        pendingControlledCloseCountRef.current += 1;
        try {
            dialog.close();
        } catch (error) {
            // A close which never happened must not swallow the next native one.
            pendingControlledCloseCountRef.current -= 1;
            throw error;
        }
    }, []);

    const restoreFocus = useCallback(() => {
        if (!focusReturnPendingRef.current) return;
        focusReturnPendingRef.current = false;

        const { openingActiveElement, triggerParents } = focusReturnStateRef.current;
        focusReturnStateRef.current = {
            openingActiveElement: null,
            triggerParents: [],
        };

        if (openingActiveElement && focusElement(openingActiveElement)) return;

        const explicitReturnTarget = latestReturnFocusRef.current?.current;
        if (explicitReturnTarget && focusElement(explicitReturnTarget)) return;

        for (const parent of triggerParents) {
            if (focusElement(parent, true)) return;
        }
    }, []);

    useLayoutEffect(() => {
        if (isOpen) return;

        const rememberDialogTrigger = (event: Event) => {
            const trigger = findDialogTrigger(event.target);
            if (trigger) {
                latestTriggerParentsRef.current = collectTriggerParents(trigger);
            }
        };

        document.addEventListener('pointerdown', rememberDialogTrigger, true);
        document.addEventListener('focusin', rememberDialogTrigger, true);
        return () => {
            document.removeEventListener('pointerdown', rememberDialogTrigger, true);
            document.removeEventListener('focusin', rememberDialogTrigger, true);
        };
    }, [isOpen]);

    useLayoutEffect(() => {
        isOpenRef.current = isOpen;
        const dialog = dialogRef.current;
        if (!dialog) return;

        if (!isOpen) {
            try {
                closeDialogElement(dialog);
            } finally {
                backdropPointerRef.current = null;
                restoreFocus();
            }
            return;
        }

        if (!dialog.open) {
            const activeElement = document.activeElement instanceof HTMLElement
                && document.activeElement !== document.body
                ? document.activeElement
                : null;
            const focusReturnState = {
                openingActiveElement: activeElement,
                triggerParents: latestTriggerParentsRef.current,
            };

            let unlockBodyScroll: (() => void) | null = null;
            let cancelled = false;
            const abortOpen = () => {
                cancelled = true;
                unlockBodyScroll?.();
                unlockBodyScroll = null;
                focusReturnPendingRef.current = false;
                focusReturnStateRef.current = {
                    openingActiveElement: null,
                    triggerParents: [],
                };

                try {
                    closeDialogElement(dialog);
                } catch {
                    // Preserve the error which interrupted the open sequence.
                }
            };
            const cancelOpenRequest = enqueueDialogOpen({
                dialog,
                open: () => {
                    if (cancelled) return;

                    try {
                        if (!dialog.open) dialog.showModal();
                        unlockBodyScroll = lockBodyScroll();
                        focusReturnStateRef.current = focusReturnState;
                        focusReturnPendingRef.current = true;

                        const focusTarget = latestInitialFocusRef.current?.current
                            ?? dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]');
                        focusTarget?.focus({ preventScroll: true });
                    } catch (error) {
                        abortOpen();
                        throw error;
                    }
                },
                abort: abortOpen,
            });

            return () => {
                cancelled = true;
                cancelOpenRequest();
                unlockBodyScroll?.();
                try {
                    closeDialogElement(dialog);
                } finally {
                    queueMicrotask(() => {
                        if (!dialogRef.current?.open) restoreFocus();
                    });
                }
            };
        }

        const unlockBodyScroll = lockBodyScroll();

        return () => {
            unlockBodyScroll();
            try {
                closeDialogElement(dialog);
            } finally {
                queueMicrotask(() => {
                    if (!dialogRef.current?.open) restoreFocus();
                });
            }
        };
    }, [closeDialogElement, isOpen, restoreFocus]);

    const requestDismiss = useCallback(() => {
        if (dismissible) onClose();
    }, [dismissible, onClose]);

    const handleCancel = (event: React.SyntheticEvent<HTMLDialogElement, Event>) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        requestDismiss();
    };

    const handleNativeClose = (event: React.SyntheticEvent<HTMLDialogElement, Event>) => {
        if (event.target !== event.currentTarget) return;
        if (pendingControlledCloseCountRef.current > 0) {
            pendingControlledCloseCountRef.current -= 1;
            return;
        }
        if (!isOpenRef.current) return;

        const dialog = event.currentTarget;
        if (dialog.isConnected && !dialog.open) dialog.showModal();
        requestDismiss();
    };

    const handleSubmitCapture = (event: React.FormEvent<HTMLDialogElement>) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        if (form.closest('dialog') !== event.currentTarget) return;

        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const overridesMethod = (
            submitter instanceof HTMLButtonElement
            || submitter instanceof HTMLInputElement
        ) && submitter.hasAttribute('formmethod');
        const method = overridesMethod ? submitter.formMethod : form.method;
        if (method.toLowerCase() !== 'dialog') return;

        event.preventDefault();
        event.stopPropagation();
        requestDismiss();
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDialogElement>) => {
        if (
            !isEventOwnedByDialog(event.target, event.currentTarget)
            || !dismissible
            || !closeOnBackdrop
            || !event.isPrimary
            || event.button !== 0
        ) {
            backdropPointerRef.current = null;
            return;
        }
        backdropPointerRef.current = {
            pointerId: event.pointerId,
            startedOutside: isOutsideDialogRectangle(
                event.currentTarget,
                event.clientX,
                event.clientY,
            ),
        };
    };

    const handlePointerUp = (event: React.PointerEvent<HTMLDialogElement>) => {
        const pointerState = backdropPointerRef.current;
        backdropPointerRef.current = null;
        if (
            !pointerState
            || pointerState.pointerId !== event.pointerId
            || !event.isPrimary
            || event.button !== 0
            || !pointerState.startedOutside
            || !isEventOwnedByDialog(event.target, event.currentTarget)
        ) return;

        if (isOutsideDialogRectangle(event.currentTarget, event.clientX, event.clientY)) {
            requestDismiss();
        }
    };

    const handlePointerCancel = (event: React.PointerEvent<HTMLDialogElement>) => {
        if (backdropPointerRef.current?.pointerId === event.pointerId) {
            backdropPointerRef.current = null;
        }
    };

    return (
        <dialog
            {...dialogProps}
            ref={assignDialogRef}
            role={dialogProps.role ?? 'dialog'}
            aria-modal="true"
            className={`fixed inset-0 m-auto p-0 [color:inherit] [&::backdrop]:bg-black/50 [&::backdrop]:backdrop-blur-sm ${className}`}
            onCancel={handleCancel}
            onClose={handleNativeClose}
            onSubmitCapture={handleSubmitCapture}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
        >
            {children}
        </dialog>
    );
});
