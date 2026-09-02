'use client';

import React, {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useReducer,
    useRef,
    useState,
} from 'react';
import { Save, X } from 'lucide-react';
import {
    GEMINI_DEFAULT_MODEL_SENTINEL,
    canonicalizeGeminiModel,
} from '@/constants/geminiModels';
import {
    THINKING_LEVELS,
    canonicalizeThinkingLevel,
    type GeminiThinkingLevel,
} from '@/constants/geminiThinking';
import { createLogger } from '@/lib/logger';
import { createPrompt } from '@/lib/prompts';
import { Dialog } from './ui/Dialog';
import {
    effectiveThinkingLevel,
    getThinkingLevelOptionLabel,
    ModelComboboxSelect,
    supportsThinkingLevel,
} from './ModelComboboxSelect';

const promptCreateLogger = createLogger('PromptCreateModal');

interface PromptCreateModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: () => void | Promise<void>;
}

export interface PromptCreateDraft {
    name: string;
    content: string;
    model: string;
    thinkingLevel: GeminiThinkingLevel;
}

type PromptCreateDraftAction =
    | { type: 'nameChanged'; name: string }
    | { type: 'contentChanged'; content: string }
    | { type: 'modelChanged'; model: string }
    | { type: 'thinkingLevelChanged'; thinkingLevel: string }
    | { type: 'reset' };

const INITIAL_DRAFT: PromptCreateDraft = {
    name: '',
    content: '',
    model: GEMINI_DEFAULT_MODEL_SENTINEL,
    thinkingLevel: 'default',
};

export function reducePromptCreateDraft(
    state: PromptCreateDraft,
    action: PromptCreateDraftAction,
): PromptCreateDraft {
    switch (action.type) {
        case 'nameChanged':
            return { ...state, name: action.name };
        case 'contentChanged':
            return { ...state, content: action.content };
        case 'modelChanged':
            // The picked level is kept so returning to a supporting model
            // restores it; `effectiveThinkingLevel` decides what is sent.
            return { ...state, model: canonicalizeGeminiModel(action.model) };
        case 'thinkingLevelChanged':
            if (!supportsThinkingLevel(state.model)) return state;
            return {
                ...state,
                thinkingLevel: canonicalizeThinkingLevel(action.thinkingLevel),
            };
        case 'reset':
            return INITIAL_DRAFT;
    }
}

export function hasPromptCreateDraft(draft: PromptCreateDraft): boolean {
    return draft.name !== INITIAL_DRAFT.name
        || draft.content !== INITIAL_DRAFT.content
        || draft.model !== INITIAL_DRAFT.model
        || draft.thinkingLevel !== INITIAL_DRAFT.thinkingLevel;
}

