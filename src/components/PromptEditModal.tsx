'use client';

import React, { useCallback, useEffect, useReducer, useState } from 'react';
import { Prompt, updatePrompt, deletePrompt } from '@/lib/prompts';
import { ContentEditModal } from './ContentEditModal';
import { canonicalizeGeminiModel } from '@/constants/geminiModels';
import {
    THINKING_LEVELS,
    canonicalizeThinkingLevel,
    type GeminiThinkingLevel,
} from '@/constants/geminiThinking';
import { ModelComboboxSelect } from './ModelComboboxSelect';

interface PromptEditModalProps {
    isOpen: boolean;
    onClose: () => void;
    prompt: Prompt | null;
    onSave: () => void | Promise<void>;
    onDelete: () => void;
}

export interface PromptModelEditSessionState {
    selectedModel: string;
    savedModel: string;
    selectedThinkingLevel: GeminiThinkingLevel;
    savedThinkingLevel: GeminiThinkingLevel;
    isViewMode: boolean;
}

export type PromptModelEditSessionAction =
    | { type: 'select'; model: string }
    | { type: 'selectThinkingLevel'; thinkingLevel: string }
    | { type: 'saveSucceeded' }
    | { type: 'viewModeChanged'; isViewMode: boolean }
    | {
        type: 'reset';
        savedModel: string;
        savedThinkingLevel: string | null | undefined;
    };

export function reducePromptModelEditSession(
    state: PromptModelEditSessionState,
    action: PromptModelEditSessionAction,
): PromptModelEditSessionState {
    switch (action.type) {
        case 'select':
            return {
                ...state,
                selectedModel: canonicalizeGeminiModel(action.model),
            };
        case 'selectThinkingLevel':
            return {
                ...state,
                selectedThinkingLevel: canonicalizeThinkingLevel(action.thinkingLevel),
            };
        case 'saveSucceeded':
            return {
                ...state,
                savedModel: state.selectedModel,
                savedThinkingLevel: state.selectedThinkingLevel,
            };
        case 'viewModeChanged': {
            if (action.isViewMode === state.isViewMode) return state;

            const returnedToViewMode = !state.isViewMode
                && action.isViewMode;
            return {
                ...state,
                isViewMode: action.isViewMode,
                selectedModel: returnedToViewMode
                    ? state.savedModel
                    : state.selectedModel,
                selectedThinkingLevel: returnedToViewMode
                    ? state.savedThinkingLevel
                    : state.selectedThinkingLevel,
            };
        }
        case 'reset': {
            const savedModel = canonicalizeGeminiModel(action.savedModel);
            const savedThinkingLevel = canonicalizeThinkingLevel(
                action.savedThinkingLevel,
            );
            return {
                selectedModel: savedModel,
                savedModel,
                selectedThinkingLevel: savedThinkingLevel,
                savedThinkingLevel,
                isViewMode: true,
            };
        }
    }
}

export function hasPromptModelChanges(state: PromptModelEditSessionState): boolean {
    return state.selectedModel !== state.savedModel
        || state.selectedThinkingLevel !== state.savedThinkingLevel;
}

interface PromptModelFieldProps {
    selectedModel: string;
    selectedThinkingLevel: GeminiThinkingLevel;
    isEditable: boolean;
    isViewMode: boolean;
    saving: boolean;
    onSelect: (model: string) => void;
    onThinkingLevelSelect: (thinkingLevel: string) => void;
    onViewModeChange: (isViewMode: boolean) => void;
}

