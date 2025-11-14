'use client';

import React from 'react';
import { Prompt, updatePrompt, deletePrompt } from '@/lib/prompts';
import { ContentEditModal } from './ContentEditModal';

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
    if (!prompt) return null;

    // ゲストのデフォルトプロンプトかどうか
    const isGuestDefaultPrompt = prompt.ownerType === 'guest' && prompt.isDefault;
    // 編集・削除可能かどうか
    const isEditable = !isGuestDefaultPrompt;

    const handleSave = async (title: string, content: string) => {
        await updatePrompt(prompt.id!, { name: title, content: content });
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
        />
    );
};
