'use client';

import React, {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { Check, Download, Eye, FileText, Trash2, X } from 'lucide-react';
import ReactMarkdown, { Components } from 'react-markdown';
import { createLogger } from '@/lib/logger';
import { Dialog } from './ui/Dialog';

type CodeProps = React.HTMLAttributes<HTMLElement> & { inline?: boolean };
type DiscardAction = 'close' | 'cancel-edit' | 'view-mode';
type Confirmation =
    | { type: 'discard'; action: DiscardAction }
    | { type: 'delete' };
type PendingFocus = 'heading' | HTMLElement | null;

export interface ContentEditDraft {
    title: string;
    content: string;
}

export interface ContentEditModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    content: string;
    isEditable?: boolean;
    showDownload?: boolean;
    onSave?: (title: string, content: string) => Promise<void>;
    onDelete?: () => void | Promise<void>;
    onDownload?: () => void;
    warningMessage?: React.ReactNode;
    contentLabel?: string;
    renderExtraContent?: (params: { isViewMode: boolean; saving: boolean }) => React.ReactNode;
    draftTitle?: string;
    draftContent?: string;
    onDraftChange?: (draft: ContentEditDraft) => void;
    isDirty?: boolean;
    onDiscardChanges?: () => void;
    onViewModeChange?: (isViewMode: boolean) => void;
}

const contentEditLogger = createLogger('ContentEditModal');

