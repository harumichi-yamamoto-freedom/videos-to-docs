'use client';

import React, { useEffect, useState } from 'react';
import { Prompt, updatePrompt, deletePrompt } from '@/lib/prompts';
import { ContentEditModal } from './ContentEditModal';
import { DEFAULT_GEMINI_MODEL, GEMINI_MODEL_OPTIONS, getGeminiModelLabel } from '@/constants/geminiModels';

interface PromptEditModalProps {
    isOpen: boolean;
    onClose: () => void;
    prompt: Prompt | null;
    onSave: () => void | Promise<void>;
    onDelete: () => void;
}

export const PromptEditModal: React.FC<PromptEditModalProps> = ({
    isOpen,
    onClose,
    prompt,
    onSave,
    onDelete,
}) => {
    const [selectedModel, setSelectedModel] = useState(prompt?.model || DEFAULT_GEMINI_MODEL);

    useEffect(() => {
        if (prompt && isOpen) {
            setSelectedModel(prompt.model || DEFAULT_GEMINI_MODEL);
        }
    }, [prompt, isOpen]);

    if (!prompt) return null;

    // ゲストのデフォルトプロンプトかどうか
    const isGuestDefaultPrompt = prompt.ownerType === 'guest' && prompt.isDefault;
    // 編集・削除可能かどうか
    const isEditable = !isGuestDefaultPrompt;

    const handleSave = async (title: string, content: string) => {
        await updatePrompt(prompt.id!, { name: title, content: content, model: selectedModel });
        await onSave();
    };

    const handleDelete = async () => {
        if (!confirm(`「${prompt.name}」を削除しますか？`)) return;
        await deletePrompt(prompt.id!);
        onDelete();
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
            onClose={onClose}
            title={prompt.name}
            content={prompt.content}
            isEditable={isEditable}
            showDownload={false}
            onSave={isEditable ? handleSave : undefined}
            onDelete={isEditable ? handleDelete : undefined}
            warningMessage={warningMessage}
            contentLabel="プロンプト内容"
            renderExtraContent={({ isViewMode, saving }) => {
                const option = GEMINI_MODEL_OPTIONS.find(opt => opt.value === selectedModel);
                const displayLabel = getGeminiModelLabel(selectedModel);
                const isSelectDisabled = !isEditable || saving;

                return (
                    <div className="space-y-2">
                        <label className="block text-sm font-semibold text-gray-700">
                            使用するGeminiモデル
                        </label>
                        {isViewMode || !isEditable ? (
                            <div>
                                <p className="text-sm text-gray-800">{displayLabel}</p>
                                {option?.description && (
                                    <p className="text-xs text-gray-500 mt-1">{option.description}</p>
                                )}
                            </div>
                        ) : (
                            <>
                                <select
                                    value={selectedModel}
                                    onChange={(e) => setSelectedModel(e.target.value)}
                                    disabled={isSelectDisabled}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                                >
                                    {GEMINI_MODEL_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>
                                            {opt.label}
                                        </option>
                                    ))}
                                </select>
                                {option?.description && (
                                    <p className="text-xs text-gray-500">{option.description}</p>
                                )}
                            </>
                        )}
                    </div>
                );
            }}
        />
    );
};
