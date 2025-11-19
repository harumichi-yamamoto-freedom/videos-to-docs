'use client';

import React, { useState, useEffect, useRef } from 'react';
import { FileText, RefreshCw, Plus, Trash2, Lock } from 'lucide-react';
import { Prompt, getPrompts, deletePrompt, initializeDefaultPrompts, addDefaultPrompts } from '@/lib/prompts';
import { useAuth } from '@/hooks/useAuth';
import { getGeminiModelLabel } from '@/constants/geminiModels';
import { createLogger } from '@/lib/logger';
import { AddDefaultPromptsModal } from './AddDefaultPromptsModal';
import { getDefaultPrompts, DefaultPromptTemplate } from '@/lib/adminSettings';

const promptListLogger = createLogger('PromptListSidebar');

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
    const { user } = useAuth();
    const [prompts, setPrompts] = useState<Prompt[]>([]);
    const [loading, setLoading] = useState(true);
    const [isInitializing, setIsInitializing] = useState(false);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [defaultTemplates, setDefaultTemplates] = useState<DefaultPromptTemplate[]>([]);
    const menuRef = useRef<HTMLDivElement>(null);

    // 静かに更新（ローディング表示なし）
    const loadPromptsQuietly = async () => {
        try {
            const data = await getPrompts();

            // プロンプトが0件の場合、デフォルトプロンプトを自動生成
            if (data.length === 0 && !isInitializing) {
                setIsInitializing(true);
                promptListLogger.info('プロンプトが0件のためデフォルトプロンプトを生成', {
                    userId: user?.uid,
                });
                await initializeDefaultPrompts();
                const newData = await getPrompts();
                setPrompts(newData);
                setIsInitializing(false);
            } else {
                setPrompts(data);
            }
        } catch (error) {
            promptListLogger.error('静的更新でのプロンプト取得に失敗', error, { userId: user?.uid });
            setIsInitializing(false);
        }
    };

    // 手動更新（ローディング表示あり）
    const loadPrompts = async () => {
        try {
            setLoading(true);
            const data = await getPrompts();

            // プロンプトが0件の場合、デフォルトプロンプトを自動生成
            if (data.length === 0 && !isInitializing) {
                setIsInitializing(true);
                promptListLogger.info('プロンプトが0件のためデフォルトプロンプトを生成', {
                    userId: user?.uid,
                });
                await initializeDefaultPrompts();
                const newData = await getPrompts();
                setPrompts(newData);
                setIsInitializing(false);
            } else {
                setPrompts(data);
            }

            // 最低0.5秒はローディング表示
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            promptListLogger.error('プロンプト一覧の取得に失敗', error, { userId: user?.uid });
            setIsInitializing(false);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadPrompts();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 外部からの更新トリガーを監視
    useEffect(() => {
        if (updateTrigger !== undefined && updateTrigger > 0) {
            loadPromptsQuietly();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [updateTrigger]);

    // メニュー外クリックで閉じる
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setIsMenuOpen(false);
            }
        };

        if (isMenuOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isMenuOpen]);

    const handleDelete = async (prompt: Prompt, event: React.MouseEvent) => {
        event.stopPropagation();

        // ゲストのデフォルトプロンプトは削除不可
        if (!user && prompt.ownerType === 'guest' && prompt.isDefault) {
            alert('デフォルトプロンプトは削除できません');
            return;
        }

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
            promptListLogger.error('プロンプトの削除に失敗', error, { promptId: prompt.id });
        }
    };

    // プロンプトが削除可能かどうか
    const canDeletePrompt = (prompt: Prompt): boolean => {
        // ゲストのデフォルトプロンプトは削除不可
        return !(prompt.ownerType === 'guest' && prompt.isDefault);
    };

    // プラスボタンのクリックハンドラー
    const handlePlusButtonClick = () => {
        if (!user) {
            // ゲストの場合: 直接新規作成モーダルを開く
            onCreateClick();
        } else {
            // ログインユーザーの場合: ドロップダウンメニューを開く
            setIsMenuOpen(!isMenuOpen);
        }
    };

    // デフォルトプロンプトを追加（モーダルを開く）
    const handleAddDefaults = async () => {
        setIsMenuOpen(false);
        try {
            // デフォルトプロンプトのリストを取得
            const templates = await getDefaultPrompts();
            setDefaultTemplates(templates);
            setIsModalOpen(true);
        } catch (error) {
            promptListLogger.error('デフォルトプロンプトの取得に失敗', error, { userId: user?.uid });
            alert('デフォルトプロンプトの取得に失敗しました');
        }
    };

    // モーダルから選択されたプロンプトを追加
    const handleAddSelectedPrompts = async (selectedTemplateNames: string[]) => {
        setIsInitializing(true);
        try {
            await addDefaultPrompts(selectedTemplateNames);
            await loadPromptsQuietly();
        } catch (error) {
            promptListLogger.error('デフォルトプロンプトの追加に失敗', error, { userId: user?.uid });
            alert('デフォルトプロンプトの追加に失敗しました');
            throw error; // モーダルにエラーを伝える
        } finally {
            setIsInitializing(false);
        }
    };

    // モーダルを閉じる
    const handleCloseModal = () => {
        setIsModalOpen(false);
        setDefaultTemplates([]);
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
                        <div className="relative" ref={menuRef}>
                            <button
                                onClick={handlePlusButtonClick}
                                className="p-2 hover:bg-blue-50 rounded-lg transition-colors"
                                title={user ? "プロンプト作成メニュー" : "新規作成"}
                            >
                                <Plus className="w-5 h-5 text-blue-600" />
                            </button>

                            {/* ログインユーザー用ドロップダウンメニュー */}
                            {user && isMenuOpen && (
                                <div className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
                                    <button
                                        onClick={() => {
                                            setIsMenuOpen(false);
                                            onCreateClick();
                                        }}
                                        className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 transition-colors"
                                    >
                                        新規作成
                                    </button>
                                    <button
                                        onClick={handleAddDefaults}
                                        disabled={isInitializing}
                                        className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {isInitializing ? '追加中...' : 'デフォルトプロンプトを追加'}
                                    </button>
                                </div>
                            )}
                        </div>
                        <button
                            onClick={loadPrompts}
                            disabled={loading}
                            className="p-2 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="更新"
                        >
                            <RefreshCw className={`w-5 h-5 text-blue-600 ${loading ? 'animate-spin' : ''}`} />
                        </button>
                    </div>
                </div>
                <p className="text-xs text-gray-600">
                    {prompts.length}件のプロンプト
                </p>
            </div>

            {/* コンテンツ */}
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
                                                <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded flex items-center gap-1">
                                                    {prompt.ownerType === 'guest' && <Lock className="w-3 h-3" />}
                                                    デフォルト
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-gray-500 mt-2 line-clamp-2">
                                            {prompt.content}
                                        </p>
                                        <p className="text-[11px] text-gray-500 mt-1">
                                            Geminiモデル: {getGeminiModelLabel(prompt.model)}
                                        </p>
                                    </div>
                                    {canDeletePrompt(prompt) && (
                                        <button
                                            onClick={(e) => handleDelete(prompt, e)}
                                            className="p-2 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                                            title="削除"
                                        >
                                            <Trash2 className="w-4 h-4 text-red-600" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* デフォルトプロンプト追加モーダル */}
            <AddDefaultPromptsModal
                isOpen={isModalOpen}
                onClose={handleCloseModal}
                onAdd={handleAddSelectedPrompts}
                templates={defaultTemplates}
            />
        </div>
    );
};