const PromptModelField: React.FC<PromptModelFieldProps> = ({
    selectedModel,
    selectedThinkingLevel,
    isEditable,
    isViewMode,
    saving,
    onSelect,
    onThinkingLevelSelect,
    onViewModeChange,
}) => {
    useEffect(() => {
        onViewModeChange(isViewMode);
    }, [isViewMode, onViewModeChange]);

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
                <label className="block text-sm font-semibold text-gray-700">
                    使用するGeminiモデル
                </label>
                <ModelComboboxSelect
                    value={selectedModel}
                    onChange={onSelect}
                    disabled={!isEditable || saving || isViewMode}
                />
            </div>
            <div className="space-y-2">
                <label
                    htmlFor="prompt-edit-thinking-level"
                    className="block text-sm font-semibold text-gray-700"
                >
                    思考レベル
                </label>
                <select
                    id="prompt-edit-thinking-level"
                    value={selectedThinkingLevel}
                    onChange={(event) => onThinkingLevelSelect(event.target.value)}
                    disabled={!isEditable || saving || isViewMode}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg bg-white text-sm text-gray-800 focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:text-gray-700"
                >
                    {THINKING_LEVELS.map(level => (
                        <option key={level.id} value={level.id}>
                            {level.description
                                ? `${level.label}（${level.description}）`
                                : level.label}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
};

export const PromptEditModal: React.FC<PromptEditModalProps> = ({
    isOpen,
    onClose,
    prompt,
    onSave,
    onDelete,
}) => {
    const savedModel = canonicalizeGeminiModel(prompt?.model);
    const savedThinkingLevel = canonicalizeThinkingLevel(prompt?.thinkingLevel);
    const [modelSession, dispatchModelSession] = useReducer(
        reducePromptModelEditSession,
        {
            selectedModel: savedModel,
            savedModel,
            selectedThinkingLevel: savedThinkingLevel,
            savedThinkingLevel,
            isViewMode: true,
        },
    );
    // Adjusting state during render: prompt の切り替え時とモーダルの再表示時に、
    // モデル編集セッションを保存済みモデルへリセットする。
    // useEffect 内での setState は React 19 で警告となるため、レンダー中比較で同期させる。
    const sessionKey = isOpen ? prompt?.id ?? '__prompt_without_id__' : '__closed__';
    const [lastSessionKey, setLastSessionKey] = useState(sessionKey);
    if (sessionKey !== lastSessionKey) {
        setLastSessionKey(sessionKey);
        if (isOpen) {
            dispatchModelSession({
                type: 'reset',
                savedModel,
                savedThinkingLevel,
            });
        }
    }

    const handleModelSelect = useCallback((model: string) => {
        dispatchModelSession({ type: 'select', model });
    }, []);

    const handleThinkingLevelSelect = useCallback((thinkingLevel: string) => {
        dispatchModelSession({ type: 'selectThinkingLevel', thinkingLevel });
    }, []);

    const handleViewModeChange = useCallback((nextIsViewMode: boolean) => {
        dispatchModelSession({
            type: 'viewModeChanged',
            isViewMode: nextIsViewMode,
        });
    }, []);

    if (!prompt) return null;

    // ゲストのデフォルトプロンプトかどうか
    const isGuestDefaultPrompt = prompt.ownerType === 'guest' && prompt.isDefault;
    // 編集・削除可能かどうか
    const isEditable = !isGuestDefaultPrompt;

    const handleSave = async (title: string, content: string) => {
        await updatePrompt(prompt.id!, {
            name: title,
            content,
            model: modelSession.selectedModel,
            thinkingLevel: modelSession.selectedThinkingLevel,
        });
        await onSave();
        dispatchModelSession({ type: 'saveSucceeded' });
    };

    const handleDelete = async () => {
        if (!confirm(`「${prompt.name}」を削除しますか？`)) return;
        await deletePrompt(prompt.id!);
        onDelete();
        onClose();
    };

    const handleClose = () => {
        if (hasPromptModelChanges(modelSession)) {
            if (!confirm('保存されていない変更があります。変更を破棄して閉じますか？')) {
                return;
            }
        }
        dispatchModelSession({
            type: 'reset',
            savedModel,
            savedThinkingLevel,
        });
        onClose();
    };

    // 警告メッセージ
    const warningMessage = isGuestDefaultPrompt ? (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-4">
            <div className="flex items-start gap-2">
                <span className="text-amber-600 text-lg flex-shrink-0">🔒</span>
                <div>
                    <p className="text-sm font-medium text-amber-900">
                        このプロンプトは編集・削除できません
                    </p>
                    <p className="text-xs text-amber-700 mt-1">
                        未ログインユーザー向けのデフォルトプロンプトは保護されています
                    </p>
                </div>
            </div>
        </div>
    ) : prompt.isDefault ? (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-xs text-blue-800">
                ℹ️ このプロンプトはデフォルトプロンプトです
            </p>
        </div>
    ) : undefined;

    return (
        <ContentEditModal
            isOpen={isOpen}
            onClose={handleClose}
            title={prompt.name}
            content={prompt.content}
            isEditable={isEditable}
            showDownload={false}
            onSave={isEditable ? handleSave : undefined}
            onDelete={isEditable ? handleDelete : undefined}
            warningMessage={warningMessage}
            contentLabel="プロンプト内容"
            renderExtraContent={({ isViewMode, saving }) => {
                return (
                    <PromptModelField
                        selectedModel={modelSession.selectedModel}
                        selectedThinkingLevel={modelSession.selectedThinkingLevel}
                        isEditable={isEditable}
                        isViewMode={isViewMode}
                        saving={saving}
                        onSelect={handleModelSelect}
                        onThinkingLevelSelect={handleThinkingLevelSelect}
                        onViewModeChange={handleViewModeChange}
                    />
                );
            }}
        />
    );
};
