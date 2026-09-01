'use client';

import React from 'react';
import Link from 'next/link';
import { X, Info, AlertTriangle } from 'lucide-react';
import { useSystemNotifications } from '@/hooks/useSystemNotifications';
import { useAuth } from '@/hooks/useAuth';
import { dismissNotification, SystemNotification } from '@/lib/systemNotifications';
import { createLogger } from '@/lib/logger';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';

const bannerLogger = createLogger('NotificationBanner');

const PUBLISHED_DATE_FORMATTER = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
});

const SEVERITY_STYLE: Record<SystemNotification['severity'], {
    container: string;
    hover: string;
    iconColor: string;
    Icon: React.ComponentType<{ className?: string }>;
}> = {
    info: {
        container: 'border-status-info-border bg-status-info-bg',
        hover: 'hover:bg-status-info-bg-hover',
        iconColor: 'text-status-info',
        Icon: Info,
    },
    critical: {
        container: 'border-status-danger-border bg-status-danger-bg',
        hover: 'hover:bg-status-danger-bg-hover',
        iconColor: 'text-status-danger',
        Icon: AlertTriangle,
    },
};

export const NotificationBanner: React.FC = () => {
    const { user } = useAuth();
    const { bannerNotifications, loading, error, stale, retrying, retry } = useSystemNotifications();

    if (loading) return null;
    if (!error && bannerNotifications.length === 0) return null;

    const handleDismiss = async (id: string) => {
        if (!user?.uid) return;
        try {
            await dismissNotification(user.uid, id);
        } catch (caught) {
            bannerLogger.error('通知の dismiss に失敗', caught, { id, userId: user.uid });
        }
    };

    return (
        <div className="mb-4 space-y-2">
            {error && (
                <div
                    role="alert"
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-status-warning-border bg-status-warning-bg px-4 py-2"
                >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-status-warning" aria-hidden="true" />
                    <p className="min-w-0 flex-1 text-sm text-status-warning">
                        {stale && bannerNotifications.length > 0
                            ? 'お知らせを更新できませんでした。表示中の内容は最新ではない可能性があります。'
                            : 'お知らせを取得できませんでした。'}
                    </p>
                    {/* 再取得中に押し直せると、何度も購読を張り直して状況が読めなくなる。 */}
                    <Button
                        variant="secondary"
                        onClick={retry}
                        disabled={retrying}
                        className="shrink-0"
                    >
                        {retrying ? '再試行しています...' : '再試行'}
                    </Button>
                </div>
            )}

            {bannerNotifications.length > 0 && (
                <ul className="space-y-2">
                    {bannerNotifications.map(notification => {
                        const style = SEVERITY_STYLE[notification.severity];
                        const Icon = style.Icon;
                        return (
                            <li
                                key={notification.id}
                                className={`flex items-stretch rounded-lg border ${style.container}`}
                            >
                                <Link
                                    href={`/notifications?open=${notification.id}`}
                                    className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-l-lg px-4 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-1 ${style.hover}`}
                                >
                                    <Icon className={`h-4 w-4 shrink-0 ${style.iconColor}`} />
                                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                                        {notification.title}
                                    </span>
                                    <span className="shrink-0 text-xs text-muted">
                                        {PUBLISHED_DATE_FORMATTER.format(notification.publishedAt)}
                                    </span>
                                </Link>
                                {user?.uid && (
                                    <IconButton
                                        aria-label={`「${notification.title}」を閉じる（今後このお知らせを表示しません）`}
                                        onClick={() => handleDismiss(notification.id)}
                                        className="shrink-0 rounded-l-none"
                                    >
                                        <X className="h-4 w-4" aria-hidden="true" />
                                    </IconButton>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
};
