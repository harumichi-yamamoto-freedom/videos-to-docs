'use client';

import React, { useCallback, useState, useEffect, useRef } from 'react';
import { FileText, RefreshCw, Plus, Trash2, Lock } from 'lucide-react';
import { Prompt, getPrompts, deletePrompt, initializeDefaultPrompts, addDefaultPrompts } from '@/lib/prompts';
import { useAuth } from '@/hooks/useAuth';
import { getGeminiModelLabel } from '@/constants/geminiModels';
import { createLogger } from '@/lib/logger';
import { AddDefaultPromptsModal } from './AddDefaultPromptsModal';
import { getDefaultPrompts, DefaultPromptTemplate } from '@/lib/adminSettings';

const promptListLogger = createLogger('PromptListSidebar');
type PromptLoadStatus = 'loading' | 'success' | 'error';

interface PromptCollectionState {
    ownerKey: string | null;
    status: PromptLoadStatus;
    prompts: Prompt[];
    refreshWarning?: string;
}

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
    const { user, loading: authLoading } = useAuth();
    const ownerType = user ? 'user' : 'guest';
    const ownerId = user?.uid ?? 'GUEST';
    // ownerType も含め、uid が "GUEST" のユーザーとゲストを別世代として扱う。
    const ownerKey = authLoading ? null : JSON.stringify([ownerType, ownerId]);
    const [collectionState, setCollectionState] = useState<PromptCollectionState>({
        ownerKey: null,
        status: 'loading',
        prompts: [],
    });
    const [isInitializing, setIsInitializing] = useState(false);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [defaultTemplates, setDefaultTemplates] = useState<DefaultPromptTemplate[]>([]);
    const menuRef = useRef<HTMLDivElement>(null);
    const ownerGenerationRef = useRef(0);
    const requestIdRef = useRef(0);
    const ownerKeyRef = useRef(ownerKey);
    const successfulOwnerKeyRef = useRef<string | null>(null);
    const successfulPromptsRef = useRef<Prompt[]>([]);
    const initializationRef = useRef<{
        ownerKey: string;
        promise: Promise<void>;
    } | null>(null);

    ownerKeyRef.current = ownerKey;

    const invalidatePendingRequests = useCallback(() => {
        ownerGenerationRef.current += 1;
        requestIdRef.current += 1;
    }, []);

    const visibleState: PromptCollectionState = collectionState.ownerKey === ownerKey
        ? collectionState
        : {
            ownerKey,
            status: 'loading',
            prompts: [],
        };
    const prompts = visibleState.prompts;
    const loadStatus = visibleState.status;

    const loadPromptsForOwner = useCallback(async (
        requestedOwnerKey: string,
        generation: number,
        showLoading: boolean,
    ) => {
        const requestId = ++requestIdRef.current;
        const isCurrentRequest = () => (
            ownerGenerationRef.current === generation
            && requestIdRef.current === requestId
            && ownerKeyRef.current === requestedOwnerKey
        );

        if (showLoading && isCurrentRequest()) {
            setCollectionState(previous => ({
                ownerKey: requestedOwnerKey,
                status: 'loading',
                prompts: previous.ownerKey === requestedOwnerKey ? previous.prompts : [],
            }));
        }

        try {
            let data = await getPrompts();
            if (!isCurrentRequest()) return;

            // プロンプトが0件の場合、デフォルトプロンプトを自動生成
            if (data.length === 0) {
                let initialization = initializationRef.current;
                if (!initialization || initialization.ownerKey !== requestedOwnerKey) {
                    initialization = {
                        ownerKey: requestedOwnerKey,
                        promise: initializeDefaultPrompts(ownerType, ownerId),
                    };
                    initializationRef.current = initialization;
                    setIsInitializing(true);
                    promptListLogger.info('プロンプトが0件のためデフォルトプロンプトを生成', {
                        ownerKey: requestedOwnerKey,
                    });
                }

                try {
                    await initialization.promise;
                } finally {
                    if (initializationRef.current === initialization) {
                        initializationRef.current = null;
                        if (ownerKeyRef.current === requestedOwnerKey) {
                            setIsInitializing(false);
                        }
                    }
                }
                if (!isCurrentRequest()) return;

                data = await getPrompts();
                if (!isCurrentRequest()) return;
            }

            if (showLoading) {
                // 手動更新では急な点滅を避けるため、従来どおり最低0.5秒表示する。
                await new Promise(resolve => setTimeout(resolve, 500));
                if (!isCurrentRequest()) return;
            }

            successfulOwnerKeyRef.current = requestedOwnerKey;
            successfulPromptsRef.current = data;
            setCollectionState({
                ownerKey: requestedOwnerKey,
                status: 'success',
                prompts: data,
            });
        } catch (error) {
            if (!isCurrentRequest()) return;

            promptListLogger.error(
                showLoading
                    ? 'プロンプト一覧の取得に失敗'
                    : '静かな更新でのプロンプト取得に失敗',
                error,
                { ownerKey: requestedOwnerKey },
            );
            if (showLoading || successfulOwnerKeyRef.current !== requestedOwnerKey) {
                setCollectionState(previous => ({
                    ownerKey: requestedOwnerKey,
                    status: 'error',
                    prompts: previous.ownerKey === requestedOwnerKey ? previous.prompts : [],
                }));
                return;
            }

            // quiet更新が手動更新中のloadingを追い越して失敗しても、最後の成功結果へ戻す。
            // 一時的な表示状態ではなく成功スナップショットの有無で非遮断かを決める。
            setCollectionState(previous => {
                if (previous.ownerKey !== requestedOwnerKey) return previous;
                return {
                    ...previous,
                    status: 'success',
                    prompts: successfulPromptsRef.current,
                    refreshWarning: '最新化失敗：現在のプロンプト一覧を表示しています。',
                };
            });
        }
    }, [ownerId, ownerType]);

    // 静かに更新（ローディング表示なし）
    const loadPromptsQuietly = () => ownerKey === null
        ? Promise.resolve()
        : loadPromptsForOwner(ownerKey, ownerGenerationRef.current, false);

    // 手動更新（ローディング表示あり）
    const loadPrompts = () => ownerKey === null
        ? Promise.resolve()
        : loadPromptsForOwner(ownerKey, ownerGenerationRef.current, true);

    useEffect(() => {
        const generation = ++ownerGenerationRef.current;
        ++requestIdRef.current;
        successfulOwnerKeyRef.current = null;
        successfulPromptsRef.current = [];
        setCollectionState({
            ownerKey,
            status: 'loading',
            prompts: [],
        });
        setIsInitializing(false);

        if (ownerKey === null) return;

        void loadPromptsForOwner(ownerKey, generation, true);
        return () => {
            invalidatePendingRequests();
        };
    }, [invalidatePendingRequests, loadPromptsForOwner, ownerKey]);

    // 外部からの更新トリガーを監視
    useEffect(() => {
        if (updateTrigger !== undefined && updateTrigger > 0) {
            void loadPromptsQuietly();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ownerKey, updateTrigger]);

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
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
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
                                className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                                title={user ? "プロンプト作成メニュー" : "新規プロンプト"}
                                aria-haspopup={user ? 'menu' : undefined}
                                aria-expanded={user ? isMenuOpen : undefined}
                            >
                                <Plus className="w-5 h-5 text-blue-600" />
                                <span>新規プロンプト</span>
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
                            disabled={loadStatus === 'loading'}
                            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg transition-colors hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                            title="更新"
                            aria-label="プロンプト一覧を更新"
                        >
                            <RefreshCw className={`w-5 h-5 text-blue-600 ${loadStatus === 'loading' ? 'animate-spin' : ''}`} />
                        </button>
                    </div>
                </div>
                {loadStatus === 'loading' ? (
                    <div
                        className="h-3 w-24 animate-pulse rounded bg-gray-200"
                        role="status"
                        aria-label="プロンプト件数を読み込み中"
                    />
                ) : loadStatus === 'success' ? (
                    <p className="text-xs text-gray-600">
                        {prompts.length}件のプロンプト
                    </p>
                ) : (
                    <p className="text-xs text-red-600">プロンプト件数を取得できませんでした</p>
                )}
                {visibleState.refreshWarning && (
                    <p
                        role="status"
                        aria-live="polite"
                        className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                    >
                        {visibleState.refreshWarning}
                    </p>
                )}
            </div>

            {/* コンテンツ */}
            <div className="flex-1 overflow-y-auto p-4">
                {/* プロンプトリスト */}
                {loadStatus === 'loading' ? (
                    <div className="flex items-center justify-center h-32">
                        <div className="text-sm text-gray-500">読み込み中...</div>
                    </div>
                ) : loadStatus === 'error' ? (
                    <div role="alert" className="rounded-xl border border-red-100 bg-white p-8 text-center shadow-sm">
                        <FileText className="mx-auto mb-3 h-12 w-12 text-red-300" />
                        <p className="text-sm font-medium text-gray-900">プロンプト一覧を取得できませんでした</p>
                        <p className="mt-1 text-xs text-gray-600">通信状況をご確認のうえ、再度お試しください。</p>
                        <button
                            type="button"
                            onClick={loadPrompts}
                            className="mt-4 min-h-11 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                        >
                            再読み込み
                        </button>
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
