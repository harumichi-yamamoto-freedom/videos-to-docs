// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ContentEditModal,
    type ContentEditDraft,
    type ContentEditModalProps,
} from './ContentEditModal';

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: logError }),
}));

const BASE_TITLE = '議事録ドラフト';
const BASE_CONTENT = '# 見出し\n\n本文です。';
const EDITED_TITLE = '議事録（確定版）';
const EDITED_CONTENT = '# 見出し\n\n書き換えた本文です。';

const originalShowModal = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'showModal',
);
const originalClose = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'close',
);

let container: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;

async function flush(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

async function render(element: React.ReactElement): Promise<void> {
    await act(async () => {
        root.render(element);
    });
    await flush();
}

function renderModal(
    props: Partial<ContentEditModalProps> = {},
): React.ReactElement {
    return (
        <ContentEditModal
            isOpen
            onClose={onClose}
            title={BASE_TITLE}
            content={BASE_CONTENT}
            {...props}
        />
    );
}

function dialog(): HTMLDialogElement {
    const element = container.querySelector('dialog');
    if (!element) throw new Error('dialog was not rendered');
    return element;
}

function labelledText(attribute: 'aria-labelledby' | 'aria-describedby'): string {
    const id = dialog().getAttribute(attribute);
    if (!id) throw new Error(`dialog has no ${attribute}`);
    const labelling = document.getElementById(id);
    if (!labelling) throw new Error(`${attribute} points at a missing element`);
    return labelling.textContent ?? '';
}

function queryButton(name: string): HTMLButtonElement | null {
    return Array.from(container.querySelectorAll('button')).find(
        candidate => candidate.textContent?.trim() === name,
    ) ?? null;
}

function button(name: string): HTMLButtonElement {
    const found = queryButton(name);
    if (!found) throw new Error(`button "${name}" was not rendered`);
    return found;
}

function closeIconButton(): HTMLButtonElement {
    const found = dialog().querySelector<HTMLButtonElement>('button[aria-label="閉じる"]');
    if (!found) throw new Error('close icon button was not rendered');
    return found;
}

function heading(): HTMLHeadingElement {
    const found = dialog().querySelector<HTMLHeadingElement>('h2');
    if (!found) throw new Error('dialog heading was not rendered');
    return found;
}

function titleField(): HTMLInputElement {
    const found = dialog().querySelector<HTMLInputElement>('input[aria-label="タイトル"]');
    if (!found) throw new Error('title field was not rendered');
    return found;
}

function contentField(): HTMLTextAreaElement {
    const found = dialog().querySelector('textarea');
    if (!found) throw new Error('content field was not rendered');
    return found;
}

function isConfirming(): boolean {
    return dialog().getAttribute('role') === 'alertdialog';
}

function formPanel(): HTMLElement {
    const found = dialog().firstElementChild;
    if (!(found instanceof HTMLElement)) throw new Error('form panel was not rendered');
    return found;
}

/**
 * Real activation focuses the control first, and `rememberConfirmationTrigger`
 * reads `document.activeElement`; clicking without focusing would silently
 * measure the body instead of the button under test.
 */
async function click(target: HTMLElement): Promise<void> {
    await act(async () => {
        target.focus();
        target.click();
    });
    await flush();
}

function setFieldValue(
    field: HTMLInputElement | HTMLTextAreaElement,
    value: string,
): void {
    const prototype = field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    valueSetter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
}

async function type(
    field: HTMLInputElement | HTMLTextAreaElement,
    value: string,
): Promise<void> {
    await act(async () => {
        setFieldValue(field, value);
    });
    await flush();
}

/**
 * jsdom does not implement the Escape handling of a modal dialog: model the
 * native sequence (cancel, then close unless the cancel was prevented).
 */
async function pressEscape(): Promise<void> {
    await act(async () => {
        const target = dialog();
        const cancelEvent = new Event('cancel', { cancelable: true });
        const shouldClose = target.dispatchEvent(cancelEvent);
        if (shouldClose) target.close();
    });
    await flush();
}

async function enterEditMode(): Promise<void> {
    await click(button('編集'));
}

/**
 * The footer close button only exists in view mode; edit mode closes through
 * the header icon. Returns the control which was activated so the caller can
 * assert where focus goes back to.
 */
async function requestClose(): Promise<HTMLButtonElement> {
    const trigger = queryButton('閉じる') ?? closeIconButton();
    await click(trigger);
    return trigger;
}

describe('ContentEditModal', () => {
    beforeAll(() => {
        // jsdom ships no dialog behaviour; model just enough of it that the
        // component's showModal/close wiring is exercised for real.
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
                // The spec queues the close event; dispatching it inline would
                // hide races against a controlled close.
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
        logError.mockClear();
        onClose = vi.fn();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        await flush();
        container.remove();
    });

    afterAll(() => {
        if (originalShowModal) {
            Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
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

    describe('ダイアログの命名とレイアウト', () => {
        it('native dialogを閲覧見出しで命名し、開いた直後の実focusを見出しへ置く', async () => {
            await render(renderModal({ isEditable: false }));

            const modal = dialog();
            expect(modal.open).toBe(true);
            expect(modal.getAttribute('role')).toBe('dialog');
            expect(modal.getAttribute('aria-modal')).toBe('true');
            expect(labelledText('aria-labelledby')).toBe(BASE_TITLE);
            expect(heading().tabIndex).toBe(-1);
            expect(document.activeElement).toBe(heading());
            // Focus is placed by the dialog wiring, never by an autofocus attribute.
            expect(modal.querySelector('[autofocus]')).toBeNull();
        });

        it('モバイル向けの2段headerと44px操作対象を表示・編集の両モードで保つ', async () => {
            await render(renderModal({
                onSave: vi.fn(async () => undefined),
                onDelete: vi.fn(),
                showDownload: true,
                onDownload: vi.fn(),
            }));

            const header = dialog().querySelector('div.grid');
            expect(header?.className).toContain('grid-cols-[minmax(0,1fr)_2.75rem]');
            expect(header?.className).toContain('sm:grid-cols-[minmax(0,1fr)_auto_2.75rem]');

            const modeGroup = dialog().querySelector('[role="group"][aria-label="表示モード"]');
            expect(modeGroup?.className).toContain('col-span-2 row-start-2');
            expect(closeIconButton().className).toContain('h-11 w-11');

            const hasTapTargetHeight = (candidate: HTMLButtonElement) => /(?:^|\s)(?:min-h-11|h-11)(?:\s|$)/
                .test(candidate.className);
            const viewModeButtons = Array.from(dialog().querySelectorAll('button'));
            expect(viewModeButtons.map(candidate => candidate.textContent?.trim())).toEqual(
                expect.arrayContaining(['表示', '編集', '削除', 'ダウンロード', '閉じる']),
            );
            expect(viewModeButtons.every(hasTapTargetHeight)).toBe(true);
            expect(dialog().innerHTML).not.toContain('bg-gray-400');

            await enterEditMode();
            const editModeButtons = Array.from(dialog().querySelectorAll('button'));
            expect(editModeButtons.map(candidate => candidate.textContent?.trim())).toEqual(
                expect.arrayContaining(['キャンセル', '保存']),
            );
            expect(editModeButtons.every(hasTapTargetHeight)).toBe(true);
            expect(dialog().innerHTML).not.toContain('bg-gray-400');
        });
    });

    describe('dirty判定', () => {
        it('内部state経路: 書き換えるとdirtyになり、書き戻すとdirtyでなくなる', async () => {
            await render(renderModal({ onSave: vi.fn(async () => undefined) }));
            await enterEditMode();

            // Editing the title alone is enough to make the modal dirty.
            await type(titleField(), EDITED_TITLE);
            await requestClose();
            expect(isConfirming()).toBe(true);
            expect(onClose).not.toHaveBeenCalled();

            await click(button('編集を続ける'));
            await type(titleField(), BASE_TITLE);
            await requestClose();
            expect(isConfirming()).toBe(false);
            expect(onClose).toHaveBeenCalledTimes(1);

            // The same round trip through the content field.
            onClose.mockClear();
            await enterEditMode();
            await type(contentField(), EDITED_CONTENT);
            await requestClose();
            expect(isConfirming()).toBe(true);
            expect(onClose).not.toHaveBeenCalled();

            await click(button('編集を続ける'));
            await type(contentField(), BASE_CONTENT);
            await requestClose();
            expect(isConfirming()).toBe(false);
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it('controlled経路: 親のdraftとisDirtyでdirtyが立ち、書き戻すと落ちる', async () => {
            const onDraftChange = vi.fn();

            function ControlledHarness() {
                const [draft, setDraft] = useState<ContentEditDraft>({
                    title: BASE_TITLE,
                    content: BASE_CONTENT,
                });

                return (
                    <ContentEditModal
                        isOpen
                        onClose={onClose}
                        title={BASE_TITLE}
                        content={BASE_CONTENT}
                        onSave={vi.fn(async () => undefined)}
                        draftTitle={draft.title}
                        draftContent={draft.content}
                        onDraftChange={(next) => {
                            onDraftChange(next);
                            setDraft(next);
                        }}
                        isDirty={draft.title !== BASE_TITLE || draft.content !== BASE_CONTENT}
                        onDiscardChanges={() => setDraft({
                            title: BASE_TITLE,
                            content: BASE_CONTENT,
                        })}
                    />
                );
            }

            await render(<ControlledHarness />);
            await enterEditMode();
            await type(titleField(), EDITED_TITLE);

            // The draft round-trips through the parent, not through local state.
            expect(onDraftChange).toHaveBeenCalledTimes(1);
            expect(onDraftChange).toHaveBeenLastCalledWith({
                title: EDITED_TITLE,
                content: BASE_CONTENT,
            });
            expect(titleField().value).toBe(EDITED_TITLE);

            await requestClose();
            expect(isConfirming()).toBe(true);
            expect(onClose).not.toHaveBeenCalled();

            await click(button('編集を続ける'));
            await type(titleField(), BASE_TITLE);
            expect(onDraftChange).toHaveBeenLastCalledWith({
                title: BASE_TITLE,
                content: BASE_CONTENT,
            });

            await requestClose();
            expect(isConfirming()).toBe(false);
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it('controlled isDirtyは内部の差分比較より優先される', async () => {
            // Drafts differ from the saved values, yet the parent says "clean".
            await render(renderModal({
                onSave: vi.fn(async () => undefined),
                draftTitle: EDITED_TITLE,
                draftContent: EDITED_CONTENT,
                isDirty: false,
            }));

            await click(button('閉じる'));
            expect(isConfirming()).toBe(false);
            expect(onClose).toHaveBeenCalledTimes(1);

            // Drafts match the saved values, yet the parent says "dirty".
            onClose.mockClear();
            await render(renderModal({
                onSave: vi.fn(async () => undefined),
                draftTitle: BASE_TITLE,
                draftContent: BASE_CONTENT,
                isDirty: true,
            }));

            await click(button('閉じる'));
            expect(isConfirming()).toBe(true);
            expect(onClose).not.toHaveBeenCalled();
        });
    });

    describe('確認パネル', () => {
        it('変更ありの閉じるは確認を挟み、編集を続けるで戻り、破棄でonCloseを1回呼ぶ', async () => {
            await render(renderModal({ onSave: vi.fn(async () => undefined) }));
            await enterEditMode();
            await type(contentField(), EDITED_CONTENT);

            await requestClose();
            expect(dialog().getAttribute('role')).toBe('alertdialog');
            expect(labelledText('aria-labelledby')).toBe('未保存の変更があります');
            expect(labelledText('aria-describedby')).toBe('閉じると、保存していない変更は失われます。');
            expect(onClose).not.toHaveBeenCalled();
            // The form behind the confirmation is hidden from every user.
            expect(formPanel().className).toContain('hidden');
            expect(formPanel().getAttribute('aria-hidden')).toBe('true');
            expect(formPanel().hasAttribute('inert')).toBe(true);

            await click(button('編集を続ける'));
            expect(dialog().getAttribute('role')).toBe('dialog');
            expect(labelledText('aria-labelledby')).toBe(`${BASE_TITLE}を編集`);
            expect(onClose).not.toHaveBeenCalled();
            expect(formPanel().className).toContain('flex');
            expect(formPanel().hasAttribute('inert')).toBe(false);
            expect(contentField().value).toBe(EDITED_CONTENT);

            await requestClose();
            expect(isConfirming()).toBe(true);
            await click(button('変更を破棄して閉じる'));
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(isConfirming()).toBe(false);

            // Discarding restored the draft, so the next edit starts from the
            // saved content.
            await enterEditMode();
            expect(contentField().value).toBe(BASE_CONTENT);
        });

        it('変更なしの閉じるは確認を出さずに即onCloseを呼ぶ', async () => {
            await render(renderModal({ onSave: vi.fn(async () => undefined) }));

            await click(button('閉じる'));
            expect(isConfirming()).toBe(false);
            expect(queryButton('変更を破棄して閉じる')).toBeNull();
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it('表示モードへ戻る操作も未保存の変更を確認してから破棄する', async () => {
            await render(renderModal({ onSave: vi.fn(async () => undefined) }));
            await enterEditMode();
            await type(contentField(), EDITED_CONTENT);

            await click(button('表示'));
            expect(isConfirming()).toBe(true);
            expect(labelledText('aria-describedby')).toBe(
                '表示モードに戻ると、保存していない変更は失われます。',
            );
            expect(onClose).not.toHaveBeenCalled();

            await click(button('変更を破棄して表示に戻る'));
            expect(onClose).not.toHaveBeenCalled();
            expect(dialog().querySelector('textarea')).toBeNull();
            expect(dialog().querySelector('[role="status"]')?.textContent)
                .toBe('変更を破棄しました。');
        });

        it('削除は確認を挟み、削除するでonDeleteを1回呼ぶ', async () => {
            const onDelete = vi.fn(async () => undefined);
            await render(renderModal({ onDelete, onSave: vi.fn(async () => undefined) }));

            const deleteButton = button('削除');
            await click(deleteButton);
            expect(dialog().getAttribute('role')).toBe('alertdialog');
            expect(labelledText('aria-labelledby')).toBe(`「${BASE_TITLE}」を削除しますか？`);
            expect(labelledText('aria-describedby')).toBe('削除したコンテンツは元に戻せません。');
            expect(onDelete).not.toHaveBeenCalled();
            expect(document.activeElement).toBe(button('キャンセル'));

            await click(button('キャンセル'));
            expect(isConfirming()).toBe(false);
            expect(onDelete).not.toHaveBeenCalled();
            // Focus returns to the control which opened the confirmation.
            expect(document.activeElement).toBe(deleteButton);

            await click(button('削除'));
            await click(button('削除する'));
            expect(onDelete).toHaveBeenCalledTimes(1);
        });
    });

    describe('保存', () => {
        it('保存が解決すると表示モードへ戻り、statusと新しい値を反映する', async () => {
            const onSave = vi.fn(async () => undefined);
            await render(renderModal({ onSave }));
            await enterEditMode();
            await type(titleField(), EDITED_TITLE);
            await type(contentField(), EDITED_CONTENT);

            await click(button('保存'));
            expect(onSave).toHaveBeenCalledTimes(1);
            expect(onSave).toHaveBeenCalledWith(EDITED_TITLE, EDITED_CONTENT);
            expect(dialog().querySelector('textarea')).toBeNull();
            expect(dialog().querySelector('[role="status"]')?.textContent)
                .toBe('変更を保存しました。');
            expect(dialog().querySelector('[role="alert"]')).toBeNull();
            expect(heading().textContent).toBe(EDITED_TITLE);
            expect(document.activeElement).toBe(heading());

            // The saved values became the new baseline: closing needs no confirmation.
            await click(button('閉じる'));
            expect(isConfirming()).toBe(false);
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it('保存が失敗するとrole=alertを出し、入力内容を保持したまま編集モードに留まる', async () => {
            const onSave = vi.fn(async () => {
                throw new Error('save failed');
            });
            await render(renderModal({ onSave }));
            await enterEditMode();
            await type(titleField(), EDITED_TITLE);
            await type(contentField(), EDITED_CONTENT);

            await click(button('保存'));
            expect(onSave).toHaveBeenCalledTimes(1);
            expect(logError).toHaveBeenCalledTimes(1);
            expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
                '保存に失敗しました。入力した変更内容は保持されています。もう一度保存してください。',
            );
            expect(titleField().value).toBe(EDITED_TITLE);
            expect(contentField().value).toBe(EDITED_CONTENT);
            expect(button('保存').disabled).toBe(false);
            expect(onClose).not.toHaveBeenCalled();
            expect(dialog().querySelector('[role="status"]')?.textContent).toBe('');

            // Retrying keeps the same draft.
            await click(button('保存'));
            expect(onSave).toHaveBeenLastCalledWith(EDITED_TITLE, EDITED_CONTENT);
        });

        it('空のタイトルは保存を呼ばずにrole=alertで入力保持を伝える', async () => {
            const onSave = vi.fn(async () => undefined);
            await render(renderModal({ onSave }));
            await enterEditMode();
            await type(titleField(), '   ');

            await click(button('保存'));
            expect(onSave).not.toHaveBeenCalled();
            expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
                'タイトルと内容を入力してください。入力内容は保持されています。',
            );
            expect(titleField().value).toBe('   ');
            expect(titleField().getAttribute('aria-invalid')).toBe('true');
        });

        it('保存中はEscで閉じられず、保存が終わればEscで閉じられる', async () => {
            let resolveSave: (() => void) | null = null;
            const onSave = vi.fn(() => new Promise<void>((resolve) => {
                resolveSave = () => resolve();
            }));
            await render(renderModal({ onSave }));
            await enterEditMode();
            await type(contentField(), EDITED_CONTENT);
            await click(button('保存'));

            // Saving is in flight: the modal is busy and not dismissible.
            expect(onSave).toHaveBeenCalledTimes(1);
            expect(queryButton('保存中...')).not.toBeNull();
            expect(button('キャンセル').disabled).toBe(true);
            expect(closeIconButton().disabled).toBe(true);
            expect(contentField().disabled).toBe(true);

            await pressEscape();
            expect(onClose).not.toHaveBeenCalled();
            expect(isConfirming()).toBe(false);
            expect(dialog().open).toBe(true);

            await act(async () => {
                resolveSave?.();
            });
            await flush();
            expect(queryButton('保存中...')).toBeNull();
            expect(dialog().querySelector('[role="status"]')?.textContent)
                .toBe('変更を保存しました。');

            // Negative control: the same Escape closes once saving has finished.
            await pressEscape();
            expect(onClose).toHaveBeenCalledTimes(1);
        });
    });

    describe('focus', () => {
        it('確認を開くと編集を続けるへfocusし、閉じると元のボタンへ戻す', async () => {
            await render(renderModal({ onSave: vi.fn(async () => undefined) }));
            await enterEditMode();
            await type(contentField(), EDITED_CONTENT);

            // Opened from the view-mode toggle, not from the header close icon
            // which is also the fallback focus target.
            const viewModeToggle = button('表示');
            await click(viewModeToggle);
            expect(document.activeElement).toBe(button('編集を続ける'));
            expect(document.activeElement).not.toBe(closeIconButton());

            await click(button('編集を続ける'));
            expect(document.activeElement).toBe(viewModeToggle);
            expect(document.activeElement).not.toBe(closeIconButton());
        });

        it('Escで確認を閉じても元のボタンへfocusを戻す', async () => {
            await render(renderModal({ onSave: vi.fn(async () => undefined) }));
            await enterEditMode();
            await type(contentField(), EDITED_CONTENT);

            const cancelEdit = button('キャンセル');
            await click(cancelEdit);
            expect(isConfirming()).toBe(true);

            await pressEscape();
            expect(isConfirming()).toBe(false);
            expect(onClose).not.toHaveBeenCalled();
            expect(document.activeElement).toBe(cancelEdit);
        });

        it('モーダルを開いたtriggerへfocusを戻す', async () => {
            function OpenerHarness() {
                const [isOpen, setIsOpen] = useState(false);

                return (
                    <>
                        <button id="opener" type="button" onClick={() => setIsOpen(true)}>
                            開く
                        </button>
                        <ContentEditModal
                            isOpen={isOpen}
                            onClose={() => {
                                onClose();
                                setIsOpen(false);
                            }}
                            title={BASE_TITLE}
                            content={BASE_CONTENT}
                        />
                    </>
                );
            }

            await render(<OpenerHarness />);
            const opener = container.querySelector<HTMLButtonElement>('#opener');
            if (!opener) throw new Error('opener was not rendered');

            await click(opener);
            expect(dialog().open).toBe(true);
            expect(document.activeElement).toBe(heading());

            await click(button('閉じる'));
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(dialog().open).toBe(false);
            expect(document.activeElement).toBe(opener);
        });
    });
});
