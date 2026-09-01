'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { DefaultPromptTemplate } from '@/lib/adminSettings';

interface AddDefaultPromptsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onAdd: (selectedTemplateNames: string[]) => Promise<void>;
    templates: DefaultPromptTemplate[];
}

interface AddDefaultPromptsError {
    field: 'selection' | 'form';
    message: string;
}

function findPromptMenuLauncher(target: EventTarget | null): HTMLButtonElement | null {
    let ancestor = target instanceof Element ? target : null;
    while (ancestor && ancestor !== document.body) {
        const launcher = Array.from(ancestor.children).find((child) => (
            child instanceof HTMLButtonElement
            && child.title === 'プロンプト作成メニュー'
        ));
        if (launcher instanceof HTMLButtonElement) return launcher;
        ancestor = ancestor.parentElement;
    }
    return null;
}

export function AddDefaultPromptsModal({
    isOpen,
    onClose,
    onAdd,
    templates,
}: AddDefaultPromptsModalProps) {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [error, setError] = useState<AddDefaultPromptsError | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const firstCheckboxRef = useRef<HTMLInputElement>(null);
    const titleRef = useRef<HTMLHeadingElement>(null);
    const returnFocusRef = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const errorId = useId();

    useLayoutEffect(() => {
        if (isOpen) return;

        const rememberLauncher = (event: Event) => {
            const launcher = findPromptMenuLauncher(event.target);
            if (launcher) returnFocusRef.current = launcher;
        };

        document.addEventListener('pointerdown', rememberLauncher, true);
        document.addEventListener('focusin', rememberLauncher, true);
        return () => {
            document.removeEventListener('pointerdown', rememberLauncher, true);
            document.removeEventListener('focusin', rememberLauncher, true);
        };
    }, [isOpen]);

    const handleToggle = (templateName: string) => {
        setSelected((currentSelected) => {
            const nextSelected = new Set(currentSelected);
            if (nextSelected.has(templateName)) {
                nextSelected.delete(templateName);
            } else {
                nextSelected.add(templateName);
            }
            return nextSelected;
        });
        setError(null);
    };

    const handleSelectAll = () => {
        setSelected(new Set(templates.map((template) => template.name)));
        setError(null);
    };

    const handleDeselectAll = () => {
        setSelected(new Set());
        setError(null);
    };

    const handleAdd = async () => {
        if (selected.size === 0) {
            setError({
                field: 'selection',
                message: '追加するプロンプトを選択してください。',
            });
            return;
        }

        setError(null);
        setIsLoading(true);
        try {
            await onAdd(Array.from(selected));
            setSelected(new Set());
            onClose();
        } catch {
            setError({
                field: 'form',
                message: 'プロンプトを追加できませんでした。もう一度お試しください。',
            });
        } finally {
            setIsLoading(false);
        }
    };

    const handleCancel = () => {
        if (isLoading) return;
        setSelected(new Set());
        setError(null);
        onClose();
    };

    const selectionInvalid = error?.field === 'selection';

    return (
        <Dialog
            isOpen={isOpen}
            onClose={handleCancel}
            initialFocusRef={templates.length > 0 ? firstCheckboxRef : titleRef}
            returnFocusRef={returnFocusRef}
            dismissible={!isLoading}
            aria-labelledby={titleId}
            className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-hidden rounded-lg border-0 bg-white shadow-xl"
        >
            <div className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col">
                <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-6 py-4">
                    <h2
                        ref={titleRef}
                        id={titleId}
                        tabIndex={templates.length === 0 ? -1 : undefined}
                        className="text-xl font-bold text-gray-900 focus:outline-none"
                    >
                        デフォルトプロンプトを追加
                    </h2>
                    <button
                        type="button"
                        onClick={handleCancel}
                        disabled={isLoading}
                        aria-label="閉じる"
                        className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <X aria-hidden="true" className="h-5 w-5" />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                    {error && (
                        <div
                            id={errorId}
                            role="alert"
                            className="mb-4 rounded-lg bg-red-100 p-3 text-sm text-red-700"
                        >
                            {error.message}
                        </div>
                    )}

                    <div className="mb-4 flex items-center gap-2">
                        <button
                            type="button"
                            onClick={handleSelectAll}
                            className="min-h-11 rounded px-1 text-sm text-blue-600 underline transition-colors hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                            disabled={isLoading}
                        >
                            すべて選択
                        </button>
                        <span aria-hidden="true" className="text-sm text-gray-400">|</span>
                        <button
                            type="button"
                            onClick={handleDeselectAll}
                            className="min-h-11 rounded px-1 text-sm text-blue-600 underline transition-colors hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                            disabled={isLoading}
                        >
                            すべて解除
                        </button>
                    </div>

                    <div
                        role="group"
                        aria-label="追加するプロンプト"
                        aria-describedby={selectionInvalid ? errorId : undefined}
                        className="space-y-2"
                    >
                        {templates.map((template, index) => (
                            <label
                                key={template.name}
                                className="flex min-h-11 cursor-pointer items-center rounded-lg p-3 transition-colors hover:bg-gray-50"
                            >
                                <input
                                    ref={index === 0 ? firstCheckboxRef : undefined}
                                    type="checkbox"
                                    checked={selected.has(template.name)}
                                    onChange={() => handleToggle(template.name)}
                                    disabled={isLoading}
                                    aria-invalid={selectionInvalid || undefined}
                                    aria-describedby={selectionInvalid ? errorId : undefined}
                                    className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                />
                                <span className="ml-3 text-sm text-gray-900">
                                    {template.name}
                                </span>
                            </label>
                        ))}
                    </div>

                    <div className="mt-4 text-sm text-gray-600" role="status" aria-live="polite">
                        {selected.size}個のプロンプトを選択中
                    </div>
                </div>

                <div className="sticky bottom-0 z-10 flex shrink-0 items-center justify-end gap-3 border-t border-gray-200 bg-white px-6 py-4">
                    <button
                        type="button"
                        onClick={handleCancel}
                        disabled={isLoading}
                        className="min-h-11 rounded-lg border border-gray-400 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        キャンセル
                    </button>
                    <button
                        type="button"
                        onClick={handleAdd}
                        disabled={isLoading}
                        className="min-h-11 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-gray-500"
                    >
                        {isLoading ? '追加中...' : '追加'}
                    </button>
                </div>
            </div>
        </Dialog>
    );
}
