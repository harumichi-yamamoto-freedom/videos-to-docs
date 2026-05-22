'use client';

import React, { useState } from 'react';
import { X, Send, Bell } from 'lucide-react';
import {
    createSystemNotification,
    NotificationSeverity,
} from '@/lib/systemNotifications';
import { useAuth } from '@/hooks/useAuth';
import { createLogger } from '@/lib/logger';

const adminCreateModalLogger = createLogger('AdminNotificationCreateModal');

interface AdminNotificationCreateModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreated?: () => void;
}

export const AdminNotificationCreateModal: React.FC<AdminNotificationCreateModalProps> = ({
    isOpen,
    onClose,
    onCreated,
}) => {
    const { user } = useAuth();
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [severity, setSeverity] = useState<NotificationSeverity>('info');
    const [saving, setSaving] = useState(false);

    // モーダルが開いたタイミングでフォームをリセット（Adjusting state during render）
    const [lastOpen, setLastOpen] = useState(isOpen);
    if (isOpen !== lastOpen) {
        setLastOpen(isOpen);
        if (isOpen) {
            setTitle('');
            setBody('');
            setSeverity('info');
        }
    }

    if (!isOpen) return null;

    const hasDraft = title.trim().length > 0 || body.trim().length > 0;

    const handleClose = () => {
        if (hasDraft) {
            if (!confirm('入力内容が破棄されます。閉じますか？')) return;
        }
        onClose();
    };

    const handlePublish = async () => {
        if (!user?.uid) return;
        if (!title.trim() || !body.trim()) {
            alert('タイトルと本文を入力してください');
            return;
        }
        try {
            setSaving(true);
            await createSystemNotification({
                title: title.trim(),
                body: body.trim(),
                severity,
                published: true,
                publishedBy: user.uid,
            });
            onCreated?.();
            onClose();
        } catch (error) {
            adminCreateModalLogger.error('通知の作成に失敗', error);
            alert('通知の作成に失敗しました');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50 backdrop-blur-sm"
            onClick={handleClose}
        >
            <div
                className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden border border-gray-200"
                onClick={e => e.stopPropagation()}
            >
                {/* ヘッダー */}
                <div className="flex items-center justify-between p-6 border-b bg-gradient-to-r from-purple-50 to-pink-50">
                    <div className="flex items-center gap-2">
                        <Bell className="w-6 h-6 text-purple-600" />
                        <h2 className="text-xl font-bold text-gray-900">新しいお知らせを作成</h2>
                    </div>
                    <button
                        onClick={handleClose}
                        className="p-2 hover:bg-white rounded-lg transition-colors shadow-sm"
                        title="閉じる"
                    >
                        <X className="w-5 h-5 text-gray-600" />
                    </button>
                </div>

                {/* コンテンツ */}
                <div className="flex-1 overflow-y-auto p-6 bg-gray-50 space-y-6">
                    <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                            タイトル
                        </label>
                        <input
                            type="text"
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                            placeholder="タイトルを入力"
                            disabled={saving}
                            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                            本文
                        </label>
                        <textarea
                            value={body}
                            onChange={e => setBody(e.target.value)}
                            placeholder="本文を入力"
                            rows={14}
                            disabled={saving}
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-sm resize-none"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                            種別
                        </label>
                        <select
                            value={severity}
                            onChange={e => setSeverity(e.target.value as NotificationSeverity)}
                            disabled={saving}
                            className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                        >
                            <option value="info">通常 (info)</option>
                            <option value="critical">重要 (critical)</option>
                        </select>
                    </div>
                </div>

                {/* フッター */}
                <div className="flex items-center justify-end p-4 border-t bg-white space-x-3">
                    <button
                        onClick={handleClose}
                        disabled={saving}
                        className="px-6 py-2.5 bg-gray-400 text-white rounded-lg hover:bg-gray-500 transition-colors shadow-sm font-medium disabled:opacity-50"
                    >
                        キャンセル
                    </button>
                    <button
                        onClick={handlePublish}
                        disabled={saving || !title.trim() || !body.trim()}
                        className="px-6 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors shadow-sm font-medium flex items-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {saving ? (
                            <>
                                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                                <span>公開中...</span>
                            </>
                        ) : (
                            <>
                                <Send className="w-4 h-4" />
                                <span>公開</span>
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
};
