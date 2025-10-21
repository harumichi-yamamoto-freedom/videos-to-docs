'use client';

import React, { useState, useEffect } from 'react';
import { FileText, RefreshCw, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { Prompt, getPrompts, deletePrompt } from '@/lib/prompts';

/**
 * プロンプト一覧サイドバーのProps
 */
export interface PromptListSidebarProps {
    onPromptClick: (prompt: Prompt) => void;
    onCreateClick: () => void;
    onPromptDeleted?: () => void;
    updateTrigger?: number;
}

export const PromptListSidebar: React.FC<PromptListSidebarProps> = ({
    onPromptClick,
    onCreateClick,
    onPromptDeleted,
    updateTrigger,
}) => {
    const [prompts, setPrompts] = useState<Prompt[]>([]);
    const [loading, setLoading] = useState(true);
    const [isExpanded, setIsExpanded] = useState(false);

    // 静かに更新（ローディング表示なし）
    const loadPromptsQuietly = async () => {
        try {
            const data = await getPrompts();
            setPrompts(data);
        } catch (error) {
            console.error('プロンプト読み込みエラー:', error);
        }
    };

    // 手動更新（ローディング表示あり）
    const loadPrompts = async () => {
        try {
            setLoading(true);
            const data = await getPrompts();
            setPrompts(data);
            // 最低0.5秒はローディング表示
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            console.error('プロンプト読み込みエラー:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadPrompts();
    }, []);

    // 外部からの更新トリガーを監視
    useEffect(() => {
        if (updateTrigger !== undefined && updateTrigger > 0) {
            loadPromptsQuietly();
        }
    }, [updateTrigger]);

    const handleDelete = async (prompt: Prompt, event: React.MouseEvent) => {
        event.stopPropagation();

        if (!confirm(`「${prompt.name}」を削除しますか？`)) return;

        try {
            await deletePrompt(prompt.id!);
            await loadPromptsQuietly();
            // 親コンポーネントに削除を通知
            if (onPromptDeleted) {
                onPromptDeleted();
            }
        } catch (error) {
            alert('削除に失敗しました');
            console.error(error);
        }
    };

    const toggleExpand = () => {
        setIsExpanded(!isExpanded);
    };

    return (
        <div className="h-full flex flex-col bg-gradient-to-br from-gray-50 to-gray-100">
            {/* ヘッダー */}
            <div className="p-6 bg-white border-b border-purple-100">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center space-x-2">
                        <FileText className="w-6 h-6 text-blue-600" />
                        <h2 className="text-xl font-bold text-gray-900">
                            プロンプト一覧
                        </h2>
                    </div>
                    <div className="flex items-center space-x-2">
                        <button
                            onClick={onCreateClick}
                            className="p-2 hover:bg-blue-50 rounded-lg transition-colors"
                            title="新規作成"
                        >
                            <Plus className="w-5 h-5 text-blue-600" />
                        </button>
                        <button
                            onClick={loadPrompts}
                            disabled={loading}
                            className="p-2 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="更新"
                        >
                            <RefreshCw className={`w-5 h-5 text-blue-600 ${loading ? 'animate-spin' : ''}`} />
                        </button>
                        <button
                            onClick={toggleExpand}
                            className="p-2 hover:bg-blue-50 rounded-lg transition-colors"
                            title={isExpanded ? '折りたたむ' : '展開'}
                        >
                            {isExpanded ? (
                                <ChevronUp className="w-5 h-5 text-blue-600" />
                            ) : (
                                <ChevronDown className="w-5 h-5 text-blue-600" />
                            )}
                        </button>
                    </div>
                </div>
                <p className="text-xs text-gray-600">
                    {prompts.length}件のプロンプト
                </p>
            </div>

            {/* 展開時のコンテンツ */}
            {isExpanded && (
                <div className="flex-1 overflow-y-auto p-4">
                    {/* プロンプトリスト */}
                    {loading ? (
                        <div className="flex items-center justify-center h-32">
                            <div className="text-sm text-gray-500">読み込み中...</div>
                        </div>
                    ) : prompts.length === 0 ? (
                        <div className="bg-white rounded-xl p-8 shadow-sm">
                            <div className="flex flex-col items-center justify-center text-gray-400">
                                <FileText className="w-12 h-12 mb-2 opacity-50" />
                                <p className="text-sm">プロンプトがありません</p>
                                <p className="text-xs mt-1">新規作成してください</p>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {prompts.map((prompt) => (
                                <div
                                    key={prompt.id}
                                    onClick={() => onPromptClick(prompt)}
                                    className="bg-white rounded-xl p-4 shadow-sm hover:shadow-md cursor-pointer transition-all group border border-gray-100 hover:border-blue-200"
                                >
                                    <div className="flex items-start justify-between">
                                        <div className="flex-1 min-w-0 mr-2">
                                            <div className="flex items-center space-x-2">
                                                <h3 className="text-sm font-semibold text-gray-900 truncate group-hover:text-blue-700 transition-colors">
                                                    {prompt.name}
                                                </h3>
                                                {prompt.isDefault && (
                                                    <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                                                        デフォルト
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-gray-500 mt-2 line-clamp-2">
                                                {prompt.content}
                                            </p>
                                        </div>
                                        <button
                                            onClick={(e) => handleDelete(prompt, e)}
                                            className="p-2 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                                            title="削除"
                                        >
                                            <Trash2 className="w-4 h-4 text-red-600" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

