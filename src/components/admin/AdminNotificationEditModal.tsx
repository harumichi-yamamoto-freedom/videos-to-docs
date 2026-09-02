'use client';

import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { X, Eye, FileText, Check, Trash2, Info, AlertTriangle } from 'lucide-react';
import {
    deleteSystemNotification,
    NotificationSeverity,
    SystemNotification,
    updateSystemNotification,
} from '@/lib/systemNotifications';
import { createLogger } from '@/lib/logger';
import { Dialog } from '@/components/ui/Dialog';

const adminEditModalLogger = createLogger('AdminNotificationEditModal');

interface AdminNotificationEditModalProps {
    notification: SystemNotification | null;
    isOpen: boolean;
    onClose: () => void;
}

type DiscardAction = 'close' | 'view-mode' | 'cancel-edit';
type Confirmation =
    | { type: 'discard'; action: DiscardAction }
    | { type: 'delete' }
    | { type: 'publish-state'; nextPublished: boolean };

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
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const headingId = useId();
    const confirmationTitleId = useId();
    const confirmationDescriptionId = useId();
    const errorId = useId();
    const headingRef = useRef<HTMLHeadingElement>(null);
    const confirmationCancelRef = useRef<HTMLButtonElement>(null);
    const confirmationReturnFocusRef = useRef<HTMLElement | null>(null);
    const pendingFocusRef = useRef<HTMLElement | 'heading' | null>(null);

    const resetDraftFromNotification = (n: SystemNotification | null) => {
        setEditedTitle(n?.title ?? '');
        setEditedBody(n?.body ?? '');
        setEditedSeverity(n?.severity ?? 'info');
        setEditedPublished(n?.published ?? true);
    };

    // 通知が切り替わったらドラフトを初期化（Adjusting state during render）
    // 初期値を null に固定するのは、通知を渡された状態でマウントされた場合にも
    // 初回レンダーでドラフトを初期化するため（notification?.id で初期化すると空のまま残る）。
    const [lastNotificationId, setLastNotificationId] = useState<string | null>(null);
    if ((notification?.id ?? null) !== lastNotificationId) {
        setLastNotificationId(notification?.id ?? null);
        setIsViewMode(true);
        setConfirmation(null);
        setSaveError(null);
        resetDraftFromNotification(notification);
    }

    // 確認パネルが開いたら安全な選択肢へ、畳まれたら元のトリガーへフォーカスを
    // 運ぶ（window.confirm が担っていたフォーカス管理の代替）。
    useLayoutEffect(() => {
        if (!isOpen) return;
        if (confirmation) {
            confirmationCancelRef.current?.focus({ preventScroll: true });
            return;
        }

        const pendingFocus = pendingFocusRef.current;
        pendingFocusRef.current = null;
        const target = pendingFocus === 'heading' ? headingRef.current : pendingFocus;
        if (target?.isConnected) target.focus({ preventScroll: true });
    }, [confirmation, isOpen, isViewMode]);

    // notification が null のときは Dialog を開かないので、表示に使う値は既定値で構わない。
    const display = notification ? SEVERITY_DISPLAY[notification.severity] : SEVERITY_DISPLAY.info;
    const Icon = display.Icon;

    const hasChanges = notification !== null && (
        editedTitle !== notification.title
        || editedBody !== notification.body
        || editedSeverity !== notification.severity
        || editedPublished !== notification.published
    );

    const rememberConfirmationTrigger = () => {
        const activeElement = document.activeElement;
        confirmationReturnFocusRef.current = activeElement instanceof HTMLElement
            ? activeElement
            : headingRef.current;
    };

    const dismissConfirmation = () => {
        const returnTarget = confirmationReturnFocusRef.current;
        confirmationReturnFocusRef.current = null;
        pendingFocusRef.current = returnTarget?.isConnected ? returnTarget : 'heading';
        setConfirmation(null);
    };

    const performDiscardAction = (action: DiscardAction, discarded: boolean) => {
        if (action === 'close') {
            setConfirmation(null);
            setSaveError(null);
            onClose();
            return;
        }

        if (discarded) resetDraftFromNotification(notification);
        pendingFocusRef.current = 'heading';
        setConfirmation(null);
        setSaveError(null);
        setIsViewMode(true);
    };

    const requestDiscardAction = (action: DiscardAction) => {
        if (saving || confirmation) return;
        const needsConfirmation = action === 'close'
            ? !isViewMode && hasChanges
            : hasChanges;
        if (!needsConfirmation) {
            performDiscardAction(action, false);
            return;
        }

        rememberConfirmationTrigger();
        setConfirmation({ type: 'discard', action });
    };

    const handleDialogDismiss = () => {
        if (saving) return;
        if (confirmation) {
            // 確認中の Esc は確認だけを畳み、元の画面へ戻す。
            dismissConfirmation();
            return;
        }
        requestDiscardAction('close');
    };

    const performSave = async (fromConfirmation: boolean) => {
        if (!notification) return;
        try {
            setSaving(true);
            await updateSystemNotification(notification.id, {
                title: editedTitle.trim(),
                body: editedBody.trim(),
                severity: editedSeverity,
                published: editedPublished,
            });
            pendingFocusRef.current = 'heading';
            setConfirmation(null);
            setSaveError(null);
            setIsViewMode(true);
        } catch (error) {
            adminEditModalLogger.error('通知の更新に失敗', error, { id: notification.id });
            // 公開確認パネル経由なら畳んで編集フォームへ戻し、そこでエラーを見せる。
            // 直接保存ならフォーカスを動かさない（入力中の手を止めない）。
            if (fromConfirmation) dismissConfirmation();
            setSaveError('お知らせを更新できませんでした。編集内容は保持されています。もう一度お試しください。');
        } finally {
            setSaving(false);
        }
    };

    const handleSaveRequest = async () => {
        if (!notification || saving || confirmation) return;
        if (!editedTitle.trim() || !editedBody.trim()) {
            setSaveError('タイトルと本文を入力してください。');
            return;
        }
        setSaveError(null);
        // 公開状態が変わる場合は影響範囲が大きいので、ダイアログ内で確認を挟む。
        if (editedPublished !== notification.published) {
            rememberConfirmationTrigger();
            setConfirmation({ type: 'publish-state', nextPublished: editedPublished });
            return;
        }
        await performSave(false);
    };

    const performDelete = async () => {
        if (!notification) return;
        try {
            setSaving(true);
            await deleteSystemNotification(notification.id);
            setConfirmation(null);
            onClose();
        } catch (error) {
            adminEditModalLogger.error('通知の削除に失敗', error, { id: notification.id });
            dismissConfirmation();
            setSaveError('お知らせを削除できませんでした。時間をおいて、もう一度お試しください。');
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteRequest = () => {
        if (!notification || saving || confirmation) return;
        rememberConfirmationTrigger();
        setSaveError(null);
        setConfirmation({ type: 'delete' });
    };

    const confirmationTitle = confirmation?.type === 'delete'
        ? `「${notification?.title ?? ''}」を削除しますか？`
        : confirmation?.type === 'publish-state'
            ? confirmation.nextPublished
                ? 'このお知らせを公開しますか？'
                : 'このお知らせを非公開（下書き）にしますか？'
            : '未保存の変更があります';
    const confirmationDescription = confirmation?.type === 'delete'
        ? '削除したお知らせは元に戻せません。'
        : confirmation?.type === 'publish-state'
            ? confirmation.nextPublished
                ? '保存すると、ユーザーの画面に表示されるようになります。'
                : '保存すると、ユーザーの画面から非表示になります（既に閲覧したユーザーの既読状態はそのまま残ります）。'
            : confirmation?.action === 'close'
                ? '閉じると、保存していない変更は失われます。'
                : '表示モードに戻ると、保存していない変更は失われます。';

    const confirmationConfirmLabel = confirmation?.type === 'delete'
        ? saving ? '削除中...' : '削除する'
        : confirmation?.type === 'publish-state'
            ? saving
                ? '保存中...'
                : confirmation.nextPublished ? '公開して保存する' : '非公開にして保存する'
            : confirmation?.action === 'close'
                ? '変更を破棄して閉じる'
                : '変更を破棄して表示に戻る';

    const handleConfirmationConfirm = () => {
        if (!confirmation || saving) return;
        if (confirmation.type === 'delete') {
            void performDelete();
            return;
        }
        if (confirmation.type === 'publish-state') {
            void performSave(true);
            return;
        }
        confirmationReturnFocusRef.current = null;
        performDiscardAction(confirmation.action, true);
    };

    return (
        <Dialog
            isOpen={isOpen && Boolean(notification)}
            onClose={handleDialogDismiss}
            initialFocusRef={headingRef}
            dismissible={!saving}
            role={confirmation ? 'alertdialog' : undefined}
            aria-labelledby={confirmation ? confirmationTitleId : headingId}
            aria-describedby={confirmation ? confirmationDescriptionId : undefined}
            aria-busy={saving || undefined}
            className={`w-[calc(100%-2rem)] ${confirmation ? 'max-w-lg' : 'max-w-4xl'} max-h-[90dvh] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl open:flex open:flex-col`}
        >
            {notification && (
                <div
                    className={`${confirmation ? 'hidden' : 'flex'} max-h-[90dvh] min-h-0 flex-col bg-white`}
                    aria-hidden={confirmation ? true : undefined}
                    inert={confirmation ? true : undefined}
                >
                    {/* ヘッダー */}
                    <div className="flex shrink-0 items-center justify-between p-6 border-b bg-gradient-to-r from-purple-50 to-pink-50">
                        {!isViewMode ? (
                            <div className="flex items-center flex-1 mr-4 space-x-2">
                                <h2 ref={headingRef} id={headingId} tabIndex={-1} className="sr-only">
                                    お知らせを編集
                                </h2>
                                <input
                                    type="text"
                                    value={editedTitle}
                                    onChange={e => {
                                        setEditedTitle(e.target.value);
                                        setSaveError(null);
                                    }}
                                    className="flex-1 min-h-11 px-3 py-2 border border-purple-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-900"
                                    placeholder="タイトルを入力"
                                    aria-label="タイトル"
                                    aria-invalid={Boolean(saveError && !editedTitle.trim()) || undefined}
                                    aria-describedby={saveError ? errorId : undefined}
                                    autoFocus
                                    disabled={saving}
                                />
                            </div>
                        ) : (
                            <div className="flex items-center flex-1 mr-4 space-x-2 min-w-0">
                                <Icon className={`w-6 h-6 flex-shrink-0 ${display.iconColor}`} />
                                <h2
                                    ref={headingRef}
                                    id={headingId}
                                    tabIndex={-1}
                                    className="truncate rounded-sm text-xl font-bold text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
                                >
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
                                    type="button"
                                    onClick={() => requestDiscardAction('view-mode')}
                                    className={`min-h-11 px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center space-x-2 ${
                                        isViewMode
                                            ? 'bg-white text-purple-600 shadow-sm'
                                            : 'text-gray-600 hover:text-gray-900'
                                    }`}
                                    aria-pressed={isViewMode}
                                    disabled={saving}
                                >
                                    <Eye className="w-4 h-4" />
                                    <span>表示</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSaveError(null);
                                        setIsViewMode(false);
                                    }}
                                    className={`min-h-11 px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center space-x-2 ${
                                        !isViewMode
                                            ? 'bg-white text-purple-600 shadow-sm'
                                            : 'text-gray-600 hover:text-gray-900'
                                    }`}
                                    aria-pressed={!isViewMode}
                                    disabled={saving}
                                >
                                    <FileText className="w-4 h-4" />
                                    <span>編集</span>
                                </button>
                            </div>
                            <button
                                type="button"
                                onClick={() => requestDiscardAction('close')}
                                disabled={saving}
                                aria-label="閉じる"
                                title="閉じる"
                                className="inline-flex min-h-11 min-w-11 items-center justify-center p-2 hover:bg-white rounded-lg transition-colors shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <X className="w-5 h-5 text-gray-600" />
                            </button>
                        </div>
                    </div>

                    {/* コンテンツ */}
                    <div className="min-h-0 flex-1 overflow-y-auto p-6 bg-gray-50 space-y-6">
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
                                    onChange={e => {
                                        setEditedBody(e.target.value);
                                        setSaveError(null);
                                    }}
                                    rows={14}
                                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-sm resize-none"
                                    placeholder="本文を入力"
                                    aria-label="本文"
                                    aria-invalid={Boolean(saveError && !editedBody.trim()) || undefined}
                                    aria-describedby={saveError ? errorId : undefined}
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
                                    aria-label="種別"
                                    className="min-h-11 px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent"
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
                                <label className="inline-flex min-h-11 items-center gap-2 text-sm text-gray-700 cursor-pointer">
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

                        {saveError && (
                            <p
                                id={errorId}
                                role="alert"
                                className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium leading-relaxed text-red-800"
                            >
                                {saveError}
                            </p>
                        )}
                    </div>

                    {/* フッター */}
                    <div className="flex shrink-0 items-center justify-between p-4 border-t bg-white">
                        {isViewMode ? (
                            <>
                                <button
                                    type="button"
                                    onClick={handleDeleteRequest}
                                    disabled={saving}
                                    className="min-h-11 px-6 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center space-x-2 shadow-sm font-medium disabled:opacity-50"
                                >
                                    <Trash2 className="w-4 h-4" />
                                    <span>削除</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => requestDiscardAction('close')}
                                    className="min-h-11 px-6 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                                >
                                    閉じる
                                </button>
                            </>
                        ) : (
                            <>
                                <div></div>
                                <div className="flex items-center space-x-3">
                                    <button
                                        type="button"
                                        onClick={() => requestDiscardAction('cancel-edit')}
                                        disabled={saving}
                                        className="min-h-11 px-6 py-2.5 bg-gray-700 text-white rounded-lg hover:bg-gray-800 transition-colors shadow-sm font-medium disabled:opacity-50"
                                    >
                                        キャンセル
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleSaveRequest}
                                        disabled={saving}
                                        className="min-h-11 px-6 py-2.5 bg-green-700 text-white rounded-lg hover:bg-green-800 transition-colors shadow-sm font-medium flex items-center space-x-2 disabled:opacity-50"
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
            )}

            {notification && confirmation && (
                <div className="flex flex-col rounded-2xl bg-white p-6 sm:p-8">
                    <div className="space-y-2">
                        <h2 id={confirmationTitleId} className="text-xl font-bold text-gray-900">
                            {confirmationTitle}
                        </h2>
                        <p
                            id={confirmationDescriptionId}
                            className="text-sm leading-relaxed text-gray-600"
                        >
                            {confirmationDescription}
                        </p>
                    </div>
                    <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
                        <button
                            ref={confirmationCancelRef}
                            type="button"
                            onClick={handleDialogDismiss}
                            disabled={saving}
                            className="min-h-11 rounded-lg bg-gray-700 px-6 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
                        >
                            {confirmation.type === 'discard' ? '編集を続ける' : 'キャンセル'}
                        </button>
                        <button
                            type="button"
                            onClick={handleConfirmationConfirm}
                            disabled={saving}
                            className={`min-h-11 rounded-lg px-6 py-2.5 font-medium text-white shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                                confirmation.type === 'publish-state'
                                    ? 'bg-blue-600 hover:bg-blue-700 focus-visible:ring-blue-500'
                                    : 'bg-red-600 hover:bg-red-700 focus-visible:ring-red-500'
                            }`}
                        >
                            {confirmationConfirmLabel}
                        </button>
                    </div>
                </div>
            )}
        </Dialog>
    );
};
