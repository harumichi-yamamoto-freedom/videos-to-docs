// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import DefaultPromptEditModal from './DefaultPromptEditModal';

// The component only needs the DefaultPromptTemplate type, but a stray value
// import would drag Firebase in; stub the module so the test proves it stays out.
vi.mock('@/lib/adminSettings', () => ({
    getAdminSettings: vi.fn(),
    getDefaultPrompts: vi.fn(),
}));

vi.mock('@/lib/firebase', () => ({
    auth: { currentUser: null },
    db: {},
}));

vi.mock('@/lib/auth', () => ({
    updateUserDisplayName: vi.fn(),
}));

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

const savedPrompt = {
    name: '保存済みプロンプト',
    content: '保存済みの本文',
    model: 'default',
    thinkingLevel: 'default' as const,
};

function spyOnConfirm() {
    return vi.spyOn(window, 'confirm').mockReturnValue(true);
}

function spyOnAlert() {
    return vi.spyOn(window, 'alert').mockImplementation(() => undefined);
}

function setNativeValue(
    element: HTMLInputElement | HTMLTextAreaElement,
    value: string,
): void {
    const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(element: HTMLSelectElement, value: string): void {
    const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value',
    )?.set;
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('DefaultPromptEditModal', () => {
    let container: HTMLDivElement;
    let root: Root;
    let onClose: ReturnType<typeof vi.fn>;
    let onSave: ReturnType<typeof vi.fn>;
    let onDelete: ReturnType<typeof vi.fn>;
    let confirmSpy: ReturnType<typeof spyOnConfirm>;
    let alertSpy: ReturnType<typeof spyOnAlert>;

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

    beforeEach(() => {
        onClose = vi.fn();
        onSave = vi.fn();
        onDelete = vi.fn();
        confirmSpy = spyOnConfirm();
        alertSpy = spyOnAlert();
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
            globalThis as typeof globalThis & {
                IS_REACT_ACT_ENVIRONMENT?: boolean;
            }
        ).IS_REACT_ACT_ENVIRONMENT = false;
    });

    async function renderEditMode(isOpen = true): Promise<void> {
        await act(async () => {
            root.render(
                <DefaultPromptEditModal
                    isOpen={isOpen}
                    onClose={onClose}
                    prompt={savedPrompt}
                    onSave={onSave}
                    onDelete={onDelete}
                    mode="edit"
                />,
            );
        });
    }

    async function renderCreateMode(): Promise<void> {
        await act(async () => {
            root.render(
                <DefaultPromptEditModal
                    isOpen
                    onClose={onClose}
                    prompt={null}
                    onSave={onSave}
                    mode="create"
                />,
            );
        });
    }

    function dialogElement(): HTMLDialogElement {
        const dialog = container.querySelector('dialog');
        if (!dialog) throw new Error('dialog not found');
        return dialog;
    }

    function labelledHeading(): HTMLElement {
        const labelledBy = dialogElement().getAttribute('aria-labelledby');
        expect(labelledBy).toBeTruthy();
        const heading = document.getElementById(labelledBy!);
        if (!heading) throw new Error('labelling heading not found');
        return heading;
    }

    function findButton(name: string): HTMLButtonElement {
        const button = Array.from(container.querySelectorAll('button')).find(
            candidate => candidate.textContent?.trim() === name,
        );
        if (!button) throw new Error(`button not found: ${name}`);
        return button;
    }

    function closeButton(): HTMLButtonElement {
        const button = container.querySelector<HTMLButtonElement>(
            'button[aria-label="閉じる"]',
        );
        if (!button) throw new Error('close button not found');
        return button;
    }

    async function switchToEditMode(): Promise<void> {
        await act(async () => {
            findButton('編集').click();
        });
    }

    it('native dialogをmodalとして開き、見出しでラベル付けする', async () => {
        await renderEditMode();

        const dialog = dialogElement();
        expect(dialog.open).toBe(true);
        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');

        const heading = labelledHeading();
        expect(dialog.contains(heading)).toBe(true);
        expect(heading.tagName).toBe('H2');
        expect(heading.textContent).toBe('保存済みプロンプト');

        // 自前のオーバーレイdivは残さない（backdropはDialogが持つ）。
        expect(container.querySelector('div.fixed.inset-0')).toBeNull();
    });

    it('閉じるボタンは44pxのタップ標的でaria-labelを持ち、押すとonCloseを1回呼ぶ', async () => {
        await renderEditMode();

        const button = closeButton();
        expect(button.classList.contains('min-h-11')).toBe(true);
        expect(button.classList.contains('min-w-11')).toBe(true);

        await act(async () => {
            button.click();
        });

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('変更がないときEscでonCloseを1回呼ぶ', async () => {
        await renderEditMode();

        await act(async () => {
            dialogElement().dispatchEvent(new Event('cancel', { cancelable: true }));
        });

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('編集中に未保存の変更があるとEscは破棄確認を通し、拒否すれば閉じない', async () => {
        await renderEditMode();
        await switchToEditMode();

        const textarea = container.querySelector('textarea');
        if (!textarea) throw new Error('textarea not found');
        await act(async () => {
            setNativeValue(textarea, '編集中の本文');
        });

        confirmSpy.mockReturnValue(false);
        await act(async () => {
            dialogElement().dispatchEvent(new Event('cancel', { cancelable: true }));
        });

        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(confirmSpy).toHaveBeenCalledWith(
            '保存されていない変更があります。変更を破棄して閉じますか？',
        );
        expect(onClose).not.toHaveBeenCalled();
        expect(dialogElement().open).toBe(true);

        confirmSpy.mockReturnValue(true);
        await act(async () => {
            dialogElement().dispatchEvent(new Event('cancel', { cancelable: true }));
        });

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('タイトル編集中もダイアログ名を保つ見出しを置き、タイトル入力へ初期フォーカスする', async () => {
        await renderCreateMode();

        // 追加モードは最初から編集状態＝タイトルはinputで描かれるが、
        // aria-labelledbyの参照先の見出しは常に存在する。
        const heading = labelledHeading();
        expect(heading.tagName).toBe('H2');
        expect(heading.textContent?.trim()).not.toBe('');
        expect(heading.classList.contains('sr-only')).toBe(true);

        const titleInput = container.querySelector<HTMLInputElement>('input[type="text"]');
        expect(titleInput).not.toBeNull();
        expect(document.activeElement).toBe(titleInput);
        expect(titleInput!.hasAttribute('autofocus')).toBe(false);
    });

    it('表示モードでは見出しへ初期フォーカスする', async () => {
        await renderEditMode();

        expect(container.querySelector('input[type="text"]')).toBeNull();
        expect(document.activeElement).toBe(labelledHeading());
    });

    it('promptがnullの追加モードでも描画し、保存でトリム済みの値を渡す', async () => {
        await renderCreateMode();

        const titleInput = container.querySelector<HTMLInputElement>('input[type="text"]');
        const textarea = container.querySelector('textarea');
        if (!titleInput || !textarea) throw new Error('create form not found');

        await act(async () => {
            setNativeValue(titleInput, '  新しいプロンプト  ');
        });
        await act(async () => {
            setNativeValue(textarea, '  新しい本文  ');
        });
        await act(async () => {
            findButton('追加').click();
        });

        expect(alertSpy).not.toHaveBeenCalled();
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledWith({
            name: '新しいプロンプト',
            content: '新しい本文',
            model: 'default',
            thinkingLevel: 'default',
        });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('非対応モデルでは思考レベルを無効化し、実効値だけを保存する', async () => {
        await renderCreateMode();

        const titleInput = container.querySelector<HTMLInputElement>('input[type="text"]');
        const textarea = container.querySelector('textarea');
        const thinkingLevel = container.querySelector('select');
        if (!titleInput || !textarea || !thinkingLevel) {
            throw new Error('create form not found');
        }

        await act(async () => {
            setNativeValue(titleInput, 'プロンプト');
        });
        await act(async () => {
            setNativeValue(textarea, '本文');
        });
        await act(async () => {
            setSelectValue(thinkingLevel, 'high');
        });
        expect(thinkingLevel.value).toBe('high');

        const modelTrigger = container.querySelector<HTMLButtonElement>(
            'button[aria-expanded="false"][aria-controls]',
        );
        if (!modelTrigger) throw new Error('model trigger not found');
        await act(async () => {
            modelTrigger.click();
        });
        const unsupported = Array.from(
            container.querySelectorAll<HTMLInputElement>(
                'input[type="radio"][value="gemini-2.5-pro"]',
            ),
        ).find(input => !input.disabled);
        if (!unsupported) throw new Error('unsupported model option not found');
        await act(async () => {
            unsupported.click();
        });

        const selectAfter = container.querySelector('select');
        expect(selectAfter?.value).toBe('default');
        expect(selectAfter?.disabled).toBe(true);
        expect(container.textContent).toContain('このモデルでは思考レベルを指定できません。');

        await act(async () => {
            findButton('追加').click();
        });

        expect(onSave).toHaveBeenCalledWith({
            name: 'プロンプト',
            content: '本文',
            model: 'gemini-2.5-pro',
            thinkingLevel: 'default',
        });
    });

    it('isOpen=falseでもDialogはマウントされたまま閉じ、onCloseは呼ばない', async () => {
        await renderEditMode(false);

        const dialog = container.querySelector('dialog');
        expect(dialog).not.toBeNull();
        expect(dialog?.open).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
    });
});
