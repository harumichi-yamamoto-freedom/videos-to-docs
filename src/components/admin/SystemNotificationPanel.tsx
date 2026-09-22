'use client';

import React, { useEffect, useState } from 'react';
import { Bell, Plus, Info, AlertTriangle } from 'lucide-react';
import {
    subscribeToAllNotifications,
    SystemNotification,
} from '@/lib/systemNotifications';
import { AdminNotificationEditModal } from './AdminNotificationEditModal';
import { AdminNotificationCreateModal } from './AdminNotificationCreateModal';

export default function SystemNotificationPanel() {
    // null = 購読の結果がまだ1度も届いていない。空配列（0件の確定）と区別する。
    const [notifications, setNotifications] = useState<SystemNotification[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [subscriptionAttempt, setSubscriptionAttempt] = useState(0);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);

    // 失敗した購読は onSnapshot 側で終了しているため、購読し直さないと復旧しない。
    // 表示は再試行を押した時点で未確定へ戻し、effect は購読だけを行う。
    const handleRetry = () => {
        setNotifications(null);
        setLoadError(null);
        setSubscriptionAttempt(attempt => attempt + 1);
    };

    useEffect(() => {
        const unsubscribe = subscribeToAllNotifications(
            list => {
                setLoadError(null);
                setNotifications(list);
            },
            () => {
                setLoadError('お知らせを読み込めませんでした。再試行してください。');
            },
        );
        return () => unsubscribe();
    }, [subscriptionAttempt]);

    const selectedNotification = notifications?.find(n => n.id === selectedId) ?? null;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Bell className="w-6 h-6 text-purple-600" />
                    <h2 className="text-xl font-bold text-gray-900">
                        お知らせ管理
                        {notifications !== null && (
                            <span className="ml-2 text-sm font-normal text-gray-500">{notifications.length}件</span>
                        )}
                    </h2>
                </div>
                <button
                    type="button"
                    onClick={() => setIsCreating(true)}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 transition-colors shadow-sm"
                >
                    <Plus className="w-4 h-4" />
                    <span>新規作成</span>
                </button>
            </div>

            {loadError && (
                <div
                    role="alert"
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
                >
                    <p className="min-w-0 flex-1">{loadError}</p>
                    <button
                        type="button"
                        onClick={handleRetry}
                        className="shrink-0 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-100"
                    >
                        再試行
                    </button>
                </div>
            )}

            {loadError ? null : notifications === null ? (
                <div className="text-center py-12">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto mb-4"></div>
                    <p className="text-gray-600">読み込み中...</p>
                </div>
            ) : notifications.length === 0 ? (
                <div className="bg-white border border-gray-200 rounded-xl px-5 py-12 text-center text-sm text-gray-500">
                    お知らせはまだありません。「新規作成」から最初のお知らせを公開してください。
                </div>
            ) : (
                <ul className="space-y-2">
                    {notifications.map(n => {
                        const Icon = n.severity === 'critical' ? AlertTriangle : Info;
                        const iconColor = n.severity === 'critical' ? 'text-red-600' : 'text-blue-600';
                        return (
                            <li key={n.id}>
                                <button
                                    type="button"
                                    onClick={() => setSelectedId(n.id)}
                                    className="w-full text-left bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-start gap-3 hover:border-purple-300 hover:shadow-sm transition-colors"
                                >
                                    <Icon className={`w-4 h-4 flex-shrink-0 mt-0.5 ${iconColor}`} />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-semibold text-gray-900 truncate">{n.title}</span>
                                            <span className={`text-[10px] font-medium px-2 py-0.5 rounded flex-shrink-0 ${
                                                n.published
                                                    ? 'bg-emerald-100 text-emerald-700'
                                                    : 'bg-gray-200 text-gray-600'
                                            }`}>
                                                {n.published ? '公開中' : '下書き'}
                                            </span>
                                        </div>
                                        <div className="text-xs text-gray-500 mt-0.5">
                                            {n.publishedAt.toLocaleString('ja-JP')}
                                        </div>
                                        <div className="text-xs text-gray-600 mt-1 line-clamp-2">{n.body}</div>
                                    </div>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}

            <AdminNotificationEditModal
                notification={selectedNotification}
                isOpen={selectedNotification !== null}
                onClose={() => setSelectedId(null)}
            />

            <AdminNotificationCreateModal
                isOpen={isCreating}
                onClose={() => setIsCreating(false)}
            />
        </div>
    );
}
