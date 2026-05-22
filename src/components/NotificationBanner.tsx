'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { X, Info, AlertTriangle } from 'lucide-react';
import { useSystemNotifications } from '@/hooks/useSystemNotifications';
import { useAuth } from '@/hooks/useAuth';
import { dismissNotification, SystemNotification } from '@/lib/systemNotifications';
import { createLogger } from '@/lib/logger';

const bannerLogger = createLogger('NotificationBanner');

const SEVERITY_STYLE: Record<SystemNotification['severity'], {
    container: string;
    iconColor: string;
    Icon: React.ComponentType<{ className?: string }>;
}> = {
    info: {
        container: 'bg-blue-50 border-blue-200 hover:bg-blue-100',
        iconColor: 'text-blue-600',
        Icon: Info,
    },
    critical: {
        container: 'bg-red-50 border-red-300 hover:bg-red-100',
        iconColor: 'text-red-600',
        Icon: AlertTriangle,
    },
};

export const NotificationBanner: React.FC = () => {
    const router = useRouter();
    const { user } = useAuth();
    const { bannerNotifications, loading } = useSystemNotifications();

    if (loading || bannerNotifications.length === 0) return null;

    const handleOpen = (id: string) => {
        router.push(`/notifications?open=${id}`);
    };

    const handleDismiss = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        if (!user?.uid) return;
        try {
            await dismissNotification(user.uid, id);
        } catch (error) {
            bannerLogger.error('通知の dismiss に失敗', error, { id, userId: user.uid });
        }
    };

    return (
        <div className="space-y-2 mb-4">
            {bannerNotifications.map(notification => {
                const style = SEVERITY_STYLE[notification.severity];
                const Icon = style.Icon;
                return (
                    <div
                        key={notification.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleOpen(notification.id)}
                        onKeyDown={e => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                handleOpen(notification.id);
                            }
                        }}
                        className={`flex items-center gap-3 px-4 py-2 rounded-lg border cursor-pointer transition-colors ${style.container}`}
                    >
                        <Icon className={`w-4 h-4 flex-shrink-0 ${style.iconColor}`} />
                        <span className="text-sm font-medium text-gray-900 truncate flex-1">
                            {notification.title}
                        </span>
                        {user?.uid && (
                            <button
                                type="button"
                                onClick={e => handleDismiss(e, notification.id)}
                                className="p-1 text-gray-500 hover:text-gray-800 hover:bg-white rounded transition-colors flex-shrink-0"
                                title="閉じる（次回以降表示しません）"
                                aria-label="閉じる"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </div>
                );
            })}
        </div>
    );
};
