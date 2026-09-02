'use client';

import React, { useCallback, useId, useReducer, useRef, useState } from 'react';
import { canonicalizeGeminiModel } from '@/constants/geminiModels';
import {
    THINKING_LEVELS,
    canonicalizeThinkingLevel,
    type GeminiThinkingLevel,
} from '@/constants/geminiThinking';
import { createLogger } from '@/lib/logger';
import { deletePrompt, type Prompt, updatePrompt } from '@/lib/prompts';
import { ContentEditModal } from './ContentEditModal';
import { Dialog } from './ui/Dialog';
import {
    effectiveThinkingLevel,
    getThinkingLevelOptionLabel,
    ModelComboboxSelect,
    supportsThinkingLevel,
} from './ModelComboboxSelect';

interface PromptEditModalProps {
    isOpen: boolean;
    onClose: () => void;
    prompt: Prompt | null;
    onSave: () => void | Promise<void>;
    onDelete: () => void | Promise<void>;
}

const promptEditLogger = createLogger('PromptEditModal');

export interface PromptEditValues {
    title: string;
    content: string;
    model: string;
    thinkingLevel: GeminiThinkingLevel;
}

export interface PromptEditSessionState {
    saved: PromptEditValues;
    draft: PromptEditValues;
}

export type PromptEditSessionAction =
    | { type: 'textChanged'; title: string; content: string }
    | { type: 'modelChanged'; model: string }
    | { type: 'thinkingLevelChanged'; thinkingLevel: string }
    | { type: 'saveSucceeded'; values: PromptEditValues }
    | { type: 'discardChanges' };

export function createPromptEditValues(prompt: Prompt): PromptEditValues {
    const model = canonicalizeGeminiModel(prompt.model);
    return {
        title: prompt.name,
        content: prompt.content,
        model,
        thinkingLevel: supportsThinkingLevel(model)
            ? canonicalizeThinkingLevel(prompt.thinkingLevel)
            : 'default',
    };
}

export function createPromptEditSession(
    values: PromptEditValues,
): PromptEditSessionState {
    return {
        saved: values,
        draft: values,
    };
}

export function reducePromptEditSession(
    state: PromptEditSessionState,
    action: PromptEditSessionAction,
): PromptEditSessionState {
    switch (action.type) {
        case 'textChanged':
            return {
                ...state,
                draft: {
                    ...state.draft,
                    title: action.title,
                    content: action.content,
                },
            };
        case 'modelChanged':
            // The picked level is kept so returning to a supporting model
            // restores it; `effectiveThinkingLevel` decides what is saved.
            return {
                ...state,
                draft: {
                    ...state.draft,
                    model: canonicalizeGeminiModel(action.model),
                },
            };
        case 'thinkingLevelChanged':
            if (!supportsThinkingLevel(state.draft.model)) return state;
            return {
                ...state,
                draft: {
                    ...state.draft,
                    thinkingLevel: canonicalizeThinkingLevel(action.thinkingLevel),
                },
            };
        case 'saveSucceeded': {
            const model = canonicalizeGeminiModel(action.values.model);
            const values = {
                ...action.values,
                model,
                thinkingLevel: supportsThinkingLevel(model)
                    ? canonicalizeThinkingLevel(action.values.thinkingLevel)
                    : 'default' as const,
            };
            return { saved: values, draft: values };
        }
        case 'discardChanges':
            return { ...state, draft: state.saved };
    }
}

export function hasPromptEditChanges(state: PromptEditSessionState): boolean {
    return state.draft.title !== state.saved.title
        || state.draft.content !== state.saved.content
        || state.draft.model !== state.saved.model
        // The retained pick is invisible while the model cannot use it, so
        // compare what would be saved rather than the intent behind it.
        || effectiveThinkingLevel(state.draft.model, state.draft.thinkingLevel)
            !== effectiveThinkingLevel(state.saved.model, state.saved.thinkingLevel);
}

interface PromptModelFieldProps {
    model: string;
    thinkingLevel: GeminiThinkingLevel;
    isEditable: boolean;
    isViewMode: boolean;
    saving: boolean;
    onModelChange: (model: string) => void;
    onThinkingLevelChange: (thinkingLevel: string) => void;
}

