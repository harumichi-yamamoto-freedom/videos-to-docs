'use client';

import React, { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bell, Info, AlertTriangle, CheckCheck, RefreshCw } from 'lucide-react';
import { arrayUnion, doc, setDoc } from 'firebase/firestore';
import { useSystemNotifications } from '@/hooks/useSystemNotifications';
import { NotificationDetailModal } from '@/components/NotificationDetailModal';
import { SystemNotification } from '@/lib/systemNotifications';
import { useAuth } from '@/hooks/useAuth';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase';

const notificationsPageLogger = createLogger('NotificationsPage');
const DISMISSALS_COLLECTION = 'notificationDismissals';

interface PendingReadMutation {
    uid: string;
    ids: string[];
    saving: boolean;
}

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
    const {
        notifications,
        dismissedIds,
        loading,
        error,
        stale,
        retrying,
        retry,
    } = useSystemNotifications();
    const [pendingReadMutation, setPendingReadMutation] = useState<PendingReadMutation | null>(null);
    const [markReadErrorUid, setMarkReadErrorUid] = useState<string | null>(null);

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

    const currentUid = user?.uid ?? null;
    const persistedDismissedSet = new Set(dismissedIds);
    const activeReadMutation = pendingReadMutation?.uid === currentUid
        ? pendingReadMutation
        : null;
    const readMutationAcknowledged = Boolean(
        activeReadMutation
        && !activeReadMutation.saving
        && activeReadMutation.ids.every(id => persistedDismissedSet.has(id)),
    );
    if (readMutationAcknowledged) {
        setPendingReadMutation(null);
    }
    const pendingReadIds = activeReadMutation && !readMutationAcknowledged
        ? activeReadMutation.ids
        : [];
    const dismissedSet = new Set([...dismissedIds, ...pendingReadIds]);
    const unreadIds = user?.uid
        ? notifications.filter(n => !dismissedSet.has(n.id)).map(n => n.id)
        : [];
    const hasUnread = unreadIds.length > 0;
    const isMarkingAllAsRead = Boolean(activeReadMutation?.saving);
    const markReadError = markReadErrorUid === currentUid;

    const handleMarkAllAsRead = async () => {
        if (!user?.uid || unreadIds.length === 0) return;
        const mutation: PendingReadMutation = { uid: user.uid, ids: unreadIds, saving: true };
        setPendingReadMutation(mutation);
        setMarkReadErrorUid(null);
        try {
            await setDoc(
                doc(db, DISMISSALS_COLLECTION, user.uid),
                {
                    uid: user.uid,
                    dismissedIds: arrayUnion(...unreadIds),
                },
                { merge: true },
            );
            setPendingReadMutation(current => current === mutation
                ? { ...current, saving: false }
                : current);
        } catch (error) {
            notificationsPageLogger.error('全て既読にする処理に失敗', error, { uid: user.uid });
            setMarkReadErrorUid(user.uid);
            setPendingReadMutation(current => current === mutation ? null : current);
        }
    };

    return (
        <div className="max-w-3xl mx-auto space-y-4">
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <Bell className="w-6 h-6 text-blue-600" />
                    <h1 className="text-2xl font-bold text-gray-900">お知らせ</h1>
                </div>
                {user?.uid && (
                    <button
                        type="button"
                        onClick={handleMarkAllAsRead}
                        disabled={!hasUnread || isMarkingAllAsRead}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        <CheckCheck className="w-3.5 h-3.5" />
                        {isMarkingAllAsRead ? '既読にしています...' : '全て既読にする'}
                    </button>
                )}
            </div>

            {error && (
                <div
                    role="alert"
                    className="flex items-start gap-3 p-4 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-xl"
                >
                    <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5 text-amber-600" />
                    <div className="flex-1 min-w-0">
                        <p className="font-medium">
                            {stale
                                ? '最新のお知らせを取得できませんでした。表示中の内容は以前に取得した情報です。'
                                : 'お知らせを取得できませんでした。'}
                        </p>
                        <p className="mt-1 text-xs text-amber-800">
                            通信状況を確認して、もう一度お試しください。
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={retry}
                        disabled={retrying}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-900 bg-white border border-amber-300 rounded-lg hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        <RefreshCw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} />
                        {retrying ? '再接続中です...' : '再試行する'}
                    </button>
                </div>
            )}

            {markReadError && (
                <div
                    role="alert"
                    className="p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg"
                >
                    全てのお知らせを既読にできませんでした。通信状況を確認して、もう一度お試しください。
                </div>
            )}

            {loading ? (
                <div className="text-center py-12 text-gray-500">読み込み中...</div>
            ) : notifications.length === 0 ? (
                !error && (
                    <div className="text-center py-12 text-gray-500 bg-white border border-gray-200 rounded-xl">
                        お知らせはまだありません。
                    </div>
                )
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
                                    className="w-full text-left bg-white border border-gray-200 rounded-xl p-4 transition-colors hover:border-blue-300 hover:shadow-sm"
                                >
                                    <div className="flex items-start gap-3">
                                        <span className="relative flex w-2 h-2 flex-shrink-0 mt-2">
                                            {!isDismissed && (
                                                <>
                                                    <span className="absolute inset-0 rounded-full bg-blue-600" />
                                                    <span className="sr-only">未読</span>
                                                </>
                                            )}
                                        </span>
                                        <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${
                                            notification.severity === 'critical' ? 'text-red-600' : 'text-blue-600'
                                        }`} />
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center flex-wrap gap-2">
                                                <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${badge.color}`}>
                                                    {badge.label}
                                                </span>
                                                <span className="text-xs text-gray-500">
                                                    {notification.publishedAt.toLocaleString('ja-JP')}
                                                </span>
                                            </div>
                                            <h3 className={`text-sm text-gray-900 mt-1 ${
                                                isDismissed ? 'font-medium' : 'font-semibold'
                                            }`}>
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
