'use client';

import React, { useEffect, useRef } from 'react';
import { X, Info, AlertTriangle, RotateCcw } from 'lucide-react';
import { dismissNotification, SystemNotification, undismissNotification } from '@/lib/systemNotifications';
import { useAuth } from '@/hooks/useAuth';
import { createLogger } from '@/lib/logger';

const detailModalLogger = createLogger('NotificationDetailModal');

interface NotificationDetailModalProps {
    notification: SystemNotification | null;
    isOpen: boolean;
    onClose: () => void;
    /** 現在のユーザーがこの通知を dismiss 済みかどうか */
    isDismissed: boolean;
}

const SEVERITY_DISPLAY: Record<SystemNotification['severity'], {
    Icon: React.ComponentType<{ className?: string }>;
    iconColor: string;
    label: string;
}> = {
    info: { Icon: Info, iconColor: 'text-blue-600', label: 'お知らせ' },
    critical: { Icon: AlertTriangle, iconColor: 'text-red-600', label: '重要なお知らせ' },
};

export const NotificationDetailModal: React.FC<NotificationDetailModalProps> = ({
    notification,
    isOpen,
    onClose,
    isDismissed,
}) => {
    const { user } = useAuth();
    const uid = user?.uid;
    const notificationId = notification?.id;

    // モーダルが「開いた瞬間」だけ一度だけ自動 dismiss する。
    // ref で初回フラグを管理することで、未読に戻すボタンで isDismissed=false に
    // 戻った後の再レンダーで再 dismiss されるのを防ぐ。
    const autoDismissedRef = useRef(false);

    useEffect(() => {
        if (!isOpen) {
            autoDismissedRef.current = false;
            return;
        }
        if (!uid || !notificationId) return;
        if (autoDismissedRef.current) return;
        autoDismissedRef.current = true;
        if (!isDismissed) {
            dismissNotification(uid, notificationId).catch(error => {
                detailModalLogger.error('自動 dismiss に失敗', error, { uid, notificationId });
            });
        }
    // isDismissed は意図的に依存に含めない（含めると未読戻し直後に再 dismiss されてしまう）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, uid, notificationId]);

    if (!isOpen || !notification) return null;

    const display = SEVERITY_DISPLAY[notification.severity];
    const Icon = display.Icon;

    const handleUndismiss = async () => {
        if (!uid) return;
        try {
            await undismissNotification(uid, notification.id);
        } catch (error) {
            detailModalLogger.error('未読戻しに失敗', error, { uid, notificationId: notification.id });
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden border border-gray-200"
                onClick={e => e.stopPropagation()}
            >
                {/* ヘッダー */}
                <div className="flex items-center justify-between p-6 border-b bg-gradient-to-r from-purple-50 to-pink-50">
                    <div className="flex items-center flex-1 mr-4 space-x-2 min-w-0">
                        <Icon className={`w-6 h-6 flex-shrink-0 ${display.iconColor}`} />
                        <h2 className="text-xl font-bold text-gray-900 truncate">
                            {notification.title}
                        </h2>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
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
                            本文
                        </label>
                        <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                            {notification.body}
                        </p>
                    </div>

                    <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                            種別
                        </label>
                        <div className="flex items-center gap-2 text-sm text-gray-800">
                            <Icon className={`w-4 h-4 ${display.iconColor}`} />
                            <span>{display.label}</span>
                        </div>
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
                    {uid && isDismissed ? (
                        <button
                            type="button"
                            onClick={handleUndismiss}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm font-medium"
                        >
                            <RotateCcw className="w-4 h-4" />
                            未読に戻す
                        </button>
                    ) : (
                        <div />
                    )}
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-6 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                    >
                        閉じる
                    </button>
                </div>
            </div>
        </div>
    );
};