const PromptModelField: React.FC<PromptModelFieldProps> = ({
    model,
    thinkingLevel,
    isEditable,
    isViewMode,
    saving,
    onModelChange,
    onThinkingLevelChange,
}) => {
    const thinkingLevelSupported = supportsThinkingLevel(model);
    const thinkingLevelId = useId();
    const thinkingLevelDescriptionId = useId();

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* 比較表を開いている間は 2 列ぶち抜き（:has で状態を持たずに判定・左列だけだと 6 列中 2 列しか見えない） */}
            <div className="space-y-2 md:has-[[aria-expanded=true]]:col-span-2">
                <span className="block text-sm font-semibold text-gray-700">
                    使用するGeminiモデル
                </span>
                <ModelComboboxSelect
                    value={model}
                    onChange={onModelChange}
                    disabled={!isEditable || saving || isViewMode}
                />
            </div>
            <div className="space-y-2">
                <label
                    htmlFor={thinkingLevelId}
                    className="block text-sm font-semibold text-gray-700"
                >
                    思考レベル
                </label>
                <select
                    id={thinkingLevelId}
                    value={effectiveThinkingLevel(model, thinkingLevel)}
                    onChange={(event) => onThinkingLevelChange(event.target.value)}
                    disabled={!isEditable || saving || isViewMode || !thinkingLevelSupported}
                    aria-describedby={!thinkingLevelSupported
                        ? thinkingLevelDescriptionId
                        : undefined}
                    className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-base text-gray-800 focus:border-transparent focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-600"
                >
                    {THINKING_LEVELS.map(level => (
                        <option key={level.id} value={level.id}>
                            {getThinkingLevelOptionLabel(level)}
                        </option>
                    ))}
                </select>
                {!thinkingLevelSupported && (
                    <p
                        id={thinkingLevelDescriptionId}
                        className="text-xs leading-relaxed text-gray-600"
                    >
                        このモデルでは思考レベルを指定できません。
                    </p>
                )}
            </div>
        </div>
    );
};

interface PromptEditSessionModalProps extends Omit<PromptEditModalProps, 'prompt'> {
    prompt: Prompt;
}

