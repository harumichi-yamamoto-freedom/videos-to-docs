'use client';

import React, { useState, useEffect } from 'react';
import { getAdminSettings, updateAdminSettings, AdminSettings } from '@/lib/adminSettings';
import { Save } from 'lucide-react';
import { getCurrentUserId } from '@/lib/auth';
import { logAudit } from '@/lib/auditLog';

export default function SettingsPanel() {
    const [settings, setSettings] = useState<AdminSettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        loadSettings();
    }, []);

    const loadSettings = async () => {
        try {
            setLoading(true);
            const data = await getAdminSettings();
            setSettings(data);
        } catch (error) {
            console.error('設定読み込みエラー:', error);
            alert('設定の取得に失敗しました');
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        if (!settings) return;

        try {
            setSaving(true);
            const userId = getCurrentUserId();
            await updateAdminSettings(settings, userId);
            await logAudit('admin_settings_update', 'settings', 'config', settings);
            alert('設定を保存しました');
        } catch (error) {
            console.error('設定保存エラー:', error);
            alert('設定の保存に失敗しました');
        } finally {
            setSaving(false);
        }
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
                <p className="text-gray-600 text-sm mt-1">プロンプトと文書のサイズ上限を設定</p>
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

                {/* 保存ボタン */}
                <div className="flex justify-end pt-4">
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                        <Save className="w-5 h-5" />
                        {saving ? '保存中...' : '設定を保存'}
                    </button>
                </div>
            </div>
        </div>
    );
}

