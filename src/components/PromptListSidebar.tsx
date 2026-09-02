'use client';

import React, { useCallback, useState, useEffect, useRef } from 'react';
import { FileText, RefreshCw, Plus, Trash2, Lock, XCircle } from 'lucide-react';
import { Prompt, getPrompts, deletePrompt, initializeDefaultPrompts, addDefaultPrompts } from '@/lib/prompts';
import { useAuth } from '@/hooks/useAuth';
import { getGeminiModelLabel } from '@/constants/geminiModels';
import { createLogger } from '@/lib/logger';
import { AddDefaultPromptsModal } from './AddDefaultPromptsModal';
import { Dialog } from './ui/Dialog';
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
    const [pendingDeletePrompt, setPendingDeletePrompt] = useState<Prompt | null>(null);
    const [isDeletingPrompt, setIsDeletingPrompt] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const deleteCancelButtonRef = useRef<HTMLButtonElement>(null);
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
        setPendingDeletePrompt(null);
        setIsDeletingPrompt(false);
        setActionError(null);

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

    const requestDeletePrompt = (prompt: Prompt, event: React.MouseEvent) => {
        event.stopPropagation();

        // ゲストのデフォルトプロンプトは削除不可（削除ボタン自体を出していないが多重防御）
        if (!user && prompt.ownerType === 'guest' && prompt.isDefault) {
            setActionError('共通プロンプトは削除できません。');
            return;
        }

        setActionError(null);
        setPendingDeletePrompt(prompt);
    };

    const closeDeleteDialog = () => {
        if (isDeletingPrompt) return;
        setPendingDeletePrompt(null);
    };

    const confirmDeletePrompt = async () => {
        const prompt = pendingDeletePrompt;
        if (!prompt?.id || isDeletingPrompt) return;

        // owner切替を跨いだ古いcontinuationが、共有request IDを進めて新ownerの
        // 取得を失効させたり、新しい画面のstateを書き換えたりしないための世代検査。
        const operationGeneration = ownerGenerationRef.current;
        const isOperationCurrent = () => ownerGenerationRef.current === operationGeneration;

        setIsDeletingPrompt(true);
        setActionError(null);
        try {
            await deletePrompt(prompt.id);
            if (!isOperationCurrent()) return;
            await loadPromptsQuietly();
            if (!isOperationCurrent()) return;
            setPendingDeletePrompt(null);
            // 親コンポーネントに削除を通知
            if (onPromptDeleted) {
                onPromptDeleted();
            }
        } catch (error) {
            promptListLogger.error('プロンプトの削除に失敗', error, { promptId: prompt.id });
            if (!isOperationCurrent()) return;
            setPendingDeletePrompt(null);
            setActionError('プロンプトを削除できませんでした。時間をおいて再度お試しください。');
        } finally {
            if (isOperationCurrent()) {
                setIsDeletingPrompt(false);
            }
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
        setActionError(null);
        try {
            // デフォルトプロンプトのリストを取得
            const templates = await getDefaultPrompts();
            setDefaultTemplates(templates);
            setIsModalOpen(true);
        } catch (error) {
            promptListLogger.error('デフォルトプロンプトの取得に失敗', error, { userId: user?.uid });
            setActionError('テンプレートを取得できませんでした。時間をおいて再度お試しください。');
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
            throw error; // 開いたままのモーダルがインラインエラーを表示する
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
                            プロンプトの管理
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
                                <div className="absolute left-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
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
                                        {isInitializing ? '追加中...' : 'テンプレートから追加'}
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
                {actionError && (
                    <div
                        role="alert"
                        className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
                    >
                        <span>{actionError}</span>
                        <button
                            type="button"
                            onClick={() => setActionError(null)}
                            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
                            aria-label="エラーを閉じる"
                        >
                            <XCircle className="w-4 h-4" />
                        </button>
                    </div>
                )}

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
                                className="group relative rounded-xl border border-gray-100 bg-white shadow-sm transition-all hover:border-blue-200 hover:shadow-md"
                            >
                                <div className={`p-4 ${canDeletePrompt(prompt) ? 'pr-14' : ''}`}>
                                    <div className="min-w-0">
                                        <div className="flex items-center space-x-2">
                                            <h3 className="min-w-0 text-sm font-semibold text-gray-900 truncate group-hover:text-blue-700 transition-colors">
                                                {prompt.name}
                                            </h3>
                                            {prompt.isDefault && prompt.ownerType === 'guest' && (
                                                <span
                                                    className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-600"
                                                    title="全員に共通のプロンプト（編集・削除はできません）"
                                                >
                                                    <Lock className="w-3 h-3" aria-hidden="true" />
                                                    共通
                                                    <span className="sr-only">（編集不可）</span>
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
                                </div>
                                <button
                                    type="button"
                                    onClick={() => onPromptClick(prompt)}
                                    aria-label={`「${prompt.name}」を開く`}
                                    className="absolute inset-0 z-10 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                                />
                                {canDeletePrompt(prompt) && (
                                    <button
                                        type="button"
                                        onClick={(e) => requestDeletePrompt(prompt, e)}
                                        className="absolute right-4 top-4 z-20 flex min-h-11 min-w-11 items-center justify-center rounded-lg opacity-0 transition-colors hover:bg-red-50 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600"
                                        title="削除"
                                    >
                                        <Trash2 className="w-4 h-4 text-red-600" />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* 削除確認ダイアログ */}
            {pendingDeletePrompt && (
                <Dialog
                    isOpen
                    onClose={closeDeleteDialog}
                    initialFocusRef={deleteCancelButtonRef}
                    dismissible={!isDeletingPrompt}
                    aria-labelledby="prompt-delete-dialog-title"
                    aria-describedby="prompt-delete-dialog-description"
                    className="w-[calc(100%-2rem)] max-w-md rounded-xl border-0 bg-white p-6 shadow-2xl"
                >
                    <h2
                        id="prompt-delete-dialog-title"
                        className="text-lg font-bold text-gray-900"
                    >
                        「{pendingDeletePrompt.name}」を削除しますか？
                    </h2>
                    <p
                        id="prompt-delete-dialog-description"
                        className="mt-2 text-sm leading-6 text-gray-600"
                    >
                        この操作は取り消せません。
                    </p>
                    <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <button
                            ref={deleteCancelButtonRef}
                            type="button"
                            onClick={closeDeleteDialog}
                            disabled={isDeletingPrompt}
                            className="min-h-11 rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
                        >
                            キャンセル
                        </button>
                        <button
                            type="button"
                            onClick={() => void confirmDeletePrompt()}
                            disabled={isDeletingPrompt}
                            className="min-h-11 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:opacity-50"
                        >
                            {isDeletingPrompt ? '削除中…' : '削除する'}
                        </button>
                    </div>
                </Dialog>
            )}

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
