'use client';

import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
    getAdminSettings,
    updateAdminSettings,
    retryGuestDefaultPromptsSync,
} from '@/lib/adminSettings';
import type { AdminSettings, DefaultPromptTemplate } from '@/lib/adminSettings';
import { Save, Plus, Trash2 } from 'lucide-react';
import { getCurrentUserId } from '@/lib/auth';
import { logAudit } from '@/lib/auditLog';
import DefaultPromptEditModal from './DefaultPromptEditModal';
import { Dialog } from '@/components/ui/Dialog';
import type { SettingsPanelRef } from '@/app/admin/page';
import { createLogger } from '@/lib/logger';
import { getGeminiModelLabel } from '@/constants/geminiModels';
import {
    canonicalizeThinkingLevel,
    THINKING_LEVELS,
} from '@/constants/geminiThinking';

const adminSettingsPanelLogger = createLogger('AdminSettingsPanel');

// このパネルは管理者画面に1枚しか置かれないため、静的 id で衝突しない。
const DELETE_PROMPT_DIALOG_TITLE_ID = 'admin-settings-delete-prompt-title';
const DELETE_PROMPT_DIALOG_DESCRIPTION_ID = 'admin-settings-delete-prompt-description';

type Feedback = {
    kind: 'success' | 'warning' | 'error';
    message: string;
};

function getThinkingLevelLabel(level: DefaultPromptTemplate['thinkingLevel']): string {
    const canonicalLevel = canonicalizeThinkingLevel(level);
    return THINKING_LEVELS.find(option => option.id === canonicalLevel)?.label ?? canonicalLevel;
}

