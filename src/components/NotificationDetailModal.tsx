'use client';

import React, { useEffect, useId, useRef } from 'react';
import { X, Info, AlertTriangle, RotateCcw } from 'lucide-react';
import { dismissNotification, SystemNotification, undismissNotification } from '@/lib/systemNotifications';
import { useAuth } from '@/hooks/useAuth';
import { createLogger } from '@/lib/logger';
import { Dialog } from './ui/Dialog';

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
    const titleId = useId();

    // モーダルが「開いた瞬間」だけ一度だけ自動 dismiss する。
    // ref で初回フラグを管理することで、未読に戻すボタンで isDismissed=false に
    // 戻った後の再レンダーで再 dismiss されるのを防ぐ。
    const autoDismissedRef = useRef(false);
    const headingRef = useRef<HTMLHeadingElement>(null);

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

    const handleUndismiss = async () => {
        if (!uid || !notification) return;
        try {
            await undismissNotification(uid, notification.id);
        } catch (error) {
            detailModalLogger.error('未読戻しに失敗', error, { uid, notificationId: notification.id });
        }
    };

    // notification が null のときは Dialog を開かないので、表示に使う値は既定値で構わない。
    const display = notification ? SEVERITY_DISPLAY[notification.severity] : SEVERITY_DISPLAY.info;
    const Icon = display.Icon;

    return (
        <Dialog
            isOpen={isOpen && Boolean(notification)}
            initialFocusRef={headingRef}
            onClose={onClose}
            aria-labelledby={titleId}
            className="w-[calc(100%-2rem)] max-w-4xl max-h-[90dvh] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl open:flex open:flex-col"
        >
            {notification && (
                <div className="flex max-h-[90dvh] min-h-0 flex-col bg-white">
                    {/* ヘッダー */}
                    <div className="flex shrink-0 items-start justify-between p-6 border-b bg-gradient-to-r from-purple-50 to-pink-50">
                        <div className="flex items-start flex-1 mr-4 gap-3 min-w-0">
                            <Icon className={`w-6 h-6 flex-shrink-0 mt-0.5 ${display.iconColor}`} />
                            <div className="min-w-0">
                                <h2
                                    ref={headingRef}
                                    id={titleId}
                                    tabIndex={-1}
                                    className="truncate rounded-sm text-xl font-bold text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
                                >
                                    {notification.title}
                                </h2>
                                <div className="text-xs text-gray-500 mt-1">
                                    {notification.publishedAt.toLocaleString('ja-JP')}
                                </div>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="閉じる"
                            title="閉じる"
                            className="inline-flex min-h-11 min-w-11 items-center justify-center p-2 hover:bg-white rounded-lg transition-colors shadow-sm flex-shrink-0"
                        >
                            <X className="w-5 h-5 text-gray-600" />
                        </button>
                    </div>

                    {/* 本文 */}
                    <div className="min-h-0 flex-1 overflow-y-auto p-6 bg-white">
                        <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                            {notification.body}
                        </p>
                    </div>

                    {/* フッター */}
                    <div className="flex shrink-0 items-center justify-between p-4 border-t bg-white">
                        {uid && isDismissed ? (
                            <button
                                type="button"
                                onClick={handleUndismiss}
                                className="inline-flex min-h-11 items-center gap-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm font-medium"
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
                            className="min-h-11 px-6 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                        >
                            閉じる
                        </button>
                    </div>
                </div>
            )}
        </Dialog>
    );
};
