import { useState, useEffect } from 'react';
import { Prompt, getPrompts } from '@/lib/prompts';
import { useAuth } from './useAuth';
import { createLogger } from '@/lib/logger';

const promptManagementLogger = createLogger('usePromptManagement');

export const usePromptManagement = () => {
    const { user, loading } = useAuth();
    const [availablePrompts, setAvailablePrompts] = useState<Prompt[]>([]);
    const [bulkSelectedPromptIds, setBulkSelectedPromptIds] = useState<string[]>([]);

    useEffect(() => {
        if (!loading) {
            loadPrompts();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user, loading]);

    const loadPrompts = async () => {
        try {
            const prompts = await getPrompts();
            setAvailablePrompts(prompts);

            // デフォルトで最初のプロンプトを選択
            if (prompts.length > 0 && bulkSelectedPromptIds.length === 0) {
                setBulkSelectedPromptIds([prompts[0].id!]);
            }
        } catch (error) {
            promptManagementLogger.error('プロンプト一覧の読み込みに失敗', error);
        }
    };

    // 外部から呼び出せる再読み込み関数
    const reloadPrompts = async (): Promise<Prompt[]> => {
        try {
            const prompts = await getPrompts();
            setAvailablePrompts(prompts);

            // 削除されたプロンプトを選択から除外
            setBulkSelectedPromptIds(prev => {
                const validIds = prompts.map(p => p.id!);
                return prev.filter(id => validIds.includes(id));
            });

            return prompts;
        } catch (error) {
            promptManagementLogger.error('プロンプト一覧の再読み込みに失敗', error);
            return [];
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
        reloadPrompts,
    };
};


