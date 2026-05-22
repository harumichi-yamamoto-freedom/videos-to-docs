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
    const [notifications, setNotifications] = useState<SystemNotification[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);

    useEffect(() => {
        const unsubscribe = subscribeToAllNotifications(setNotifications);
        return () => unsubscribe();
    }, []);

    const selectedNotification = notifications.find(n => n.id === selectedId) ?? null;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Bell className="w-6 h-6 text-purple-600" />
                    <h2 className="text-xl font-bold text-gray-900">
                        お知らせ管理
                        <span className="ml-2 text-sm font-normal text-gray-500">{notifications.length}件</span>
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

            {notifications.length === 0 ? (
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
