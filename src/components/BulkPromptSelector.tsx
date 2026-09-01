'use client';

import React, { useId } from 'react';
import { Prompt } from '@/lib/prompts';
import { getGeminiModelLabel } from '@/constants/geminiModels';

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
    const groupId = useId();

    if (availablePrompts.length === 0) {
        return null;
    }

    return (
        <fieldset className="rounded-lg border border-purple-200 bg-purple-50 p-4">
            <legend className="px-1 text-sm font-medium text-purple-900">
                デフォルトプロンプト（ファイル追加時に適用します）
            </legend>
            <div className="space-y-1">
                {availablePrompts.map(prompt => {
                    const checkboxId = `${groupId}-${prompt.id}`;

                    return (
                        <label
                            key={prompt.id}
                            htmlFor={checkboxId}
                            className="flex min-h-11 cursor-pointer items-center gap-3 rounded px-2 py-1 hover:bg-purple-100 focus-within:ring-2 focus-within:ring-purple-500"
                        >
                            <input
                                id={checkboxId}
                                type="checkbox"
                                checked={bulkSelectedPromptIds.includes(prompt.id!)}
                                onChange={() => onToggleBulkPrompt(prompt.id!)}
                                className="h-4 w-4 shrink-0 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                            />
                            <span className="flex min-w-0 flex-col">
                                <span className="truncate text-sm text-gray-800">{prompt.name}</span>
                                <span className="text-xs text-gray-600">
                                    {getGeminiModelLabel(prompt.model)}
                                </span>
                            </span>
                        </label>
                    );
                })}
            </div>
        </fieldset>
    );
};
