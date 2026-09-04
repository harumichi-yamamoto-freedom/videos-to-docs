'use client';

import React, {
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import {
    ArrowLeft,
    Check,
    Eye,
    FileText,
    FileTextIcon,
    Printer,
} from 'lucide-react';
import type { Timestamp } from 'firebase/firestore';
import {
    DocumentSizeLimitError,
    isSameUpdatedAt,
    Transcription,
    TranscriptionConflictError,
} from '@/lib/firestore';
import { createLogger } from '@/lib/logger';
import { MarkdownDocument } from '@/components/MarkdownDocument';
import { TranscriptAudioBar, TranscriptAwareMarkdown } from '@/components/TranscriptDocumentView';
import { renameSpeakerLabel } from '@/components/transcriptMarkdownComponents';
import { DocumentPrintPortal } from '@/components/DocumentPrintPortal';
import { PdfDocumentHeader } from './PdfDocumentHeader';
import { useDocumentPrint } from '@/hooks/useDocumentPrint';
import { getGeminiModelLabel } from '../constants/geminiModels';
import { THINKING_LEVELS } from '../constants/geminiThinking';
import {
    DEFAULT_PDF_FONT_ID,
    normalizePdfFontId,
    PDF_FONTS,
    resolvePdfFontId,
    type PdfFontId,
} from '../constants/pdfFonts';
import {
    DEFAULT_PDF_THEME_ID,
    normalizePdfThemeId,
    PDF_THEMES,
    type PdfThemeId,
} from '../constants/pdfThemes';

const documentDetailLogger = createLogger('DocumentDetailPanel');
const PDF_INCLUDE_METADATA_STORAGE_KEY = 'pdfIncludeMetadata';
const PDF_THEME_STORAGE_KEY = 'pdfTheme';
const PDF_FONT_STORAGE_KEY = 'pdfFont';

function getThinkingLevelLabel(level: string): string {
    const normalizedLevel = level.trim().toLowerCase();
    if (normalizedLevel === 'unspecified') {
        return '未指定';
    }

    return (
        THINKING_LEVELS.find(option => option.id === normalizedLevel)?.label ?? level
    );
}

export interface DocumentUpdatePatch {
    title: string;
    text: string;
}

export interface DocumentDetailPanelHandle {
    save: () => Promise<boolean>;
    discard: () => void;
    getDraft: () => DocumentUpdatePatch;
    focus: () => void;
}

export interface DocumentUpdateMeta {
    /**
     * このdraftが根拠にしている版のupdatedAt（楽観的並行性制御の期待値）。
     * ポーリングで前進する一覧の最新値ではなく、エディタが内容をロード/同期した
     * 時点の版を固定して渡す。null = 「updatedAt未設定の版を読んだ」。
     */
    expectedUpdatedAt: Timestamp | Date | null;
}

export interface DocumentDetailPanelProps {
    document: Transcription | null;
    onDocumentUpdate?: (
        documentId: string,
        patch: DocumentUpdatePatch,
        meta: DocumentUpdateMeta,
    ) => Promise<void>;
    onDirtyChange?: (dirty: boolean) => void;
    /** draftを破棄した瞬間に同期で通知する（onDirtyChange(false)は保存成功でも発火するため区別が要る）。 */
    onDraftDiscarded?: () => void;
    /** 保存競合時の「最新の内容を読み込む」導線。親が一覧の再取得を引き受ける。 */
    onRequestLatestDocument?: () => void;
    onBackToList?: () => void;
}

type SaveErrorState = {
    message: string;
    /** 競合エラーのときだけ true。最新読込の導線をエラー表示へ添える。 */
    canReloadLatest: boolean;
};

type DraftBaseline = DocumentUpdatePatch & { documentId: string | null };

export function DocumentDetailPanelView({
    document,
    onDocumentUpdate,
    onDirtyChange,
    onDraftDiscarded,
    onRequestLatestDocument,
    onBackToList,
}: DocumentDetailPanelProps, ref?: React.ForwardedRef<DocumentDetailPanelHandle>) {
    const [isViewMode, setIsViewMode] = useState(true);
    const [editedTitle, setEditedTitle] = useState(document?.title ?? '');
    const [editedContent, setEditedContent] = useState(document?.text ?? '');
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<SaveErrorState | null>(null);
    const [showDiscardConfirmation, setShowDiscardConfirmation] = useState(false);
    const [includeMetadata, setIncludeMetadata] = useState(false);
    const [pdfTheme, setPdfTheme] = useState<PdfThemeId>(DEFAULT_PDF_THEME_ID);
    const [pdfFont, setPdfFont] = useState<PdfFontId>(DEFAULT_PDF_FONT_ID);
    const [, setDraftRevision] = useState(0);
    const rootRef = useRef<HTMLDivElement>(null);

    const selectedDocumentIdRef = useRef(document?.id ?? null);
    const currentDocumentRef = useRef(document);
    const currentTitleRef = useRef(editedTitle);
    const currentContentRef = useRef(editedContent);
    const savingRef = useRef(false);
    const baselineRef = useRef<DraftBaseline>({
        documentId: document?.id ?? null,
        title: document?.title ?? '',
        text: document?.text ?? '',
    });
    // 競合検査の期待値。ライブなprops.document.updatedAtから保存時に引くと、
    // ポーリングが他者の更新へ勝手に追随して楽観ロックが自己無効化するため、
    // draftの根拠が最新版の内容へ揃った時（下のrebase effect）だけ前進させる。
    const draftBaselineUpdatedAtRef = useRef<Timestamp | Date | null>(
        document?.updatedAt ?? null,
    );
    // 「最新の内容を読み込む」で利用者が採用を明示した版の予約。
    // 予約は「クリック時点で利用者が見た特定の版」に紐づき、後着の受信がその版と
    // 一致した時だけ期待値へ採る。boolean武装(次に届く任意の版を無条件採用)にすると、
    // 破棄を生き延びた予約や取得不発で残った予約が、利用者が一度も見ていない
    // 別writerの版を自動採用し、無警告上書きが再発する。
    const adoptionReservedVersionRef = useRef<
        { updatedAt: Timestamp | Date | null } | null
    >(null);
    const lastSavedDraftRef = useRef<DraftBaseline | null>(null);
    const discardDialogRef = useRef<HTMLDivElement>(null);
    const discardCancelButtonRef = useRef<HTMLButtonElement>(null);
    const discardReturnFocusRef = useRef<HTMLElement | null>(null);
    const { printPdf, isPreparing } = useDocumentPrint(document);

    selectedDocumentIdRef.current = document?.id ?? null;
    currentDocumentRef.current = document;
    currentTitleRef.current = editedTitle;
    currentContentRef.current = editedContent;

    const isEditable = !!onDocumentUpdate;
    const hasChanges = Boolean(
        document?.id &&
        baselineRef.current.documentId === document.id &&
        (editedTitle !== baselineRef.current.title ||
            editedContent !== baselineRef.current.text),
    );

    useEffect(() => {
        const nextBaseline: DraftBaseline = {
            documentId: document?.id ?? null,
            title: document?.title ?? '',
            text: document?.text ?? '',
        };
        const baseline = baselineRef.current;

        if (baseline.documentId !== nextBaseline.documentId) {
            baselineRef.current = nextBaseline;
            draftBaselineUpdatedAtRef.current = document?.updatedAt ?? null;
            adoptionReservedVersionRef.current = null;
            lastSavedDraftRef.current = null;
            discardReturnFocusRef.current = null;
            setEditedTitle(nextBaseline.title);
            setEditedContent(nextBaseline.text);
            setIsViewMode(true);
            setSaveError(null);
            setShowDiscardConfirmation(false);
            return;
        }

        const savedDraft = lastSavedDraftRef.current;
        if (savedDraft?.documentId === nextBaseline.documentId) {
            if (
                savedDraft.title === nextBaseline.title &&
                savedDraft.text === nextBaseline.text
            ) {
                lastSavedDraftRef.current = null;
            } else {
                return;
            }
        }

        const titleIsDirty = currentTitleRef.current !== baseline.title;
        const contentIsDirty = currentContentRef.current !== baseline.text;
        const draftWasDirty = titleIsDirty || contentIsDirty;
        const shouldRebaseTitle = !titleIsDirty || currentTitleRef.current === nextBaseline.title;
        const shouldRebaseContent = !contentIsDirty || currentContentRef.current === nextBaseline.text;
        const rebasedBaseline: DraftBaseline = {
            documentId: nextBaseline.documentId,
            title: shouldRebaseTitle ? nextBaseline.title : baseline.title,
            text: shouldRebaseContent ? nextBaseline.text : baseline.text,
        };
        baselineRef.current = rebasedBaseline;

        // draft全体が受信版の内容に根拠を持つ時だけ期待値を前進させる。dirtyな
        // フィールドが旧版のまま残る部分rebaseで前進させると、保存が他者の変更を
        // 競合検査を素通りして上書きする。例外は「最新の内容を読み込む」で利用者が
        // 採用を明示した特定版の再取得だけ。予約版と異なる版(利用者が見ていない
        // 別writerの版)が届いても採用せず、通常の競合として扱う。
        const reservedVersion = adoptionReservedVersionRef.current;
        adoptionReservedVersionRef.current = null;
        if (
            (rebasedBaseline.title === nextBaseline.title
                && rebasedBaseline.text === nextBaseline.text)
            || (reservedVersion !== null
                && isSameUpdatedAt(document?.updatedAt ?? null, reservedVersion.updatedAt))
        ) {
            draftBaselineUpdatedAtRef.current = document?.updatedAt ?? null;
        }

        if (!titleIsDirty && currentTitleRef.current !== nextBaseline.title) {
            setEditedTitle(nextBaseline.title);
        }
        if (!contentIsDirty && currentContentRef.current !== nextBaseline.text) {
            setEditedContent(nextBaseline.text);
        }
        if (
            draftWasDirty &&
            currentTitleRef.current === rebasedBaseline.title &&
            currentContentRef.current === rebasedBaseline.text
        ) {
            setDraftRevision(revision => revision + 1);
        }
        // updatedAtも依存に含める: 内容が同一で版だけ前進した受信でも、cleanな
        // draftの期待値は最新版へ追随させる（dirty時は上の完全一致条件が据え置く）。
    }, [document?.id, document?.text, document?.title, document?.updatedAt]);

    useEffect(() => {
        onDirtyChange?.(hasChanges);
    }, [hasChanges, onDirtyChange]);

    useEffect(() => {
        if (!showDiscardConfirmation) return;
        discardCancelButtonRef.current?.focus();

        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                const returnFocusElement = discardReturnFocusRef.current;
                discardReturnFocusRef.current = null;
                setShowDiscardConfirmation(false);
                window.requestAnimationFrame(() => returnFocusElement?.focus());
                return;
            }

            if (event.key !== 'Tab') return;
            const focusableElements = Array.from(
                discardDialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [],
            );
            if (focusableElements.length === 0) return;

            const firstElement = focusableElements[0];
            const lastElement = focusableElements[focusableElements.length - 1];
            if (event.shiftKey && window.document.activeElement === firstElement) {
                event.preventDefault();
                lastElement.focus();
            } else if (!event.shiftKey && window.document.activeElement === lastElement) {
                event.preventDefault();
                firstElement.focus();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [showDiscardConfirmation]);

    useEffect(() => {
        try {
            setIncludeMetadata(
                window.localStorage.getItem(PDF_INCLUDE_METADATA_STORAGE_KEY) === 'true',
            );
        } catch {
            setIncludeMetadata(false);
        }
    }, []);

    useEffect(() => {
        try {
            setPdfTheme(
                normalizePdfThemeId(
                    window.localStorage.getItem(PDF_THEME_STORAGE_KEY),
                ),
            );
        } catch {
            setPdfTheme(DEFAULT_PDF_THEME_ID);
        }
    }, []);

    useEffect(() => {
        try {
            setPdfFont(
                normalizePdfFontId(
                    window.localStorage.getItem(PDF_FONT_STORAGE_KEY),
                ),
            );
        } catch {
            setPdfFont(DEFAULT_PDF_FONT_ID);
        }
    }, []);

    const handleIncludeMetadataChange = (
        event: React.ChangeEvent<HTMLInputElement>,
    ): void => {
        const checked = event.target.checked;
        setIncludeMetadata(checked);

        try {
            window.localStorage.setItem(
                PDF_INCLUDE_METADATA_STORAGE_KEY,
                String(checked),
            );
        } catch {
            // localStorage が利用できない環境でも、現在の選択はそのまま反映する。
        }
    };

    const handlePdfThemeChange = (
        event: React.ChangeEvent<HTMLSelectElement>,
    ): void => {
        const nextTheme = normalizePdfThemeId(event.target.value);
        setPdfTheme(nextTheme);

        try {
            window.localStorage.setItem(PDF_THEME_STORAGE_KEY, nextTheme);
        } catch {
            // localStorage が利用できない環境でも、現在の選択はそのまま反映する。
        }
    };

    const handlePdfFontChange = (
        event: React.ChangeEvent<HTMLSelectElement>,
    ): void => {
        const nextFont = normalizePdfFontId(event.target.value);
        setPdfFont(nextFont);

        try {
            window.localStorage.setItem(PDF_FONT_STORAGE_KEY, nextFont);
        } catch {
            // localStorage が利用できない環境でも、現在の選択はそのまま反映する。
        }
    };

    const discardDraft = (): void => {
        const activeDocument = currentDocumentRef.current;
        const nextBaseline: DraftBaseline = {
            documentId: activeDocument?.id ?? null,
            title: activeDocument?.title ?? '',
            text: activeDocument?.text ?? '',
        };

        baselineRef.current = nextBaseline;
        // 破棄後のdraftはpropsの現行版の内容そのもの。期待値も同じ版へ揃えないと
        // 以後の保存が常に偽競合し、文書を切り替えるまで保存不能になる。
        draftBaselineUpdatedAtRef.current = activeDocument?.updatedAt ?? null;
        // 破棄はdraftの根拠を選び直す操作。破棄前の「最新読込」予約は無効にする
        // (残すと破棄後の新draftが古い同意で後着版を採り得る)。
        adoptionReservedVersionRef.current = null;
        lastSavedDraftRef.current = null;
        discardReturnFocusRef.current = null;
        setEditedTitle(nextBaseline.title);
        setEditedContent(nextBaseline.text);
        setIsViewMode(true);
        setSaveError(null);
        setShowDiscardConfirmation(false);
        onDirtyChange?.(false);
        onDraftDiscarded?.();
    };

    const requestDiscard = (): void => {
        if (hasChanges) {
            const activeElement = window.document?.activeElement;
            discardReturnFocusRef.current = typeof HTMLElement !== 'undefined' && activeElement instanceof HTMLElement
                ? activeElement
                : null;
            setShowDiscardConfirmation(true);
            return;
        }

        discardDraft();
    };

    const closeDiscardConfirmation = (): void => {
        const returnFocusElement = discardReturnFocusRef.current;
        discardReturnFocusRef.current = null;
        setShowDiscardConfirmation(false);
        window.requestAnimationFrame(() => returnFocusElement?.focus());
    };

    const confirmDiscard = (): void => {
        discardDraft();
        window.requestAnimationFrame(() => rootRef.current?.focus({ preventScroll: true }));
    };

    const handleReloadLatestDocument = (): void => {
        // draftは保持したまま親へ一覧の再取得を頼み、表示モードで最新の本文を確認
        // できるようにする（編集タブへ戻ればdraftはそのまま残っている）。
        onRequestLatestDocument?.();
        // 利用者が「最新を読み込んで確認する」と明示した時点で見えている版を採用し、
        // 同じ版の再取得だけを後着採用として予約する。draftはそのまま=手動マージ
        // して保存し直せる。
        const consentedUpdatedAt = document?.updatedAt ?? null;
        draftBaselineUpdatedAtRef.current = consentedUpdatedAt;
        adoptionReservedVersionRef.current = { updatedAt: consentedUpdatedAt };
        setIsViewMode(true);
        setSaveError(null);
    };

    const handleSave = async (): Promise<boolean> => {
        if (!onDocumentUpdate || savingRef.current) {
            return false;
        }

        const documentId = selectedDocumentIdRef.current;
        const savedTitle = currentTitleRef.current;
        const savedContent = currentContentRef.current;

        if (!documentId) {
            setSaveError({
                message: '文書を確認できないため保存できませんでした。',
                canReloadLatest: false,
            });
            return false;
        }

        if (!savedTitle.trim() || !savedContent.trim()) {
            setSaveError({
                message: 'タイトルと本文を入力してください。',
                canReloadLatest: false,
            });
            return false;
        }

        if (!hasChanges) {
            setSaveError(null);
            setIsViewMode(true);
            return true;
        }

        try {
            savingRef.current = true;
            setSaving(true);
            setSaveError(null);
            await onDocumentUpdate(documentId, {
                title: savedTitle,
                text: savedContent,
            }, {
                expectedUpdatedAt: draftBaselineUpdatedAtRef.current,
            });

            if (selectedDocumentIdRef.current === documentId) {
                const savedBaseline: DraftBaseline = {
                    documentId,
                    title: savedTitle,
                    text: savedContent,
                };
                baselineRef.current = savedBaseline;
                lastSavedDraftRef.current = savedBaseline;
                setEditedTitle(savedTitle);
                setEditedContent(savedContent);
                setIsViewMode(true);
                setShowDiscardConfirmation(false);
                onDirtyChange?.(false);
            }

            return true;
        } catch (error) {
            documentDetailLogger.error('文書の保存に失敗', error, { documentId });
            if (selectedDocumentIdRef.current === documentId) {
                // 上限超過は本文を削れば保存できるため、原因を伏せずそのまま伝える。
                // 競合は「保存に失敗」と区別し、最新を読み込んで確認できる導線を添える。
                setSaveError(error instanceof TranscriptionConflictError
                    ? { message: error.message, canReloadLatest: true }
                    : error instanceof DocumentSizeLimitError
                        ? {
                            message: `${error.message} 本文を短くしてから保存してください。`,
                            canReloadLatest: false,
                        }
                        : {
                            message: '保存に失敗しました。編集内容は保持されています。',
                            canReloadLatest: false,
                        });
            }
            return false;
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    };

    useImperativeHandle(ref, () => ({
        save: handleSave,
        discard: discardDraft,
        getDraft: () => ({
            title: currentTitleRef.current,
            text: currentContentRef.current,
        }),
        focus: () => {
            rootRef.current?.focus({ preventScroll: true });
        },
    }));

    if (!document) {
        return (
            <div
                ref={rootRef}
                tabIndex={-1}
                className="bg-white rounded-xl shadow-lg p-10 h-full flex flex-col items-center justify-center text-center text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
            >
                <FileTextIcon className="w-12 h-12 mb-4 text-purple-300" />
                <p className="text-sm font-medium">文書が選択されていません</p>
                <p className="text-xs mt-2 text-muted">一覧から表示したい文書を選択してください</p>
            </div>
        );
    }

    const resolvedPdfFont = resolvePdfFontId(pdfFont, pdfTheme);
    const autoFontLabel =
        PDF_FONTS.find(font => font.id === resolvePdfFontId('auto', pdfTheme))
            ?.label.split('（')[0] ?? '';
    const canPrintPdf = isViewMode && !saving && !isPreparing;
    const pdfButtonTitle = saving
        ? '保存完了後に印刷できます'
        : !isViewMode
            ? '保存後に印刷できます'
            : undefined;

    const handlePrintPdf = (): void => {
        if (!canPrintPdf) {
            return;
        }

        void printPdf();
    };

    const formatDate = (timestamp: Date | { toDate: () => Date } | undefined): string => {
        if (!timestamp) return '';
        const date = 'toDate' in timestamp ? timestamp.toDate() : timestamp;
        return new Intl.DateTimeFormat('ja-JP', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        }).format(date);
    };


    return (
        <div
            ref={rootRef}
            tabIndex={-1}
            aria-label={`${document.title}の詳細`}
            className="relative bg-white rounded-xl shadow-lg h-full flex flex-col overflow-hidden border border-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
        >
            <div className="p-4 sm:p-6 bg-gradient-to-r from-purple-50 to-pink-50 border-b border-purple-100">
                {onBackToList && (
                    <button
                        type="button"
                        onClick={onBackToList}
                        className="lg:hidden min-h-11 -ml-2 mb-2 px-2 rounded-lg inline-flex items-center gap-2 text-sm font-medium text-purple-700 hover:bg-white/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                    >
                        <ArrowLeft className="w-4 h-4" />
                        <span>一覧へ戻る</span>
                    </button>
                )}
                <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                    {/* lg:min-w-[18rem] は必須。右の操作群は basis:auto=max-content(印刷/表示/編集＋
                        文書情報＋デザイン/フォント)で横一列を食い尽くすため、この左ブロックが
                        flex:1 1 0% のままだと残り幅が数pxに潰れ、メタ情報がCJK1文字幅で縦積みに
                        崩れる(実測: 幅0px/14行)。lg で最低幅の床を与え、操作群側を折り返させる。 */}
                    <div className="flex-1 min-w-0 lg:min-w-[18rem]">
                        {isEditable && !isViewMode ? (
                            <input
                                type="text"
                                value={editedTitle}
                                onChange={(e) => setEditedTitle(e.target.value)}
                                className="w-full px-3 py-2 border border-purple-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-900"
                                placeholder="タイトルを入力"
                                autoFocus
                                disabled={saving}
                            />
                        ) : (
                            <h2 className="text-2xl font-bold text-gray-900 truncate">
                                {document.title}
                            </h2>
                        )}
                        <div className="mt-3 text-xs text-gray-600 space-y-1">
                            <p>ファイル: {document.fileName}</p>
                            <p>プロンプト: <span className="text-purple-700 font-semibold">{document.promptName}</span></p>
                            <p>生成日時: {formatDate(document.createdAt)}</p>
                            {document.generatedByModel && (
                                <p>
                                    使用モデル: {getGeminiModelLabel(document.generatedByModel)}
                                    {document.modelSelection === 'default' && '（おまかせ）'}
                                    {document.generatedByThinkingLevel &&
                                        `・思考: ${getThinkingLevelLabel(document.generatedByThinkingLevel)}`}
                                </p>
                            )}
                        </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 min-w-0">
                        <div className="flex w-full flex-wrap items-center justify-end gap-2 rounded-lg bg-white/80 p-1 shadow-sm sm:w-auto">
                            <button
                                type="button"
                                onClick={handlePrintPdf}
                                disabled={!canPrintPdf}
                                title={pdfButtonTitle}
                                className="px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center space-x-2 text-purple-700 hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <Printer className="w-4 h-4" />
                                <span>{isPreparing ? '印刷を準備中…' : '印刷してPDF保存'}</span>
                            </button>
                            {isEditable && (
                                <>
                                    <button
                                        type="button"
                                        onClick={requestDiscard}
                                        className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center space-x-2 ${isViewMode
                                            ? 'bg-purple-100 text-purple-700'
                                            : 'text-gray-600 hover:text-gray-900'
                                            }`}
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
                                        className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center space-x-2 ${!isViewMode
                                            ? 'bg-purple-100 text-purple-700'
                                            : 'text-gray-600 hover:text-gray-900'
                                            }`}
                                        disabled={saving}
                                    >
                                        <FileText className="w-4 h-4" />
                                        <span>編集</span>
                                    </button>
                                </>
                            )}
                        </div>
                        {isViewMode && (
                            <>
                                <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-gray-500">
                                    <label className="flex items-center gap-1.5 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={includeMetadata}
                                            onChange={handleIncludeMetadataChange}
                                            disabled={isPreparing}
                                            className="h-3.5 w-3.5 rounded border-gray-300 text-purple-600 focus:ring-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
                                        />
                                        <span>文書情報を含める（元ファイル・プロンプト・生成日時・使用モデル・思考）</span>
                                    </label>
                                    <label className="flex items-center gap-1.5">
                                        <span>デザイン</span>
                                        <select
                                            aria-label="PDF デザイン"
                                            value={pdfTheme}
                                            onChange={handlePdfThemeChange}
                                            disabled={isPreparing}
                                            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 shadow-sm focus:border-purple-400 focus:outline-none focus:ring-1 focus:ring-purple-400 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {PDF_THEMES.map(theme => (
                                                <option
                                                    key={theme.id}
                                                    value={theme.id}
                                                    title={theme.description}
                                                >
                                                    {theme.label}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label className="flex items-center gap-1.5">
                                        <span>フォント</span>
                                        <select
                                            aria-label="PDF フォント"
                                            value={pdfFont}
                                            onChange={handlePdfFontChange}
                                            disabled={isPreparing}
                                            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 shadow-sm focus:border-purple-400 focus:outline-none focus:ring-1 focus:ring-purple-400 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {PDF_FONTS.map(font => (
                                                <option
                                                    key={font.id}
                                                    value={font.id}
                                                    title={font.description}
                                                >
                                                    {font.id === 'auto'
                                                        ? `テーマおまかせ（${autoFontLabel}）`
                                                        : font.label}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                </div>
                                <p className="text-xs text-gray-400 text-right">
                                    ※改ページ位置はPDF出力時のみ反映されます
                                </p>
                            </>
                        )}
                        <p className="text-xs text-gray-500 text-right">
                            印刷設定は A4・倍率100%を推奨。「ヘッダーとフッター」はオフにしてください
                        </p>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 sm:p-6 bg-gray-50">
                {isViewMode ? (
                    <div
                        className={`pdf-preview pdf-preview--reading pdf-theme-${pdfTheme} pdf-font-${resolvedPdfFont} shadow`}
                    >
                        <article className="pdf-document">
                            {includeMetadata && (
                                <PdfDocumentHeader document={document} />
                            )}
                            <TranscriptAwareMarkdown
                                className="pdf-markdown"
                                markdown={document.text}
                                onRenameSpeaker={(from, to) => {
                                    setEditedContent(current => renameSpeakerLabel(current, from, to));
                                }}
                            />
                        </article>
                    </div>
                ) : (
                    <div className="h-full">
                        <textarea
                            value={editedContent}
                            onChange={(e) => setEditedContent(e.target.value)}
                            className="w-full h-full min-h-0 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-sm resize-none"
                            placeholder="コンテンツを入力"
                            disabled={saving}
                        />
                    </div>
                )}
            </div>

            {/* 文書に従属する細い帯。時刻リンクを持たない文書では、この要素ごと null になる */}
            <TranscriptAudioBar document={document} />

            {isEditable && !isViewMode && (
                <div className="flex items-center justify-end space-x-3 p-4 border-t bg-white">
                    <button
                        type="button"
                        onClick={requestDiscard}
                        disabled={saving}
                        className="px-6 py-2 bg-gray-400 text-white rounded-lg hover:bg-gray-500 transition-colors text-sm font-medium disabled:opacity-50"
                    >
                        キャンセル
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            void handleSave();
                        }}
                        disabled={saving}
                        className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium flex items-center space-x-2 disabled:opacity-50"
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
            )}
            {saveError && (
                <div
                    role="alert"
                    className="mx-4 mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
                >
                    <span>{saveError.message}</span>
                    {saveError.canReloadLatest && onRequestLatestDocument && (
                        <button
                            type="button"
                            onClick={handleReloadLatestDocument}
                            className="min-h-11 shrink-0 rounded-lg border border-red-300 bg-white px-3 text-sm font-medium text-red-700 hover:bg-red-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                        >
                            最新の内容を読み込む
                        </button>
                    )}
                </div>
            )}
            {showDiscardConfirmation && (
                <div
                    ref={discardDialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="discard-document-title"
                    aria-describedby="discard-document-description"
                    className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/40 p-4"
                >
                    <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
                        <h3
                            id="discard-document-title"
                            className="text-base font-semibold text-gray-900"
                        >
                            変更を破棄しますか？
                        </h3>
                        <p id="discard-document-description" className="mt-2 text-sm text-gray-600">
                            保存されていないタイトルと本文の変更は元に戻せません。
                        </p>
                        <div className="mt-5 flex justify-end gap-3">
                            <button
                                ref={discardCancelButtonRef}
                                type="button"
                                onClick={closeDiscardConfirmation}
                                className="min-h-11 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                            >
                                編集を続ける
                            </button>
                            <button
                                type="button"
                                onClick={confirmDiscard}
                                className="min-h-11 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                            >
                                変更を破棄する
                            </button>
                        </div>
                    </div>
                </div>
            )}
            <DocumentPrintPortal
                document={document}
                active={isPreparing}
                includeMetadata={includeMetadata}
                theme={pdfTheme}
                font={pdfFont}
            />
        </div>
    );
}

export const DocumentDetailPanel = React.forwardRef(DocumentDetailPanelView);

DocumentDetailPanel.displayName = 'DocumentDetailPanel';
