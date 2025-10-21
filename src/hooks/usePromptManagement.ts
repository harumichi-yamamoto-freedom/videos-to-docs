import { useState, useEffect } from 'react';
import { Prompt, getPrompts } from '@/lib/prompts';

export const usePromptManagement = () => {
    const [availablePrompts, setAvailablePrompts] = useState<Prompt[]>([]);
    const [bulkSelectedPromptIds, setBulkSelectedPromptIds] = useState<string[]>([]);

    useEffect(() => {
        loadPrompts();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const loadPrompts = async () => {
        try {
            const prompts = await getPrompts();
            setAvailablePrompts(prompts);
            // デフォルトで最初のプロンプトを選択
            if (prompts.length > 0 && bulkSelectedPromptIds.length === 0) {
                setBulkSelectedPromptIds([prompts[0].id!]);
            }
        } catch (error) {
            console.error('プロンプト読み込みエラー:', error);
        }
    };

    const toggleBulkPrompt = (promptId: string) => {
        setBulkSelectedPromptIds(prev => {
            if (prev.includes(promptId)) {
                return prev.filter(id => id !== promptId);
            } else {
                return [...prev, promptId];
            }
        });
    };

    return {
        availablePrompts,
        bulkSelectedPromptIds,
        toggleBulkPrompt,
    };
};