export const ContentEditModal: React.FC<ContentEditModalProps> = ({
    isOpen,
    onClose,
    title: initialTitle,
    content: initialContent,
    isEditable = true,
    showDownload = false,
    onSave,
    onDelete,
    onDownload,
    warningMessage,
    contentLabel = 'コンテンツ',
    renderExtraContent,
    draftTitle: controlledDraftTitle,
    draftContent: controlledDraftContent,
    onDraftChange,
    isDirty: controlledDirty,
    onDiscardChanges,
    onViewModeChange,
}) => {
    const markdownComponents: Components = useMemo(() => ({
        h1: (props) => (
            <h1 className="mt-6 mb-4 text-2xl font-bold text-gray-900" {...props} />
        ),
        h2: (props) => (
            <h2 className="mt-5 mb-3 text-xl font-bold text-gray-900" {...props} />
        ),
        h3: (props) => (
            <h3 className="mt-4 mb-2 text-lg font-bold text-gray-900" {...props} />
        ),
        p: (props) => <p className="mb-4 leading-relaxed" {...props} />,
        ul: (props) => <ul className="mb-4 list-disc space-y-1 pl-6" {...props} />,
        ol: (props) => <ol className="mb-4 list-decimal space-y-1 pl-6" {...props} />,
        li: (props) => <li className="leading-relaxed" {...props} />,
        code: ({ inline, ...props }: CodeProps) => inline ? (
            <code
                className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-sm text-purple-600"
                {...props}
            />
        ) : (
            <code
                className="mb-4 block overflow-x-auto rounded-lg bg-gray-100 p-4 font-mono text-sm"
                {...props}
            />
        ),
        pre: (props) => (
            <pre className="mb-4 overflow-x-auto rounded-lg bg-gray-100 p-4" {...props} />
        ),
        blockquote: (props) => (
            <blockquote
                className="my-4 border-l-4 border-purple-300 pl-4 italic text-gray-700"
                {...props}
            />
        ),
        strong: (props) => <strong className="font-bold text-gray-900" {...props} />,
        em: (props) => <em className="italic" {...props} />,
        a: (props) => (
            <a
                className="text-blue-600 underline hover:text-blue-800"
                target="_blank"
                rel="noopener noreferrer"
                {...props}
            />
        ),
    }), []);
    const [title, setTitle] = useState(initialTitle);
    const [content, setContent] = useState(initialContent);
    const [internalDraftTitle, setInternalDraftTitle] = useState(initialTitle);
    const [internalDraftContent, setInternalDraftContent] = useState(initialContent);
    const [isViewMode, setIsViewMode] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [statusMessage, setStatusMessage] = useState('');
    const dialogTitleId = useId();
    const confirmationTitleId = useId();
    const confirmationDescriptionId = useId();
    const contentFieldId = useId();
    const headingRef = useRef<HTMLHeadingElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const confirmationCancelRef = useRef<HTMLButtonElement>(null);
    const confirmationReturnFocusRef = useRef<HTMLElement | null>(null);
    const pendingFocusRef = useRef<PendingFocus>(null);
    const mountedRef = useRef(false);
    const isOpenRef = useRef(isOpen);
    const busyRef = useRef(false);
    const wasOpenRef = useRef(false);

    const draftTitle = controlledDraftTitle ?? internalDraftTitle;
    const draftContent = controlledDraftContent ?? internalDraftContent;
    const hasChanges = controlledDirty
        ?? (draftTitle !== title || draftContent !== content);
    const isBusy = saving || deleting;
    const isEditingTitle = !isViewMode && isEditable;
    const accessibleTitle = title.trim()
        ? title
        : draftTitle.trim()
            ? draftTitle
            : 'コンテンツ';

    const updateDraft = useCallback((nextDraft: ContentEditDraft) => {
        setInternalDraftTitle(nextDraft.title);
        setInternalDraftContent(nextDraft.content);
        onDraftChange?.(nextDraft);
    }, [onDraftChange]);

    const changeViewMode = useCallback((nextIsViewMode: boolean) => {
        setIsViewMode(nextIsViewMode);
        onViewModeChange?.(nextIsViewMode);
    }, [onViewModeChange]);

    useLayoutEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    useLayoutEffect(() => {
        isOpenRef.current = isOpen;
    }, [isOpen]);

    useEffect(() => {
        setTitle(initialTitle);
        setContent(initialContent);
        setInternalDraftTitle(initialTitle);
        setInternalDraftContent(initialContent);
    }, [initialContent, initialTitle]);

    useEffect(() => {
        const justOpened = isOpen && !wasOpenRef.current;
        wasOpenRef.current = isOpen;
        if (!justOpened) return;

        setInternalDraftTitle(initialTitle);
        setInternalDraftContent(initialContent);
        setConfirmation(null);
        setSaveError(null);
        setStatusMessage('');
        changeViewMode(true);
    }, [changeViewMode, initialContent, initialTitle, isOpen]);

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
    }, [confirmation, isOpen, isViewMode, statusMessage]);

    const rememberConfirmationTrigger = () => {
        const activeElement = document.activeElement;
        confirmationReturnFocusRef.current = activeElement instanceof HTMLElement
            ? activeElement
            : closeButtonRef.current;
    };

    const resetDraft = useCallback(() => {
        updateDraft({ title, content });
        onDiscardChanges?.();
    }, [content, onDiscardChanges, title, updateDraft]);

    const finishEdit = useCallback((message: string) => {
        pendingFocusRef.current = 'heading';
        setConfirmation(null);
        setSaveError(null);
        setStatusMessage(message);
        changeViewMode(true);
    }, [changeViewMode]);

    const performDiscardAction = useCallback((
        action: DiscardAction,
        discarded: boolean,
    ) => {
        if (discarded) resetDraft();

        if (action === 'close') {
            setConfirmation(null);
            setSaveError(null);
            setStatusMessage('');
            changeViewMode(true);
            onClose();
            return;
        }

        finishEdit(discarded ? '変更を破棄しました。' : '編集をキャンセルしました。');
    }, [changeViewMode, finishEdit, onClose, resetDraft]);

    const requestDiscardAction = useCallback((action: DiscardAction) => {
        if (busyRef.current || confirmation) return;
        if (!hasChanges) {
            performDiscardAction(action, false);
            return;
        }

        rememberConfirmationTrigger();
        setConfirmation({ type: 'discard', action });
    }, [confirmation, hasChanges, performDiscardAction]);

    const handleDialogDismiss = useCallback(() => {
        if (busyRef.current) return;
        if (confirmation) {
            const returnTarget = confirmationReturnFocusRef.current;
            confirmationReturnFocusRef.current = null;
            pendingFocusRef.current = returnTarget?.isConnected ? returnTarget : closeButtonRef.current;
            setConfirmation(null);
            return;
        }
        requestDiscardAction('close');
    }, [confirmation, requestDiscardAction]);

    const handleConfirmDiscard = () => {
        if (busyRef.current || confirmation?.type !== 'discard') return;
        const { action } = confirmation;
        confirmationReturnFocusRef.current = null;
        performDiscardAction(action, true);
    };

    const handleSave = async () => {
        if (!onSave || busyRef.current) return;
        if (!draftTitle.trim() || !draftContent.trim()) {
            setSaveError('タイトルと内容を入力してください。入力内容は保持されています。');
            return;
        }

        busyRef.current = true;
        setSaveError(null);
        setStatusMessage('');
        setSaving(true);
        try {
            await onSave(draftTitle, draftContent);
            if (!mountedRef.current || !isOpenRef.current) return;

            setTitle(draftTitle);
            setContent(draftContent);
            setInternalDraftTitle(draftTitle);
            setInternalDraftContent(draftContent);
            finishEdit('変更を保存しました。');
        } catch (error) {
            contentEditLogger.error('モーダルでの保存に失敗', error);
            if (!mountedRef.current || !isOpenRef.current) return;
            setSaveError(
                '保存に失敗しました。入力した変更内容は保持されています。もう一度保存してください。',
            );
        } finally {
            busyRef.current = false;
            if (mountedRef.current) setSaving(false);
        }
    };

    const handleDeleteRequest = () => {
        if (!onDelete || busyRef.current || confirmation) return;
        rememberConfirmationTrigger();
        setSaveError(null);
        setConfirmation({ type: 'delete' });
    };

    const handleDelete = async () => {
        if (!onDelete || busyRef.current || confirmation?.type !== 'delete') return;

        busyRef.current = true;
        setDeleting(true);
        try {
            await onDelete();
        } catch (error) {
            contentEditLogger.error('モーダルでの削除に失敗', error);
            if (!mountedRef.current || !isOpenRef.current) return;

            const returnTarget = confirmationReturnFocusRef.current;
            confirmationReturnFocusRef.current = null;
            pendingFocusRef.current = returnTarget?.isConnected ? returnTarget : closeButtonRef.current;
            setConfirmation(null);
            setSaveError('削除に失敗しました。時間をおいて、もう一度お試しください。');
        } finally {
            busyRef.current = false;
            if (mountedRef.current) setDeleting(false);
        }
    };

    const confirmationTitle = confirmation?.type === 'delete'
        ? `「${accessibleTitle}」を削除しますか？`
        : '未保存の変更があります';
    const confirmationDescription = confirmation?.type === 'delete'
        ? '削除したコンテンツは元に戻せません。'
        : confirmation?.action === 'close'
            ? '閉じると、保存していない変更は失われます。'
            : '表示モードに戻ると、保存していない変更は失われます。';

    return (
        <Dialog
            isOpen={isOpen}
            onClose={handleDialogDismiss}
            initialFocusRef={headingRef}
            dismissible={!isBusy}
            closeOnBackdrop
            role={confirmation ? 'alertdialog' : undefined}
            aria-labelledby={confirmation ? confirmationTitleId : dialogTitleId}
            aria-describedby={confirmation ? confirmationDescriptionId : undefined}
            className={`w-[calc(100%-2rem)] ${
                confirmation ? 'max-w-lg' : 'max-w-4xl'
            } max-h-[calc(100dvh-2rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl open:flex open:flex-col`}
        >
            <div
                className={`${confirmation ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col`}
                aria-hidden={confirmation ? true : undefined}
                inert={confirmation ? true : undefined}
            >
                <div className="grid grid-cols-[minmax(0,1fr)_2.75rem] items-center gap-x-3 gap-y-3 border-b bg-gradient-to-r from-purple-50 to-pink-50 p-4 sm:grid-cols-[minmax(0,1fr)_auto_2.75rem] sm:p-6">
                    <div className="min-w-0">
                        <h2
                            ref={headingRef}
                            id={dialogTitleId}
                            tabIndex={-1}
                            className={isEditingTitle
                                ? 'sr-only'
                                : 'truncate rounded-sm text-xl font-bold text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2'}
                        >
                            {isEditingTitle ? `${accessibleTitle}を編集` : accessibleTitle}
                        </h2>
                        {isEditingTitle && (
                            <input
                                type="text"
                                value={draftTitle}
                                onChange={(event) => {
                                    setStatusMessage('');
                                    updateDraft({ title: event.target.value, content: draftContent });
                                }}
                                className="min-h-11 w-full min-w-0 rounded-lg border border-purple-300 px-3 py-2 text-base text-gray-900 outline-none focus:ring-2 focus:ring-purple-500"
                                placeholder="タイトルを入力してください"
                                aria-label="タイトル"
                                aria-invalid={!draftTitle.trim() || undefined}
                                disabled={isBusy}
                            />
                        )}
                    </div>

                    {isEditable && onSave && (
                        <div
                            className="col-span-2 row-start-2 flex min-w-0 items-center rounded-lg bg-gray-100 p-1 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:justify-self-end"
                            role="group"
                            aria-label="表示モード"
                        >
                            <button
                                type="button"
                                onClick={() => requestDiscardAction('view-mode')}
                                className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 sm:flex-none ${
                                    isViewMode
                                        ? 'bg-white text-purple-600 shadow-sm'
                                        : 'text-gray-700 hover:text-gray-900'
                                }`}
                                aria-pressed={isViewMode}
                                disabled={isBusy}
                            >
                                <Eye className="h-4 w-4" />
                                <span>表示</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setStatusMessage('');
                                    setSaveError(null);
                                    changeViewMode(false);
                                }}
                                className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 sm:flex-none ${
                                    !isViewMode
                                        ? 'bg-white text-purple-600 shadow-sm'
                                        : 'text-gray-700 hover:text-gray-900'
                                }`}
                                aria-pressed={!isViewMode}
                                disabled={isBusy}
                            >
                                <FileText className="h-4 w-4" />
                                <span>編集</span>
                            </button>
                        </div>
                    )}

                    <button
                        ref={closeButtonRef}
                        type="button"
                        onClick={() => requestDiscardAction('close')}
                        disabled={isBusy}
                        className="col-start-2 row-start-1 flex h-11 w-11 items-center justify-center rounded-lg shadow-sm transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 sm:col-start-3"
                        aria-label="閉じる"
                        title="閉じる"
                    >
                        <X className="h-5 w-5 text-gray-700" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto bg-gray-50 p-4 sm:p-6">
                    <div>
                        {isViewMode ? (
                            <h3 className="mb-2 block text-xs font-semibold uppercase tracking-wide text-gray-500">
                                {contentLabel}
                            </h3>
                        ) : (
                            <label
                                className="mb-2 block text-xs font-semibold uppercase tracking-wide text-gray-500"
                                htmlFor={contentFieldId}
                            >
                                {contentLabel}
                            </label>
                        )}
                        {isViewMode ? (
                            <div className="prose prose-sm max-w-none text-gray-800">
                                <ReactMarkdown components={markdownComponents}>
                                    {content}
                                </ReactMarkdown>
                            </div>
                        ) : (
                            <textarea
                                id={contentFieldId}
                                value={draftContent}
                                onChange={(event) => {
                                    setStatusMessage('');
                                    updateDraft({ title: draftTitle, content: event.target.value });
                                }}
                                rows={20}
                                className="min-h-11 w-full resize-none rounded-lg border border-gray-300 px-4 py-3 font-mono text-base focus:border-transparent focus:ring-2 focus:ring-purple-500"
                                placeholder="コンテンツを入力してください"
                                aria-invalid={!draftContent.trim() || undefined}
                                disabled={isBusy}
                            />
                        )}
                    </div>

                    {renderExtraContent && (
                        <div className="mt-6">
                            {renderExtraContent({ isViewMode, saving })}
                        </div>
                    )}

                    {warningMessage && <div className="mt-4">{warningMessage}</div>}

                    {saveError && (
                        <div
                            role="alert"
                            className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium leading-relaxed text-red-800"
                        >
                            {saveError}
                        </div>
                    )}

                    <div role="status" aria-live="polite" className="sr-only">
                        {statusMessage}
                    </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-white p-4">
                    {isViewMode ? (
                        <>
                            {onDelete && isEditable ? (
                                <button
                                    type="button"
                                    onClick={handleDeleteRequest}
                                    disabled={isBusy}
                                    className="flex min-h-11 items-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 sm:px-6"
                                >
                                    <Trash2 className="h-4 w-4" />
                                    <span>削除</span>
                                </button>
                            ) : <div />}
                            <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
                                {showDownload && onDownload && (
                                    <button
                                        type="button"
                                        onClick={onDownload}
                                        className="flex min-h-11 items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 sm:px-6"
                                    >
                                        <Download className="h-4 w-4" />
                                        <span>ダウンロード</span>
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => requestDiscardAction('close')}
                                    disabled={isBusy}
                                    className="min-h-11 rounded-lg border border-gray-300 px-5 py-2.5 font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 sm:px-6"
                                >
                                    閉じる
                                </button>
                            </div>
                        </>
                    ) : (
                        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => requestDiscardAction('cancel-edit')}
                                disabled={isBusy}
                                className="min-h-11 rounded-lg bg-gray-700 px-5 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 sm:px-6"
                            >
                                キャンセル
                            </button>
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={isBusy}
                                className="flex min-h-11 items-center gap-2 rounded-lg bg-green-700 px-5 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-green-800 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2 sm:px-6"
                            >
                                {saving ? (
                                    <>
                                        <span className="h-4 w-4 animate-spin rounded-full border-b-2 border-white" />
                                        <span>保存中...</span>
                                    </>
                                ) : (
                                    <>
                                        <Check className="h-4 w-4" />
                                        <span>保存</span>
                                    </>
                                )}
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {confirmation && (
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
                            disabled={isBusy}
                            className="min-h-11 rounded-lg bg-gray-700 px-6 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
                        >
                            {confirmation.type === 'delete' ? 'キャンセル' : '編集を続ける'}
                        </button>
                        <button
                            type="button"
                            onClick={confirmation.type === 'delete' ? handleDelete : handleConfirmDiscard}
                            disabled={isBusy}
                            className="min-h-11 rounded-lg bg-red-600 px-6 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
                        >
                            {confirmation.type === 'delete'
                                ? deleting ? '削除中...' : '削除する'
                                : confirmation.action === 'close'
                                    ? '変更を破棄して閉じる'
                                    : '変更を破棄して表示に戻る'}
                        </button>
                    </div>
                </div>
            )}
        </Dialog>
    );
};
