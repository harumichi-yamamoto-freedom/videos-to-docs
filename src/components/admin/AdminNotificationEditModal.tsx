'use client';

import React, { useState } from 'react';
import { X, Eye, FileText, Check, Trash2, Info, AlertTriangle } from 'lucide-react';
import {
    deleteSystemNotification,
    NotificationSeverity,
    SystemNotification,
    updateSystemNotification,
} from '@/lib/systemNotifications';
import { createLogger } from '@/lib/logger';

const adminEditModalLogger = createLogger('AdminNotificationEditModal');

interface AdminNotificationEditModalProps {
    notification: SystemNotification | null;
    isOpen: boolean;
    onClose: () => void;
}

const SEVERITY_DISPLAY: Record<NotificationSeverity, {
    Icon: React.ComponentType<{ className?: string }>;
    iconColor: string;
    label: string;
}> = {
    info: { Icon: Info, iconColor: 'text-blue-600', label: 'お知らせ' },
    critical: { Icon: AlertTriangle, iconColor: 'text-red-600', label: '重要なお知らせ' },
};

export const AdminNotificationEditModal: React.FC<AdminNotificationEditModalProps> = ({
    notification,
    isOpen,
    onClose,
}) => {
    const [isViewMode, setIsViewMode] = useState(true);
    const [editedTitle, setEditedTitle] = useState('');
    const [editedBody, setEditedBody] = useState('');
    const [editedSeverity, setEditedSeverity] = useState<NotificationSeverity>('info');
    const [editedPublished, setEditedPublished] = useState(true);
    const [saving, setSaving] = useState(false);

    const resetDraftFromNotification = (n: SystemNotification | null) => {
        setEditedTitle(n?.title ?? '');
        setEditedBody(n?.body ?? '');
        setEditedSeverity(n?.severity ?? 'info');
        setEditedPublished(n?.published ?? true);
    };

    // 通知が切り替わったらドラフトを初期化（Adjusting state during render）
    const [lastNotificationId, setLastNotificationId] = useState<string | null>(notification?.id ?? null);
    if ((notification?.id ?? null) !== lastNotificationId) {
        setLastNotificationId(notification?.id ?? null);
        setIsViewMode(true);
        resetDraftFromNotification(notification);
    }

    if (!isOpen || !notification) return null;

    const display = SEVERITY_DISPLAY[notification.severity];
    const Icon = display.Icon;

    const hasChanges =
        editedTitle !== notification.title
        || editedBody !== notification.body
        || editedSeverity !== notification.severity
        || editedPublished !== notification.published;

    const handleClose = () => {
        if (!isViewMode && hasChanges) {
            if (!confirm('保存されていない変更があります。変更を破棄して閉じますか？')) return;
        }
        onClose();
    };

    const handleViewModeSwitch = () => {
        if (hasChanges) {
            if (!confirm('保存されていない変更があります。変更を破棄して表示モードに戻りますか？')) return;
        }
        resetDraftFromNotification(notification);
        setIsViewMode(true);
    };

    const handleCancelEdit = () => {
        if (hasChanges) {
            if (!confirm('保存されていない変更があります。変更を破棄しますか？')) return;
        }
        resetDraftFromNotification(notification);
        setIsViewMode(true);
    };

    const handleSave = async () => {
        if (!editedTitle.trim() || !editedBody.trim()) {
            alert('タイトルと本文を入力してください');
            return;
        }
        // 公開状態が変わる場合は影響範囲が大きいので確認ダイアログを出す
        if (editedPublished !== notification.published) {
            const message = editedPublished
                ? 'このお知らせを公開しますか？\n\nユーザーの画面に表示されるようになります。'
                : 'このお知らせを非公開（下書き）にしますか？\n\nユーザーの画面から非表示になります（既に閲覧したユーザーの既読状態はそのまま残ります）。';
            if (!confirm(message)) return;
        }
        try {
            setSaving(true);
            await updateSystemNotification(notification.id, {
                title: editedTitle.trim(),
                body: editedBody.trim(),
                severity: editedSeverity,
                published: editedPublished,
            });
            setIsViewMode(true);
        } catch (error) {
            adminEditModalLogger.error('通知の更新に失敗', error, { id: notification.id });
            alert('通知の更新に失敗しました');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!confirm(`「${notification.title}」を削除しますか？`)) return;
        try {
            setSaving(true);
            await deleteSystemNotification(notification.id);
            onClose();
        } catch (error) {
            adminEditModalLogger.error('通知の削除に失敗', error, { id: notification.id });
            alert('通知の削除に失敗しました');
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
                    {!isViewMode ? (
                        <div className="flex items-center flex-1 mr-4 space-x-2">
                            <input
                                type="text"
                                value={editedTitle}
                                onChange={e => setEditedTitle(e.target.value)}
                                className="flex-1 px-3 py-2 border border-purple-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-900"
                                placeholder="タイトルを入力"
                                autoFocus
                                disabled={saving}
                            />
                        </div>
                    ) : (
                        <div className="flex items-center flex-1 mr-4 space-x-2 min-w-0">
                            <Icon className={`w-6 h-6 flex-shrink-0 ${display.iconColor}`} />
                            <h2 className="text-xl font-bold text-gray-900 truncate">
                                {notification.title}
                            </h2>
                            <span className={`flex-shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded ${
                                notification.published
                                    ? 'bg-emerald-100 text-emerald-700'
                                    : 'bg-gray-200 text-gray-600'
                            }`}>
                                {notification.published ? '公開中' : '下書き'}
                            </span>
                        </div>
                    )}
                    <div className="flex items-center space-x-3">
                        {/* モード切り替えボタン */}
                        <div className="flex items-center space-x-2 bg-gray-100 rounded-lg p-1">
                            <button
                                onClick={handleViewModeSwitch}
                                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center space-x-2 ${
                                    isViewMode
                                        ? 'bg-white text-purple-600 shadow-sm'
                                        : 'text-gray-600 hover:text-gray-900'
                                }`}
                                disabled={saving}
                            >
                                <Eye className="w-4 h-4" />
                                <span>表示</span>
                            </button>
                            <button
                                onClick={() => setIsViewMode(false)}
                                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center space-x-2 ${
                                    !isViewMode
                                        ? 'bg-white text-purple-600 shadow-sm'
                                        : 'text-gray-600 hover:text-gray-900'
                                }`}
                                disabled={saving}
                            >
                                <FileText className="w-4 h-4" />
                                <span>編集</span>
                            </button>
                        </div>
                        <button
                            onClick={handleClose}
                            className="p-2 hover:bg-white rounded-lg transition-colors shadow-sm"
                            title="閉じる"
                        >
                            <X className="w-5 h-5 text-gray-600" />
                        </button>
                    </div>
                </div>

                {/* コンテンツ */}
                <div className="flex-1 overflow-y-auto p-6 bg-gray-50 space-y-6">
                    <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                            本文
                        </label>
                        {isViewMode ? (
                            <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                                {notification.body}
                            </p>
                        ) : (
                            <textarea
                                value={editedBody}
                                onChange={e => setEditedBody(e.target.value)}
                                rows={14}
                                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-sm resize-none"
                                placeholder="本文を入力"
                                disabled={saving}
                            />
                        )}
                    </div>

                    <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                            種別
                        </label>
                        {isViewMode ? (
                            <div className="flex items-center gap-2 text-sm text-gray-800">
                                <Icon className={`w-4 h-4 ${display.iconColor}`} />
                                <span>{display.label}</span>
                            </div>
                        ) : (
                            <select
                                value={editedSeverity}
                                onChange={e => setEditedSeverity(e.target.value as NotificationSeverity)}
                                disabled={saving}
                                className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                            >
                                <option value="info">通常 (info)</option>
                                <option value="critical">重要 (critical)</option>
                            </select>
                        )}
                    </div>

                    <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                            公開状態
                        </label>
                        {isViewMode ? (
                            <span className={`inline-flex items-center text-xs font-medium px-2 py-1 rounded ${
                                notification.published
                                    ? 'bg-emerald-100 text-emerald-700'
                                    : 'bg-gray-200 text-gray-600'
                            }`}>
                                {notification.published ? '公開中' : '下書き（ユーザー画面には表示されません）'}
                            </span>
                        ) : (
                            <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={editedPublished}
                                    onChange={e => setEditedPublished(e.target.checked)}
                                    disabled={saving}
                                    className="rounded border-gray-300"
                                />
                                公開する（オフの場合は下書き）
                            </label>
                        )}
                    </div>

                    <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                            公開日時
                        </label>
                        <div className="text-sm text-gray-700">
                            {notification.publishedAt.toLocaleString('ja-JP')}
                        </div>
                    </div>
                </div>

                {/* フッター */}
                <div className="flex items-center justify-between p-4 border-t bg-white">
                    {isViewMode ? (
                        <>
                            <button
                                onClick={handleDelete}
                                disabled={saving}
                                className="px-6 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center space-x-2 shadow-sm font-medium disabled:opacity-50"
                            >
                                <Trash2 className="w-4 h-4" />
                                <span>削除</span>
                            </button>
                            <button
                                onClick={handleClose}
                                className="px-6 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                            >
                                閉じる
                            </button>
                        </>
                    ) : (
                        <>
                            <div></div>
                            <div className="flex items-center space-x-3">
                                <button
                                    onClick={handleCancelEdit}
                                    disabled={saving}
                                    className="px-6 py-2.5 bg-gray-400 text-white rounded-lg hover:bg-gray-500 transition-colors shadow-sm font-medium disabled:opacity-50"
                                >
                                    キャンセル
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="px-6 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors shadow-sm font-medium flex items-center space-x-2 disabled:opacity-50"
                                >
                                    {saving ? (
                                        <>
                                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                                            <span>保存中...</span>
                                        </>
                                    ) : (
                                        <>
                                            <Check className="w-4 h-4" />
                                            <span>保存</span>
                                        </>
                                    )}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};
