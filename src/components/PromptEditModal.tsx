'use client';

import React, { useCallback, useEffect, useReducer, useState } from 'react';
import { Prompt, updatePrompt, deletePrompt } from '@/lib/prompts';
import { ContentEditModal } from './ContentEditModal';
import { canonicalizeGeminiModel } from '@/constants/geminiModels';
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
    isViewMode: boolean;
}

export type PromptModelEditSessionAction =
    | { type: 'select'; model: string }
    | { type: 'saveSucceeded' }
    | { type: 'viewModeChanged'; isViewMode: boolean }
    | { type: 'reset'; savedModel: string };

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
        case 'saveSucceeded':
            return {
                ...state,
                savedModel: state.selectedModel,
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
            };
        }
        case 'reset': {
            const savedModel = canonicalizeGeminiModel(action.savedModel);
            return {
                selectedModel: savedModel,
                savedModel,
                isViewMode: true,
            };
        }
    }
}

export function hasPromptModelChanges(state: PromptModelEditSessionState): boolean {
    return state.selectedModel !== state.savedModel;
}

interface PromptModelFieldProps {
    selectedModel: string;
    isEditable: boolean;
    isViewMode: boolean;
    saving: boolean;
    onSelect: (model: string) => void;
    onViewModeChange: (isViewMode: boolean) => void;
}

const PromptModelField: React.FC<PromptModelFieldProps> = ({
    selectedModel,
    isEditable,
    isViewMode,
    saving,
    onSelect,
    onViewModeChange,
}) => {
    useEffect(() => {
        onViewModeChange(isViewMode);
    }, [isViewMode, onViewModeChange]);

    return (
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
    const [modelSession, dispatchModelSession] = useReducer(
        reducePromptModelEditSession,
        {
            selectedModel: savedModel,
            savedModel,
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
            dispatchModelSession({ type: 'reset', savedModel });
        }
    }

    const handleModelSelect = useCallback((model: string) => {
        dispatchModelSession({ type: 'select', model });
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
        dispatchModelSession({ type: 'reset', savedModel });
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
                        isEditable={isEditable}
                        isViewMode={isViewMode}
                        saving={saving}
                        onSelect={handleModelSelect}
                        onViewModeChange={handleViewModeChange}
                    />
                );
            }}
        />
    );
};