const SettingsPanel = forwardRef<SettingsPanelRef, object>((props, ref) => {
    const [settings, setSettings] = useState<AdminSettings | null>(null);
    const [defaultPrompts, setDefaultPrompts] = useState<DefaultPromptTemplate[]>([]);
    const [originalSettings, setOriginalSettings] = useState<AdminSettings | null>(null);
    const [originalPrompts, setOriginalPrompts] = useState<DefaultPromptTemplate[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<Feedback | null>(null);
    const [guestSyncFailed, setGuestSyncFailed] = useState(false);
    const [syncingGuestPrompts, setSyncingGuestPrompts] = useState(false);

    // モーダル関連
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingPromptIndex, setEditingPromptIndex] = useState<number | null>(null);
    const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
    const [pendingDeletePromptIndex, setPendingDeletePromptIndex] = useState<number | null>(null);

    useEffect(() => {
        loadSettings();
    }, []);

    const loadSettings = async () => {
        try {
            setLoading(true);
            setLoadError(null);
            setFeedback(null);
            setGuestSyncFailed(false);
            setSettings(null);
            setOriginalSettings(null);
            setDefaultPrompts([]);
            setOriginalPrompts([]);
            const settingsData = await getAdminSettings();
            const promptsData = settingsData.defaultPrompts ?? [];
            setSettings(settingsData);
            setDefaultPrompts(promptsData);
            setOriginalSettings(settingsData);
            setOriginalPrompts(JSON.parse(JSON.stringify(promptsData)));
            const syncUnresolved = settingsData.lastGuestSyncStatus === 'failed'
                || settingsData.lastGuestSyncStatus === 'pending';
            setGuestSyncFailed(syncUnresolved);

            if (syncUnresolved) {
                setFeedback({
                    kind: 'warning',
                    message: settingsData.lastGuestSyncStatus === 'failed'
                        ? '前回のゲストユーザー向けデフォルトプロンプト同期が失敗しています。'
                        : 'ゲストユーザー向けデフォルトプロンプト同期が完了していません。',
                });
            }
        } catch (error) {
            adminSettingsPanelLogger.error('設定の読み込みに失敗', error);
            setLoadError('設定を読み込めませんでした。編集を開始するには再試行してください。');
        } finally {
            setLoading(false);
        }
    };

    // 変更検知
    const hasUnsavedChanges = () => {
        if (!settings || !originalSettings) return false;

        const settingsChanged =
            settings.maxPromptSize !== originalSettings.maxPromptSize ||
            settings.maxDocumentSize !== originalSettings.maxDocumentSize;

        const promptsChanged = JSON.stringify(defaultPrompts) !== JSON.stringify(originalPrompts);

        return settingsChanged || promptsChanged;
    };

    // 親コンポーネントにhasUnsavedChangesを公開
    useImperativeHandle(ref, () => ({
        hasUnsavedChanges,
    }));

    const handleSave = async () => {
        if (!settings) return;

        // 同名テンプレートは決定論的IDが衝突しゲスト同期で1件に上書きされるため保存前に拒否する。
        const trimmedNames = defaultPrompts.map(prompt => prompt.name.trim());
        const duplicateName = trimmedNames.find(
            (name, index) => name !== '' && trimmedNames.indexOf(name) !== index,
        );
        if (duplicateName) {
            setFeedback({
                kind: 'error',
                message: `デフォルトプロンプト名「${duplicateName}」が重複しています。名前は一意にしてください。`,
            });
            return;
        }

        try {
            setSaving(true);
            setFeedback(null);
            const userId = getCurrentUserId();
            const settingsToSave: AdminSettings = {
                ...settings,
                defaultPrompts,
            };

            const result = await updateAdminSettings(settingsToSave, userId);
            setSettings(settingsToSave);
            setOriginalSettings(settingsToSave);
            setOriginalPrompts(JSON.parse(JSON.stringify(defaultPrompts)));
            const syncFailed = result.guestPromptsSync === 'failed';
            setGuestSyncFailed(syncFailed);
            setFeedback(syncFailed
                ? {
                    kind: 'warning',
                    message: '設定は保存しましたが、ゲストユーザーのデフォルトプロンプトを同期できませんでした。',
                }
                : {
                    kind: 'success',
                    message: '設定を保存しました。',
                });

            try {
                await logAudit('admin_settings_update', 'settings', 'config', {
                    maxPromptSize: settings.maxPromptSize,
                    maxDocumentSize: settings.maxDocumentSize,
                    defaultPromptsCount: defaultPrompts.length,
                });
            } catch (auditError) {
                adminSettingsPanelLogger.error('設定保存の監査ログ記録に失敗', auditError);
                setFeedback({
                    kind: 'warning',
                    message: syncFailed
                        ? '設定は保存しましたが、ゲストユーザーのデフォルトプロンプト同期と監査ログ記録に失敗しました。'
                        : '設定は保存しましたが、監査ログを記録できませんでした。',
                });
            }
        } catch (error) {
            adminSettingsPanelLogger.error('設定の保存に失敗', error);
            setFeedback({
                kind: 'error',
                message: '設定を保存できませんでした。入力内容を確認して、再試行してください。',
            });
        } finally {
            setSaving(false);
        }
    };

    const handleRetryGuestSync = async () => {
        try {
            setSyncingGuestPrompts(true);
            setFeedback(null);
            await retryGuestDefaultPromptsSync(getCurrentUserId());
            setGuestSyncFailed(false);
            setFeedback({
                kind: 'success',
                message: 'ゲストユーザーのデフォルトプロンプトを同期しました。',
            });
        } catch (error) {
            adminSettingsPanelLogger.error('ゲストデフォルトプロンプトの再同期に失敗', error);
            setGuestSyncFailed(true);
            setFeedback({
                kind: 'error',
                message: 'ゲストユーザーのデフォルトプロンプトを同期できませんでした。再試行してください。',
            });
        } finally {
            setSyncingGuestPrompts(false);
        }
    };

    // モーダル操作
    const handleAddPrompt = () => {
        setModalMode('create');
        setEditingPromptIndex(null);
        setIsModalOpen(true);
    };

    const handleEditPrompt = (index: number) => {
        setModalMode('edit');
        setEditingPromptIndex(index);
        setIsModalOpen(true);
    };

    const handleSavePrompt = (prompt: DefaultPromptTemplate) => {
        if (modalMode === 'create') {
            setDefaultPrompts([...defaultPrompts, prompt]);
        } else if (editingPromptIndex !== null) {
            const updated = [...defaultPrompts];
            updated[editingPromptIndex] = prompt;
            setDefaultPrompts(updated);
        }
        setIsModalOpen(false);
    };

    const handleDeletePrompt = () => {
        if (editingPromptIndex !== null) {
            setDefaultPrompts(defaultPrompts.filter((_, i) => i !== editingPromptIndex));
        }
        setIsModalOpen(false);
    };

    const handleDeletePromptDirect = (index: number, e: React.MouseEvent) => {
        e.stopPropagation();
        // 破棄の判断はダイアログ内で確認する（行クリックの編集モーダルとは別経路）。
        setPendingDeletePromptIndex(index);
    };

    const confirmDeletePrompt = () => {
        if (pendingDeletePromptIndex === null) return;
        setDefaultPrompts(defaultPrompts.filter((_, i) => i !== pendingDeletePromptIndex));
        setPendingDeletePromptIndex(null);
    };

    if (loading) {
        return (
            <div className="text-center py-12">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto mb-4"></div>
                <p className="text-gray-600">読み込み中...</p>
            </div>
        );
    }

    if (loadError || !settings) {
        return (
            <div>
                <div className="mb-6">
                    <h2 className="text-2xl font-bold text-gray-900">システム設定</h2>
                    <p className="text-gray-600 text-sm mt-1">プロンプトと文書のサイズ上限、デフォルトプロンプトを設定</p>
                </div>
                <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-800">
                    <p className="font-medium">{loadError ?? '設定を読み込めませんでした。'}</p>
                    <button
                        type="button"
                        onClick={loadSettings}
                        className="mt-4 rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-800"
                    >
                        読み込みを再試行
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div>
            <div className="mb-6">
                <h2 className="text-2xl font-bold text-gray-900">システム設定</h2>
                <p className="text-gray-600 text-sm mt-1">プロンプトと文書のサイズ上限、デフォルトプロンプトを設定</p>
            </div>

            {feedback && (
                <div
                    role={feedback.kind === 'success' ? 'status' : 'alert'}
                    className={`mb-6 rounded-lg border p-4 ${feedback.kind === 'success'
                        ? 'border-green-200 bg-green-50 text-green-800'
                        : feedback.kind === 'warning'
                            ? 'border-amber-200 bg-amber-50 text-amber-800'
                            : 'border-red-200 bg-red-50 text-red-800'
                        }`}
                >
                    <p className="font-medium">{feedback.message}</p>
                    {guestSyncFailed && (
                        <button
                            type="button"
                            onClick={handleRetryGuestSync}
                            disabled={syncingGuestPrompts}
                            className="mt-3 rounded-lg bg-amber-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {syncingGuestPrompts ? '同期中...' : '同期を再試行'}
                        </button>
                    )}
                </div>
            )}

            <div className="space-y-6">
                {/* プロンプトサイズ上限 */}
                <div className="bg-gray-50 p-6 rounded-lg">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                        プロンプトサイズ上限（KB）
                    </label>
                    <input
                        type="number"
                        value={(settings.maxPromptSize / 1024).toFixed(0)}
                        onChange={(e) =>
                            setSettings({
                                ...settings,
                                maxPromptSize: Number(e.target.value) * 1024,
                            })
                        }
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                    <p className="text-xs text-gray-500 mt-2">
                        現在: {(settings.maxPromptSize / 1024).toFixed(2)} KB
                    </p>
                </div>

                {/* 文書サイズ上限 */}
                <div className="bg-gray-50 p-6 rounded-lg">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                        文書サイズ上限（KB）
                    </label>
                    <input
                        type="number"
                        value={(settings.maxDocumentSize / 1024).toFixed(0)}
                        onChange={(e) =>
                            setSettings({
                                ...settings,
                                maxDocumentSize: Number(e.target.value) * 1024,
                            })
                        }
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                    <p className="text-xs text-gray-500 mt-2">
                        現在: {(settings.maxDocumentSize / 1024).toFixed(2)} KB
                    </p>
                </div>

                {/* デフォルトプロンプト */}
                <div className="bg-gray-50 p-6 rounded-lg">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h3 className="text-lg font-medium text-gray-900">デフォルトプロンプト</h3>
                            <p className="text-xs text-gray-500 mt-1">
                                新規ユーザーに自動的に作成されるプロンプトテンプレート
                            </p>
                        </div>
                        <button
                            onClick={handleAddPrompt}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
                        >
                            <Plus className="w-4 h-4" />
                            追加
                        </button>
                    </div>

                    <div className="space-y-3">
                        {defaultPrompts.map((prompt, index) => (
                            <div
                                key={index}
                                className="bg-white p-4 rounded-lg border border-gray-200 hover:shadow-md transition-shadow cursor-pointer relative group"
                                onClick={() => handleEditPrompt(index)}
                            >
                                <button
                                    onClick={(e) => handleDeletePromptDirect(index, e)}
                                    className="absolute top-3 right-3 p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                                    title="削除"
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                                <div className="pr-10">
                                    <h4 className="font-medium text-gray-900">{prompt.name}</h4>
                                    <p className="text-sm text-gray-500 mt-1 line-clamp-2">
                                        {prompt.content.substring(0, 100)}
                                        {prompt.content.length > 100 ? '...' : ''}
                                    </p>
                                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400">
                                        <span>
                                            Geminiモデル: {getGeminiModelLabel(prompt.model)}
                                        </span>
                                        <span>
                                            思考レベル: {getThinkingLevelLabel(prompt.thinkingLevel)}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        ))}

                        {defaultPrompts.length === 0 && (
                            <div className="text-center py-8 text-gray-500">
                                デフォルトプロンプトがありません。「追加」ボタンで作成してください。
                            </div>
                        )}
                    </div>
                </div>

                {/* 保存ボタン */}
                <div className="flex items-center justify-between pt-4">
                    {hasUnsavedChanges() && (
                        <div className="flex items-center gap-2 text-amber-600">
                            <span className="text-sm font-medium">⚠️ 保存されていない変更があります</span>
                        </div>
                    )}
                    {!hasUnsavedChanges() && <div></div>}
                    <button
                        onClick={handleSave}
                        disabled={saving || syncingGuestPrompts || !hasUnsavedChanges()}
                        className="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Save className="w-5 h-5" />
                        {saving ? '保存中...' : '設定を保存'}
                    </button>
                </div>
            </div>

            {/* モーダル */}
            <DefaultPromptEditModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                prompt={editingPromptIndex !== null ? defaultPrompts[editingPromptIndex] : null}
                onSave={handleSavePrompt}
                onDelete={modalMode === 'edit' ? handleDeletePrompt : undefined}
                mode={modalMode}
            />

            {/* 行の削除ボタンからの確認。開いている間だけマウントし、
                閉じたら Dialog がトリガー（行の削除ボタン）へフォーカスを返す。 */}
            {pendingDeletePromptIndex !== null && (
                <Dialog
                    isOpen
                    onClose={() => setPendingDeletePromptIndex(null)}
                    role="alertdialog"
                    aria-labelledby={DELETE_PROMPT_DIALOG_TITLE_ID}
                    aria-describedby={DELETE_PROMPT_DIALOG_DESCRIPTION_ID}
                    className="w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
                >
                    <div className="flex flex-col bg-white p-6 sm:p-8">
                        <div className="space-y-2">
                            <h2 id={DELETE_PROMPT_DIALOG_TITLE_ID} className="text-xl font-bold text-gray-900">
                                {`「${defaultPrompts[pendingDeletePromptIndex]?.name ?? ''}」を削除しますか？`}
                            </h2>
                            <p id={DELETE_PROMPT_DIALOG_DESCRIPTION_ID} className="text-sm leading-relaxed text-gray-600">
                                一覧から削除します。「設定を保存」を押すまでは確定されません。
                            </p>
                        </div>
                        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
                            <button
                                type="button"
                                data-dialog-initial-focus
                                onClick={() => setPendingDeletePromptIndex(null)}
                                className="min-h-11 rounded-lg bg-gray-700 px-6 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
                            >
                                キャンセル
                            </button>
                            <button
                                type="button"
                                onClick={confirmDeletePrompt}
                                className="min-h-11 rounded-lg bg-red-600 px-6 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
                            >
                                削除する
                            </button>
                        </div>
                    </div>
                </Dialog>
            )}
        </div>
    );
});

SettingsPanel.displayName = 'SettingsPanel';

export default SettingsPanel;