const PromptEditSessionModal: React.FC<PromptEditSessionModalProps> = ({
    isOpen,
    onClose,
    prompt,
    onSave,
    onDelete,
}) => {
    const [session, dispatch] = useReducer(
        reducePromptEditSession,
        createPromptEditValues(prompt),
        createPromptEditSession,
    );
    const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
    const [deletionRefreshFailed, setDeletionRefreshFailed] = useState(false);
    const deletionStatusTitleId = useId();
    const deletionStatusHeadingRef = useRef<HTMLHeadingElement>(null);
    const isGuestDefaultPrompt = prompt.ownerType === 'guest' && prompt.isDefault;
    const isEditable = !isGuestDefaultPrompt;

    const handleDraftChange = useCallback((draft: {
        title: string;
        content: string;
    }) => {
        dispatch({ type: 'textChanged', ...draft });
    }, []);

    const handleModelChange = useCallback((model: string) => {
        dispatch({ type: 'modelChanged', model });
    }, []);

    const handleThinkingLevelChange = useCallback((thinkingLevel: string) => {
        dispatch({ type: 'thinkingLevelChanged', thinkingLevel });
    }, []);

    const handleDiscardChanges = useCallback(() => {
        dispatch({ type: 'discardChanges' });
    }, []);

    const handleSave = async (title: string, content: string) => {
        const values = { ...session.draft, title, content };
        setRefreshWarning(null);
        await updatePrompt(prompt.id!, {
            name: values.title,
            content: values.content,
            model: values.model,
            thinkingLevel: effectiveThinkingLevel(values.model, values.thinkingLevel),
        });
        try {
            await onSave();
        } catch (error) {
            promptEditLogger.error('プロンプト保存後の一覧更新に失敗', error);
            setRefreshWarning(
                '変更は保存されましたが、一覧を更新できませんでした。画面を再読み込みしてください。',
            );
        }
        dispatch({ type: 'saveSucceeded', values });
    };

    const handleDelete = async () => {
        setRefreshWarning(null);
        await deletePrompt(prompt.id!);
        try {
            await onDelete();
        } catch (error) {
            promptEditLogger.error('プロンプト削除後の一覧更新に失敗', error);
            setDeletionRefreshFailed(true);
            return;
        }
        onClose();
    };

    const permissionWarningMessage = isGuestDefaultPrompt ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
            <div className="flex items-start gap-2">
                <span className="flex-shrink-0 text-lg text-amber-600">🔒</span>
                <div>
                    <p className="text-sm font-medium text-amber-900">
                        このプロンプトは編集・削除できません。
                    </p>
                    <p className="mt-1 text-xs text-amber-700">
                        全員に共通のプロンプトです。ログインすると、自分のプロンプトを作成・編集できます。
                    </p>
                </div>
            </div>
        </div>
    ) : prompt.isDefault ? (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
            <p className="text-xs text-blue-800">
                ℹ️ テンプレートから追加したプロンプトです。編集しても元のテンプレートは変わりません。
            </p>
        </div>
    ) : undefined;

    const warningMessage = refreshWarning || permissionWarningMessage ? (
        <div className="space-y-3">
            {refreshWarning && (
                <div
                    role="status"
                    className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900"
                >
                    {refreshWarning}
                </div>
            )}
            {permissionWarningMessage}
        </div>
    ) : undefined;

    if (deletionRefreshFailed) {
        return (
            <Dialog
                isOpen={isOpen}
                onClose={onClose}
                initialFocusRef={deletionStatusHeadingRef}
                aria-labelledby={deletionStatusTitleId}
                className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
            >
                <div className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col">
                    <div className="min-h-0 flex-1 overflow-y-auto p-6 sm:p-8">
                        <h2
                            ref={deletionStatusHeadingRef}
                            id={deletionStatusTitleId}
                            tabIndex={-1}
                            className="text-xl font-bold text-gray-900 focus:outline-none"
                        >
                            プロンプトを削除しました
                        </h2>
                        <p
                            role="status"
                            className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900"
                        >
                            削除は完了しましたが、一覧を更新できませんでした。画面を再読み込みしてください。
                        </p>
                    </div>
                    <div className="sticky bottom-0 border-t border-gray-200 bg-white p-4 sm:px-8">
                        <button
                            type="button"
                            onClick={onClose}
                            className="min-h-11 w-full rounded-lg bg-gray-700 px-6 py-2.5 font-medium text-white transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                        >
                            閉じる
                        </button>
                    </div>
                </div>
            </Dialog>
        );
    }

    return (
        <ContentEditModal
            isOpen={isOpen}
            onClose={onClose}
            title={session.saved.title}
            content={session.saved.content}
            draftTitle={session.draft.title}
            draftContent={session.draft.content}
            onDraftChange={handleDraftChange}
            isDirty={hasPromptEditChanges(session)}
            onDiscardChanges={handleDiscardChanges}
            isEditable={isEditable}
            showDownload={false}
            onSave={isEditable ? handleSave : undefined}
            onDelete={isEditable ? handleDelete : undefined}
            warningMessage={warningMessage}
            contentLabel="プロンプト内容"
            renderExtraContent={({ isViewMode, saving }) => (
                <PromptModelField
                    model={session.draft.model}
                    thinkingLevel={session.draft.thinkingLevel}
                    isEditable={isEditable}
                    isViewMode={isViewMode}
                    saving={saving}
                    onModelChange={handleModelChange}
                    onThinkingLevelChange={handleThinkingLevelChange}
                />
            )}
        />
    );
};

export const PromptEditModal: React.FC<PromptEditModalProps> = (props) => {
    if (!props.prompt) return null;

    const sessionKey = props.isOpen
        ? `open:${props.prompt.id ?? props.prompt.name}`
        : 'closed';
    return (
        <PromptEditSessionModal
            key={sessionKey}
            {...props}
            prompt={props.prompt}
        />
    );
};
