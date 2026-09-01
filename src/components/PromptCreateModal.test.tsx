// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptCreateModal } from './PromptCreateModal';

const { createPrompt, logError } = vi.hoisted(() => ({
    createPrompt: vi.fn(async (): Promise<void> => undefined),
    logError: vi.fn(),
}));

vi.mock('@/lib/prompts', () => ({ createPrompt }));

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

function setValue(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const prototype = field instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    valueSetter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
}

function findButton(container: HTMLElement, name: string): HTMLButtonElement | null {
    return Array.from(container.querySelectorAll('button')).find(
        candidate => candidate.textContent?.trim() === name,
    ) ?? null;
}

describe('PromptCreateModal 作成後の一覧更新失敗', () => {
    let container: HTMLDivElement;
    let root: Root;
    let onClose: ReturnType<typeof vi.fn>;
    let onSave: ReturnType<typeof vi.fn>;

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
        createPrompt.mockClear();
        createPrompt.mockImplementation(async () => undefined);
        logError.mockClear();
        onClose = vi.fn();
        onSave = vi.fn(async () => undefined);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        await act(async () => {
            root.render(
                <PromptCreateModal isOpen onClose={onClose} onSave={onSave} />,
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

    async function fillDraft(): Promise<void> {
        const name = container.querySelector<HTMLInputElement>('input[type="text"]');
        const content = container.querySelector('textarea');
        if (!name || !content) throw new Error('draft fields not found');

        await act(async () => {
            setValue(name, '新しいプロンプト');
            setValue(content, 'プロンプト本文');
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

    it('作成成功かつ一覧更新失敗のときは再作成できない完了表示にする', async () => {
        onSave.mockRejectedValueOnce(new Error('list refresh failed'));
        await fillDraft();
        await submitForm();

        expect(createPrompt).toHaveBeenCalledTimes(1);
        expect(logError).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('プロンプトを作成しました');
        expect(container.textContent).toContain('一覧を更新できませんでした');
        expect(container.textContent).not.toContain('作成に失敗しました');

        // The reset draft must not be resubmittable through a live CTA.
        expect(container.querySelector('form')).toBeNull();
        expect(findButton(container, '作成')).toBeNull();
        expect(container.querySelector('input[type="text"]')).toBeNull();
        expect(onClose).not.toHaveBeenCalled();

        // The submit button which had focus is gone; focus must not fall to body.
        expect(document.activeElement).toBe(
            container.querySelector('h2'),
        );

        const closeButton = findButton(container, '閉じる');
        expect(closeButton).not.toBeNull();
        await act(async () => {
            closeButton?.click();
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(createPrompt).toHaveBeenCalledTimes(1);
    });

    it('作成も一覧更新も成功したときは完了表示を出さずに閉じる', async () => {
        await fillDraft();
        await submitForm();

        expect(createPrompt).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(container.textContent).not.toContain('一覧を更新できませんでした');
        expect(container.querySelector('form')).not.toBeNull();
    });

    it('作成自体に失敗したときは入力を保持して再試行させる', async () => {
        createPrompt.mockRejectedValueOnce(new Error('create failed'));
        await fillDraft();
        await submitForm();

        expect(container.textContent).toContain('作成に失敗しました');
        expect(container.textContent).not.toContain('一覧を更新できませんでした');
        expect(
            container.querySelector<HTMLInputElement>('input[type="text"]')?.value,
        ).toBe('新しいプロンプト');
        expect(findButton(container, '作成')).not.toBeNull();
        expect(onClose).not.toHaveBeenCalled();
    });
});
