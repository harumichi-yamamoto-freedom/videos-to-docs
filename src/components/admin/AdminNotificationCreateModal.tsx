'use client';

import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { X, Send, Bell } from 'lucide-react';
import {
    createSystemNotification,
    NotificationSeverity,
} from '@/lib/systemNotifications';
import { useAuth } from '@/hooks/useAuth';
import { createLogger } from '@/lib/logger';
import { Dialog } from '@/components/ui/Dialog';

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
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [confirmingDiscard, setConfirmingDiscard] = useState(false);
    const headingId = useId();
    const titleFieldId = useId();
    const bodyFieldId = useId();
    const severityFieldId = useId();
    const errorId = useId();
    const discardTitleId = useId();
    const discardDescriptionId = useId();
    const titleInputRef = useRef<HTMLInputElement>(null);
    const keepEditingButtonRef = useRef<HTMLButtonElement>(null);
    const confirmationReturnFocusRef = useRef<HTMLElement | null>(null);
    const focusAfterConfirmationRef = useRef<HTMLElement | null>(null);

    // モーダルが開いたタイミングでフォームをリセット（Adjusting state during render）
    const [lastOpen, setLastOpen] = useState(isOpen);
    if (isOpen !== lastOpen) {
        setLastOpen(isOpen);
        if (isOpen) {
            setTitle('');
            setBody('');
            setSeverity('info');
            setErrorMessage(null);
            setConfirmingDiscard(false);
        }
    }

    // 破棄確認へ切り替わったら確認側の安全な選択肢へ、戻ったら元のトリガーへ
    // フォーカスを運ぶ（window.confirm が担っていたフォーカス管理の代替）。
    useLayoutEffect(() => {
        if (!isOpen) return;
        if (confirmingDiscard) {
            keepEditingButtonRef.current?.focus({ preventScroll: true });
            return;
        }

        const focusTarget = focusAfterConfirmationRef.current;
        focusAfterConfirmationRef.current = null;
        if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    }, [confirmingDiscard, isOpen]);

    const hasDraft = title.trim().length > 0 || body.trim().length > 0;

    const cancelDiscardConfirmation = () => {
        focusAfterConfirmationRef.current = confirmationReturnFocusRef.current
            ?? titleInputRef.current;
        confirmationReturnFocusRef.current = null;
        setConfirmingDiscard(false);
    };

    const discardAndClose = () => {
        confirmationReturnFocusRef.current = null;
        setConfirmingDiscard(false);
        onClose();
    };

    const requestClose = () => {
        if (saving) return;
        if (confirmingDiscard) {
            // 確認中の Esc は確認だけを畳み、入力フォームへ戻す。
            cancelDiscardConfirmation();
            return;
        }
        if (!hasDraft) {
            onClose();
            return;
        }

        const activeElement = document.activeElement;
        confirmationReturnFocusRef.current = activeElement instanceof HTMLElement
            ? activeElement
            : titleInputRef.current;
        setConfirmingDiscard(true);
    };

    const handlePublish = async () => {
        if (!user?.uid || saving) return;
        if (!title.trim() || !body.trim()) {
            setErrorMessage('タイトルと本文を入力してください。');
            return;
        }
        try {
            setSaving(true);
            setErrorMessage(null);
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
            setErrorMessage('お知らせを作成できませんでした。入力内容は保持されています。もう一度お試しください。');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            isOpen={isOpen}
            onClose={requestClose}
            initialFocusRef={titleInputRef}
            dismissible={!saving}
            role={confirmingDiscard ? 'alertdialog' : undefined}
            aria-labelledby={confirmingDiscard ? discardTitleId : headingId}
            aria-describedby={confirmingDiscard ? discardDescriptionId : undefined}
            aria-busy={saving || undefined}
            className={`w-[calc(100%-2rem)] ${confirmingDiscard ? 'max-w-lg' : 'max-w-4xl'} max-h-[90dvh] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl open:flex open:flex-col`}
        >
            <div
                className={`${confirmingDiscard ? 'hidden' : 'flex'} max-h-[90dvh] min-h-0 flex-col bg-white`}
                aria-hidden={confirmingDiscard ? true : undefined}
                inert={confirmingDiscard ? true : undefined}
            >
                {/* ヘッダー */}
                <div className="flex shrink-0 items-center justify-between p-6 border-b bg-gradient-to-r from-purple-50 to-pink-50">
                    <div className="flex items-center gap-2">
                        <Bell className="w-6 h-6 text-purple-600" />
                        <h2 id={headingId} className="text-xl font-bold text-gray-900">
                            新しいお知らせを作成
                        </h2>
                    </div>
                    <button
                        type="button"
                        onClick={requestClose}
                        disabled={saving}
                        aria-label="閉じる"
                        title="閉じる"
                        className="inline-flex min-h-11 min-w-11 items-center justify-center p-2 hover:bg-white rounded-lg transition-colors shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <X className="w-5 h-5 text-gray-600" />
                    </button>
                </div>

                {/* コンテンツ */}
                <div className="min-h-0 flex-1 overflow-y-auto p-6 bg-gray-50 space-y-6">
                    <div>
                        <label htmlFor={titleFieldId} className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                            タイトル
                        </label>
                        <input
                            ref={titleInputRef}
                            id={titleFieldId}
                            type="text"
                            value={title}
                            onChange={e => {
                                setTitle(e.target.value);
                                setErrorMessage(null);
                            }}
                            placeholder="タイトルを入力"
                            disabled={saving}
                            aria-invalid={Boolean(errorMessage && !title.trim()) || undefined}
                            aria-describedby={errorMessage ? errorId : undefined}
                            className="w-full min-h-11 px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                        />
                    </div>

                    <div>
                        <label htmlFor={bodyFieldId} className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                            本文
                        </label>
                        <textarea
                            id={bodyFieldId}
                            value={body}
                            onChange={e => {
                                setBody(e.target.value);
                                setErrorMessage(null);
                            }}
                            placeholder="本文を入力"
                            rows={14}
                            disabled={saving}
                            aria-invalid={Boolean(errorMessage && !body.trim()) || undefined}
                            aria-describedby={errorMessage ? errorId : undefined}
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-sm resize-none"
                        />
                    </div>

                    <div>
                        <label htmlFor={severityFieldId} className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                            種別
                        </label>
                        <select
                            id={severityFieldId}
                            value={severity}
                            onChange={e => setSeverity(e.target.value as NotificationSeverity)}
                            disabled={saving}
                            className="min-h-11 px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                        >
                            <option value="info">通常 (info)</option>
                            <option value="critical">重要 (critical)</option>
                        </select>
                    </div>

                    {errorMessage && (
                        <p
                            id={errorId}
                            role="alert"
                            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium leading-relaxed text-red-800"
                        >
                            {errorMessage}
                        </p>
                    )}
                </div>

                {/* フッター */}
                <div className="flex shrink-0 items-center justify-end p-4 border-t bg-white space-x-3">
                    <button
                        type="button"
                        onClick={requestClose}
                        disabled={saving}
                        className="min-h-11 px-6 py-2.5 bg-gray-700 text-white rounded-lg hover:bg-gray-800 transition-colors shadow-sm font-medium disabled:opacity-50"
                    >
                        キャンセル
                    </button>
                    <button
                        type="button"
                        onClick={handlePublish}
                        disabled={saving || !title.trim() || !body.trim()}
                        className="min-h-11 px-6 py-2.5 bg-green-700 text-white rounded-lg hover:bg-green-800 transition-colors shadow-sm font-medium flex items-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
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

            {confirmingDiscard && (
                <div className="flex flex-col bg-white p-6 sm:p-8">
                    <div className="space-y-2">
                        <h2 id={discardTitleId} className="text-xl font-bold text-gray-900">
                            入力内容を破棄しますか？
                        </h2>
                        <p id={discardDescriptionId} className="text-sm leading-relaxed text-gray-600">
                            閉じると、入力したお知らせは失われます。
                        </p>
                    </div>
                    <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
                        <button
                            ref={keepEditingButtonRef}
                            type="button"
                            onClick={cancelDiscardConfirmation}
                            className="min-h-11 rounded-lg bg-blue-600 px-6 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
                        >
                            入力を続ける
                        </button>
                        <button
                            type="button"
                            onClick={discardAndClose}
                            className="min-h-11 rounded-lg bg-gray-700 px-6 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
                        >
                            入力内容を破棄して閉じる
                        </button>
                    </div>
                </div>
            )}
        </Dialog>
    );
};
