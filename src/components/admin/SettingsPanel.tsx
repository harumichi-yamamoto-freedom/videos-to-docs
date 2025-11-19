'use client';

import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
    getAdminSettings,
    updateAdminSettings,
    AdminSettings,
    DefaultPromptTemplate,
    getDefaultPrompts,
    updateDefaultPrompts
} from '@/lib/adminSettings';
import { Save, Plus, Trash2 } from 'lucide-react';
import { getCurrentUserId } from '@/lib/auth';
import { logAudit } from '@/lib/auditLog';
import DefaultPromptEditModal from './DefaultPromptEditModal';
import { SettingsPanelRef } from '@/app/admin/page';
import { createLogger } from '@/lib/logger';
import { getGeminiModelLabel } from '@/constants/geminiModels';

const adminSettingsPanelLogger = createLogger('AdminSettingsPanel');

const SettingsPanel = forwardRef<SettingsPanelRef, object>((props, ref) => {
    const [settings, setSettings] = useState<AdminSettings | null>(null);
    const [defaultPrompts, setDefaultPrompts] = useState<DefaultPromptTemplate[]>([]);
    const [originalSettings, setOriginalSettings] = useState<AdminSettings | null>(null);
    const [originalPrompts, setOriginalPrompts] = useState<DefaultPromptTemplate[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    // モーダル関連
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingPromptIndex, setEditingPromptIndex] = useState<number | null>(null);
    const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');

    useEffect(() => {
        loadSettings();
    }, []);

    const loadSettings = async () => {
        try {
            setLoading(true);
            const [settingsData, promptsData] = await Promise.all([
                getAdminSettings(),
                getDefaultPrompts()
            ]);
            setSettings(settingsData);
            setDefaultPrompts(promptsData);
            setOriginalSettings(settingsData);
            setOriginalPrompts(JSON.parse(JSON.stringify(promptsData)));
        } catch (error) {
            adminSettingsPanelLogger.error('設定の読み込みに失敗', error);
            alert('設定の取得に失敗しました');
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

        try {
            setSaving(true);
            const userId = getCurrentUserId();

            // 設定とデフォルトプロンプトを両方保存
            await Promise.all([
                updateAdminSettings(settings, userId),
                updateDefaultPrompts(defaultPrompts, userId)
            ]);

            // 監査ログに必要な情報だけを抽出
            await logAudit('admin_settings_update', 'settings', 'config', {
                maxPromptSize: settings.maxPromptSize,
                maxDocumentSize: settings.maxDocumentSize,
                defaultPromptsCount: defaultPrompts.length,
            });

            // 保存成功後、オリジナルの値を更新
            setOriginalSettings(settings);
            setOriginalPrompts(JSON.parse(JSON.stringify(defaultPrompts)));

            alert('設定を保存しました');
        } catch (error) {
            adminSettingsPanelLogger.error('設定の保存に失敗', error);
            alert('設定の保存に失敗しました');
        } finally {
            setSaving(false);
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
        const prompt = defaultPrompts[index];
        if (!confirm(`「${prompt.name}」を削除しますか？`)) return;
        setDefaultPrompts(defaultPrompts.filter((_, i) => i !== index));
    };

    if (loading || !settings) {
        return (
            <div className="text-center py-12">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto mb-4"></div>
                <p className="text-gray-600">読み込み中...</p>
            </div>
        );
    }

    return (
        <div>
            <div className="mb-6">
                <h2 className="text-2xl font-bold text-gray-900">システム設定</h2>
                <p className="text-gray-600 text-sm mt-1">プロンプトと文書のサイズ上限、デフォルトプロンプトを設定</p>
            </div>

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
                                    {prompt.model && (
                                        <p className="text-xs text-gray-400 mt-1">
                                            Geminiモデル: {getGeminiModelLabel(prompt.model)}
                                        </p>
                                    )}
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
                        disabled={saving || !hasUnsavedChanges()}
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
        </div>
    );
});

SettingsPanel.displayName = 'SettingsPanel';

export default SettingsPanel;
