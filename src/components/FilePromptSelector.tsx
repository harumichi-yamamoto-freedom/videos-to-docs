'use client';

import React, { useState, useEffect } from 'react';
import { Prompt, getPrompts } from '@/lib/prompts';
import { CheckSquare, Square } from 'lucide-react';

interface FilePromptSelectorProps {
    fileName: string;
    selectedPromptIds: string[];
    onPromptsChange: (promptIds: string[]) => void;
}

export const FilePromptSelector: React.FC<FilePromptSelectorProps> = ({
    fileName,
    selectedPromptIds,
    onPromptsChange,
}) => {
    const [prompts, setPrompts] = useState<Prompt[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadPrompts();
    }, []);

    const loadPrompts = async () => {
        try {
            const data = await getPrompts();
            setPrompts(data);
        } catch (error) {
            console.error('プロンプト読み込みエラー:', error);
        } finally {
            setLoading(false);
        }
    };

    const togglePrompt = (promptId: string) => {
        if (selectedPromptIds.includes(promptId)) {
            onPromptsChange(selectedPromptIds.filter(id => id !== promptId));
        } else {
            onPromptsChange([...selectedPromptIds, promptId]);
        }
    };

    if (loading) {
        return <div className="text-xs text-gray-500">読み込み中...</div>;
    }

    return (
        <div className="space-y-2">
            <p className="text-sm font-medium text-gray-700">
                {fileName} のプロンプトを選択:
            </p>
            <div className="space-y-1">
                {prompts.map((prompt) => (
                    <label
                        key={prompt.id}
                        className="flex items-center space-x-2 cursor-pointer hover:bg-gray-50 p-2 rounded"
                    >
                        <input
                            type="checkbox"
                            checked={selectedPromptIds.includes(prompt.id!)}
                            onChange={() => togglePrompt(prompt.id!)}
                            className="hidden"
                        />
                        {selectedPromptIds.includes(prompt.id!) ? (
                            <CheckSquare className="w-4 h-4 text-blue-600" />
                        ) : (
                            <Square className="w-4 h-4 text-gray-400" />
                        )}
                        <span className="text-sm text-gray-700">{prompt.name}</span>
                        {prompt.isDefault && (
                            <span className="text-xs text-blue-600">(デフォルト)</span>
                        )}
                    </label>
                ))}
            </div>
            {selectedPromptIds.length === 0 && (
                <p className="text-xs text-amber-600">
                    ⚠️ 最低1つのプロンプトを選択してください
                </p>
            )}
        </div>
    );
};

