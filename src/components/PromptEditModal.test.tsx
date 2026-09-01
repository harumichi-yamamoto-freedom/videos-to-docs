// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prompt } from '@/lib/prompts';
import { PromptEditModal } from './PromptEditModal';

vi.mock('@/lib/prompts', () => ({
    deletePrompt: vi.fn(),
    updatePrompt: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn() }),
}));

const originalShowModal = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'showModal',
);
const originalClose = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'close',
);

function findButton(container: HTMLElement, name: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll('button')).find(
        candidate => candidate.textContent?.trim() === name,
    );
    if (!button) throw new Error(`button not found: ${name}`);
    return button;
}

const prompt: Prompt = {
    id: 'prompt-id',
    name: '保存済みタイトル',
    content: '保存済み本文',
    model: 'default',
    thinkingLevel: 'default',
    isDefault: false,
    ownerType: 'user',
    ownerId: 'owner-id',
    createdBy: 'owner-id',
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

describe('PromptEditModal dirty確認', () => {
    let container: HTMLDivElement;
    let root: Root;

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
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        await act(async () => {
            root.render(
                <PromptEditModal
                    isOpen
                    onClose={vi.fn()}
                    prompt={prompt}
                    onSave={vi.fn()}
                    onDelete={vi.fn()}
                />,
            );
        });
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        vi.restoreAllMocks();
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

    function dialogElement(): HTMLDialogElement {
        const dialog = container.querySelector('dialog');
        if (!dialog) throw new Error('dialog not found');
        return dialog;
    }

    function closeIconButton(): HTMLButtonElement {
        const button = container.querySelector<HTMLButtonElement>(
            'button[aria-label="閉じる"]',
        );
        if (!button) throw new Error('close button not found');
        return button;
    }

    function isConfirmationShown(): boolean {
        return dialogElement().getAttribute('role') === 'alertdialog';
    }

    async function enterEditMode(): Promise<void> {
        await act(async () => {
            findButton(container, '編集').click();
        });
    }

    async function selectModel(model: string): Promise<void> {
        const trigger = container.querySelector<HTMLButtonElement>(
            'button[aria-expanded="false"][aria-controls]',
        );
        if (!trigger) throw new Error('model trigger not found');
        await act(async () => {
            trigger.click();
        });

        const option = Array.from(
            container.querySelectorAll<HTMLInputElement>(
                `input[type="radio"][value="${model}"]`,
            ),
        ).find(input => !input.disabled);
        if (!option) throw new Error(`model option not found: ${model}`);
        await act(async () => {
            option.click();
        });
    }

    function thinkingLevelSelect(): HTMLSelectElement {
        const select = container.querySelector('select');
        if (!select) throw new Error('thinking level select not found');
        return select;
    }

    it('モデルだけの変更もダイアログ内の確認だけで閉鎖を門番する', async () => {
        const onClose = vi.fn();
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

        await act(async () => {
            root.render(
                <PromptEditModal
                    isOpen
                    onClose={onClose}
                    prompt={prompt}
                    onSave={vi.fn()}
                    onDelete={vi.fn()}
                />,
            );
        });
        await enterEditMode();
        await selectModel('gemini-3.7-flash');

        await act(async () => {
            closeIconButton().focus();
            closeIconButton().click();
        });

        // One confirmation, inside the dialog: the browser's own confirm() is
        // never used, and the form behind it cannot be operated.
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(isConfirmationShown()).toBe(true);
        expect(dialogElement().open).toBe(true);
        const keepEditing = findButton(container, '編集を続ける');
        expect(document.activeElement).toBe(keepEditing);
        const formRegion = container.querySelector('div[inert]');
        expect(formRegion).not.toBeNull();
        expect(formRegion?.getAttribute('aria-hidden')).toBe('true');

        await act(async () => {
            keepEditing.click();
        });

        expect(isConfirmationShown()).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(closeIconButton());

        await act(async () => {
            closeIconButton().click();
        });
        await act(async () => {
            findButton(container, '変更を破棄して閉じる').click();
        });

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('変更が無ければ確認を挟まずに閉じる', async () => {
        const onClose = vi.fn();
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

        await act(async () => {
            root.render(
                <PromptEditModal
                    isOpen
                    onClose={onClose}
                    prompt={prompt}
                    onSave={vi.fn()}
                    onDelete={vi.fn()}
                />,
            );
        });
        await enterEditMode();

        await act(async () => {
            closeIconButton().click();
        });

        expect(isConfirmationShown()).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('非対応モデルを経由しても思考レベルの選択を失わずdirtyも残さない', async () => {
        const onClose = vi.fn();
        const thinkingPrompt: Prompt = {
            ...prompt,
            // A distinct id: the session is keyed by prompt id, so reusing the
            // beforeEach fixture's id would keep that session's draft.
            id: 'thinking-prompt-id',
            model: 'gemini-3.7-flash',
            thinkingLevel: 'high',
        };

        await act(async () => {
            root.render(
                <PromptEditModal
                    isOpen
                    onClose={onClose}
                    prompt={thinkingPrompt}
                    onSave={vi.fn()}
                    onDelete={vi.fn()}
                />,
            );
        });
        await enterEditMode();
        expect(thinkingLevelSelect().value).toBe('high');

        await selectModel('gemini-2.5-pro');

        expect(thinkingLevelSelect().value).toBe('default');
        expect(thinkingLevelSelect().disabled).toBe(true);
        expect(container.textContent).toContain('このモデルでは思考レベルを指定できません。');

        await selectModel('gemini-3.7-flash');

        expect(thinkingLevelSelect().value).toBe('high');
        expect(thinkingLevelSelect().disabled).toBe(false);

        // Back at the saved values, so closing must not claim unsaved changes.
        await act(async () => {
            closeIconButton().click();
        });
        expect(isConfirmationShown()).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
