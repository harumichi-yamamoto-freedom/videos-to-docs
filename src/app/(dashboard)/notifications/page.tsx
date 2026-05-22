'use client';

import React, { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bell, Info, AlertTriangle, CheckCheck } from 'lucide-react';
import { useSystemNotifications } from '@/hooks/useSystemNotifications';
import { NotificationDetailModal } from '@/components/NotificationDetailModal';
import { dismissAllNotifications, SystemNotification } from '@/lib/systemNotifications';
import { useAuth } from '@/hooks/useAuth';
import { createLogger } from '@/lib/logger';

const notificationsPageLogger = createLogger('NotificationsPage');

const SEVERITY_BADGE: Record<SystemNotification['severity'], {
    Icon: React.ComponentType<{ className?: string }>;
    color: string;
    label: string;
}> = {
    info: { Icon: Info, color: 'text-blue-600 bg-blue-50 border-blue-200', label: 'お知らせ' },
    critical: { Icon: AlertTriangle, color: 'text-red-700 bg-red-50 border-red-300', label: '重要' },
};

export default function NotificationsPage() {
    return (
        <Suspense fallback={<div className="text-center py-12 text-gray-500">読み込み中...</div>}>
            <NotificationsPageContent />
        </Suspense>
    );
}

function NotificationsPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { user } = useAuth();
    const { notifications, dismissedIds, loading } = useSystemNotifications();

    // 選択中の通知は URL クエリ `?open=` で管理（useState 不要、useEffect 不要）
    const openParam = searchParams.get('open');
    const selectedNotification = openParam
        ? notifications.find(n => n.id === openParam) ?? null
        : null;

    const handleSelect = (id: string) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set('open', id);
        router.replace(`/notifications?${params.toString()}`);
    };

    const handleClose = () => {
        const params = new URLSearchParams(searchParams.toString());
        params.delete('open');
        const qs = params.toString();
        router.replace(`/notifications${qs ? `?${qs}` : ''}`);
    };

    const dismissedSet = new Set(dismissedIds);
    const unreadIds = user?.uid
        ? notifications.filter(n => !dismissedSet.has(n.id)).map(n => n.id)
        : [];
    const hasUnread = unreadIds.length > 0;

    const handleMarkAllAsRead = async () => {
        if (!user?.uid || unreadIds.length === 0) return;
        try {
            await dismissAllNotifications(user.uid, unreadIds);
        } catch (error) {
            notificationsPageLogger.error('全て既読にする処理に失敗', error, { uid: user.uid });
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <Bell className="w-6 h-6 text-blue-600" />
                    <h1 className="text-2xl font-bold text-gray-900">お知らせ</h1>
                </div>
                {user?.uid && (
                    <button
                        type="button"
                        onClick={handleMarkAllAsRead}
                        disabled={!hasUnread}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        <CheckCheck className="w-3.5 h-3.5" />
                        全て既読にする
                    </button>
                )}
            </div>

            {loading ? (
                <div className="text-center py-12 text-gray-500">読み込み中...</div>
            ) : notifications.length === 0 ? (
                <div className="text-center py-12 text-gray-500 bg-white border border-gray-200 rounded-xl">
                    お知らせはまだありません
                </div>
            ) : (
                <ul className="space-y-2">
                    {notifications.map(notification => {
                        const badge = SEVERITY_BADGE[notification.severity];
                        const Icon = badge.Icon;
                        const isDismissed = user?.uid ? dismissedSet.has(notification.id) : false;
                        return (
                            <li key={notification.id}>
                                <button
                                    type="button"
                                    onClick={() => handleSelect(notification.id)}
                                    className={`w-full text-left bg-white border rounded-xl p-4 transition-colors hover:border-blue-300 hover:shadow-sm ${
                                        isDismissed ? 'opacity-60 border-gray-200' : 'border-gray-200'
                                    }`}
                                >
                                    <div className="flex items-start gap-3">
                                        <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${
                                            notification.severity === 'critical' ? 'text-red-600' : 'text-blue-600'
                                        }`} />
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center flex-wrap gap-2">
                                                <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${badge.color}`}>
                                                    {badge.label}
                                                </span>
                                                {isDismissed && (
                                                    <span className="text-[10px] font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                                                        既読
                                                    </span>
                                                )}
                                                <span className="text-xs text-gray-500">
                                                    {notification.publishedAt.toLocaleString('ja-JP')}
                                                </span>
                                            </div>
                                            <h3 className="text-sm font-semibold text-gray-900 mt-1">
                                                {notification.title}
                                            </h3>
                                            <p className="text-xs text-gray-600 mt-1 line-clamp-2">
                                                {notification.body}
                                            </p>
                                        </div>
                                    </div>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}

            <NotificationDetailModal
                notification={selectedNotification}
                isOpen={selectedNotification !== null}
                onClose={handleClose}
                isDismissed={selectedNotification ? dismissedSet.has(selectedNotification.id) : false}
            />
        </div>
    );
}
