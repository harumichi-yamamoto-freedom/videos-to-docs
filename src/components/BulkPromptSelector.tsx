'use client';

import React from 'react';
import { CheckSquare, Square } from 'lucide-react';
import { Prompt } from '@/lib/prompts';

interface BulkPromptSelectorProps {
    availablePrompts: Prompt[];
    bulkSelectedPromptIds: string[];
    onToggleBulkPrompt: (promptId: string) => void;
}

export const BulkPromptSelector: React.FC<BulkPromptSelectorProps> = ({
    availablePrompts,
    bulkSelectedPromptIds,
    onToggleBulkPrompt,
}) => {
    if (availablePrompts.length === 0) {
        return null;
    }

    return (
        <div className="mt-6 bg-purple-50 border border-purple-200 rounded-lg p-4">
            <h3 className="text-sm font-medium text-purple-900 mb-3">
                📝 デフォルトプロンプト選択（ファイル追加時に適用）
            </h3>
            <div className="space-y-2">
                {availablePrompts.map(prompt => (
                    <div
                        key={prompt.id}
                        className="flex items-center space-x-2 cursor-pointer hover:bg-purple-100 p-2 rounded"
                        onClick={() => onToggleBulkPrompt(prompt.id!)}
                    >
                        {bulkSelectedPromptIds.includes(prompt.id!) ? (
                            <CheckSquare className="w-4 h-4 text-purple-600" />
                        ) : (
                            <Square className="w-4 h-4 text-gray-400" />
                        )}
                        <span className="text-sm text-gray-700">{prompt.name}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};