export const PromptCreateModal: React.FC<PromptCreateModalProps> = ({
    isOpen,
    onClose,
    onSave,
}) => {
    const [draft, dispatch] = useReducer(reducePromptCreateDraft, INITIAL_DRAFT);
    const [saving, setSaving] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [confirmingDiscard, setConfirmingDiscard] = useState(false);
    const [creationRefreshFailed, setCreationRefreshFailed] = useState(false);
    const titleId = useId();
    const nameId = useId();
    const contentId = useId();
    const thinkingLevelId = useId();
    const thinkingLevelDescriptionId = useId();
    const errorId = useId();
    const discardTitleId = useId();
    const discardDescriptionId = useId();
    const completionTitleId = useId();
    const nameInputRef = useRef<HTMLInputElement>(null);
    const keepEditingButtonRef = useRef<HTMLButtonElement>(null);
    const completionHeadingRef = useRef<HTMLHeadingElement>(null);
    const confirmationReturnFocusRef = useRef<HTMLElement | null>(null);
    const focusAfterConfirmationRef = useRef<HTMLElement | null>(null);
    const savingRef = useRef(false);
    const thinkingLevelSupported = supportsThinkingLevel(draft.model);
    const hasDraft = hasPromptCreateDraft(draft);

    const reset = useCallback(() => {
        dispatch({ type: 'reset' });
        setErrorMessage(null);
        setConfirmingDiscard(false);
        setCreationRefreshFailed(false);
        confirmationReturnFocusRef.current = null;
        focusAfterConfirmationRef.current = null;
    }, []);

    useEffect(() => {
        if (!isOpen) reset();
    }, [isOpen, reset]);

    useLayoutEffect(() => {
        if (!isOpen) return;
        if (confirmingDiscard) {
            keepEditingButtonRef.current?.focus({ preventScroll: true });
            return;
        }
        if (creationRefreshFailed) {
            completionHeadingRef.current?.focus({ preventScroll: true });
            return;
        }

        const focusTarget = focusAfterConfirmationRef.current;
        focusAfterConfirmationRef.current = null;
        if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    }, [confirmingDiscard, creationRefreshFailed, isOpen]);

    const closeAndReset = useCallback(() => {
        reset();
        onClose();
    }, [onClose, reset]);

    const cancelDiscardConfirmation = useCallback(() => {
        focusAfterConfirmationRef.current = confirmationReturnFocusRef.current
            ?? nameInputRef.current;
        confirmationReturnFocusRef.current = null;
        setConfirmingDiscard(false);
    }, []);

    const requestClose = useCallback(() => {
        if (savingRef.current) return;
        if (confirmingDiscard) {
            cancelDiscardConfirmation();
            return;
        }
        if (!hasDraft) {
            closeAndReset();
            return;
        }

        const activeElement = document.activeElement;
        confirmationReturnFocusRef.current = activeElement instanceof HTMLElement
            ? activeElement
            : nameInputRef.current;
        setConfirmingDiscard(true);
    }, [cancelDiscardConfirmation, closeAndReset, confirmingDiscard, hasDraft]);

    const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (savingRef.current) return;

        if (!draft.name.trim() || !draft.content.trim()) {
            setErrorMessage('プロンプト名と内容を入力してください。入力内容は保持されています。');
            return;
        }

        let created = false;
        try {
            savingRef.current = true;
            setSaving(true);
            setErrorMessage(null);
            await createPrompt(
                draft.name,
                draft.content,
                false,
                draft.model,
                effectiveThinkingLevel(draft.model, draft.thinkingLevel),
            );
            created = true;
            await onSave();
            reset();
            onClose();
        } catch (error) {
            if (created) {
                // The prompt exists; leaving the form usable would let the same
                // draft be created a second time.
                reset();
                setCreationRefreshFailed(true);
                promptCreateLogger.error('プロンプト作成後の一覧更新に失敗', error);
            } else {
                setErrorMessage('作成に失敗しました。入力内容は保持されています。もう一度お試しください。');
                promptCreateLogger.error('プロンプトの作成に失敗', error);
            }
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    };

    const updateDraft = (action: PromptCreateDraftAction) => {
        dispatch(action);
        setErrorMessage(null);
    };

    const dialogLabelId = confirmingDiscard
        ? discardTitleId
        : creationRefreshFailed
            ? completionTitleId
            : titleId;

    return (
        <Dialog
            isOpen={isOpen}
            onClose={requestClose}
            initialFocusRef={nameInputRef}
            dismissible={!saving}
            aria-labelledby={dialogLabelId}
            aria-describedby={confirmingDiscard ? discardDescriptionId : undefined}
            role={confirmingDiscard ? 'alertdialog' : undefined}
            aria-busy={saving || undefined}
            className={`w-[calc(100%-2rem)] ${confirmingDiscard || creationRefreshFailed ? 'max-w-lg' : 'max-w-4xl'} max-h-[90dvh] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl open:flex open:flex-col`}
        >
            {confirmingDiscard && (
                <div className="flex flex-col bg-white p-6 sm:p-8">
                    <div className="space-y-2">
                        <h2 id={discardTitleId} className="text-xl font-bold text-gray-900">
                            入力内容を破棄しますか？
                        </h2>
                        <p id={discardDescriptionId} className="text-sm leading-relaxed text-gray-600">
                            閉じると、入力したプロンプトは失われます。
                        </p>
                    </div>
                    <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
                        <button
                            ref={keepEditingButtonRef}
                            type="button"
                            onClick={cancelDiscardConfirmation}
                            className="min-h-11 rounded-lg bg-blue-600 px-6 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                        >
                            入力を続ける
                        </button>
                        <button
                            type="button"
                            onClick={closeAndReset}
                            className="min-h-11 rounded-lg bg-gray-700 px-6 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                        >
                            入力内容を破棄して閉じる
                        </button>
                    </div>
                </div>
            )}
            {creationRefreshFailed && (
                <div className="flex flex-col bg-white p-6 sm:p-8">
                    <h2
                        ref={completionHeadingRef}
                        id={completionTitleId}
                        tabIndex={-1}
                        className="text-xl font-bold text-gray-900 focus:outline-none"
                    >
                        プロンプトを作成しました
                    </h2>
                    <p
                        role="status"
                        className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900"
                    >
                        作成は完了しましたが、一覧を更新できませんでした。画面を再読み込みしてください。
                    </p>
                    <div className="mt-6 flex justify-end">
                        <button
                            type="button"
                            onClick={closeAndReset}
                            className="min-h-11 rounded-lg bg-gray-700 px-6 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                        >
                            閉じる
                        </button>
                    </div>
                </div>
            )}
            {!creationRefreshFailed && (
            <form
                className={confirmingDiscard ? 'hidden' : 'contents'}
                onSubmit={handleSave}
                aria-hidden={confirmingDiscard ? true : undefined}
                inert={confirmingDiscard ? true : undefined}
                noValidate
            >
                    <div className="flex items-center justify-between border-b bg-gradient-to-r from-blue-50 to-cyan-50 p-6">
                        <h2 id={titleId} className="text-xl font-bold text-gray-900">
                            新しいプロンプトを作成
                        </h2>
                        <button
                            type="button"
                            onClick={requestClose}
                            disabled={saving}
                            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg shadow-sm transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                            aria-label="閉じる"
                            title="閉じる"
                        >
                            <X className="h-5 w-5 text-gray-700" />
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto bg-gray-50 p-6">
                        <div className="space-y-4">
                            <div>
                                <label htmlFor={nameId} className="mb-2 block text-sm font-medium text-gray-700">
                                    プロンプト名
                                </label>
                                <input
                                    ref={nameInputRef}
                                    id={nameId}
                                    type="text"
                                    value={draft.name}
                                    onChange={(event) => updateDraft({
                                        type: 'nameChanged',
                                        name: event.target.value,
                                    })}
                                    aria-invalid={Boolean(errorMessage && !draft.name.trim()) || undefined}
                                    aria-describedby={errorMessage ? errorId : undefined}
                                    disabled={saving}
                                    className="min-h-11 w-full rounded-lg border border-gray-300 px-4 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                                    placeholder="プロンプト名を入力してください"
                                />
                            </div>

                            <div>
                                <label htmlFor={contentId} className="mb-2 block text-sm font-medium text-gray-700">
                                    プロンプト内容
                                </label>
                                <textarea
                                    id={contentId}
                                    value={draft.content}
                                    onChange={(event) => updateDraft({
                                        type: 'contentChanged',
                                        content: event.target.value,
                                    })}
                                    aria-invalid={Boolean(errorMessage && !draft.content.trim()) || undefined}
                                    aria-describedby={errorMessage ? errorId : undefined}
                                    disabled={saving}
                                    rows={12}
                                    className="w-full rounded-lg border border-gray-300 px-4 py-2 font-mono text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                                    placeholder="プロンプト内容を入力してください"
                                />
                            </div>

                            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                {/* 比較表を開いている間は 2 列ぶち抜き（:has で状態を持たずに判定・左列だけだと 6 列中 2 列しか見えない） */}
                                <div className="md:has-[[aria-expanded=true]]:col-span-2">
                                    <span className="mb-2 block text-sm font-medium text-gray-700">
                                        使用するGeminiモデル
                                    </span>
                                    <ModelComboboxSelect
                                        value={draft.model}
                                        onChange={(model) => updateDraft({ type: 'modelChanged', model })}
                                        disabled={saving}
                                    />
                                </div>

                                <div>
                                    <label htmlFor={thinkingLevelId} className="mb-2 block text-sm font-medium text-gray-700">
                                        思考レベル
                                    </label>
                                    <select
                                        id={thinkingLevelId}
                                        value={effectiveThinkingLevel(draft.model, draft.thinkingLevel)}
                                        onChange={(event) => updateDraft({
                                            type: 'thinkingLevelChanged',
                                            thinkingLevel: event.target.value,
                                        })}
                                        disabled={saving || !thinkingLevelSupported}
                                        aria-describedby={!thinkingLevelSupported ? thinkingLevelDescriptionId : undefined}
                                        className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-base text-gray-800 focus:border-transparent focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-600"
                                    >
                                        {THINKING_LEVELS.map(level => (
                                            <option key={level.id} value={level.id}>
                                                {getThinkingLevelOptionLabel(level)}
                                            </option>
                                        ))}
                                    </select>
                                    {!thinkingLevelSupported && (
                                        <p id={thinkingLevelDescriptionId} className="mt-2 text-xs leading-relaxed text-gray-600">
                                            このモデルでは思考レベルを指定できません。
                                        </p>
                                    )}
                                </div>
                            </div>

                            {errorMessage && (
                                <p
                                    id={errorId}
                                    role="alert"
                                    className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium leading-relaxed text-red-800"
                                >
                                    {errorMessage}
                                </p>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center justify-end gap-3 border-t bg-white p-4">
                        <button
                            type="button"
                            onClick={requestClose}
                            disabled={saving}
                            className="min-h-11 rounded-lg border border-gray-400 bg-white px-6 py-2.5 font-medium text-gray-800 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                        >
                            キャンセル
                        </button>
                        <button
                            type="submit"
                            disabled={saving}
                            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-600 px-6 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                        >
                            <Save className="h-4 w-4" />
                            <span>{saving ? '作成中…' : '作成'}</span>
                        </button>
                    </div>
            </form>
            )}
        </Dialog>
    );
};
