'use client';

import React, {
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import {
    AlertCircle,
    ArrowLeft,
    Check,
    CheckCircle2,
    Eye,
    FileText,
    FileTextIcon,
    Loader2,
    Printer,
    RefreshCw,
} from 'lucide-react';
import type { Timestamp } from 'firebase/firestore';
import {
    DocumentSizeLimitError,
    isSameUpdatedAt,
    Transcription,
    TranscriptionConflictError,
} from '@/lib/firestore';
import type { TranscribeProgressStage } from '@/lib/transcribeBatchContract';
import {
    describeElapsed,
    describeProgressStage,
    estimateServerNowMs,
    formatClockTime,
    resolveProgressObservation,
    type DocumentStatusWatchSnapshot,
    type ProgressObservation,
} from '@/hooks/batchTranscriptionClient';
import { createLogger } from '@/lib/logger';
import { MarkdownDocument } from '@/components/MarkdownDocument';
import { TranscriptAudioBar, TranscriptAwareMarkdown } from '@/components/TranscriptDocumentView';
import { renameSpeakerLabel } from '@/components/transcriptMarkdownComponents';
import { TranscriptReviewPanel } from '@/components/TranscriptReviewPanel';
import { shouldShowTranscriptReviewPanel } from '@/lib/transcriptDocument';
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
    /**
     * 選択中の processing 文書の継続確認スナップショット（親が保持・仕様 §A2 手順3）。
     * processing 以外の文書では無視する。無ければ保存された投影だけで状態カードを描く。
     */
    processingWatch?: DocumentStatusWatchSnapshot | null;
    /** 状態カードの「状態を確認」。実行中の重複送信は継続確認側が抑える。 */
    onCheckProcessingStatus?: () => void;
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
    processingWatch = null,
    onCheckProcessingStatus,
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
    // 処理中の文書は本文がまだ無い（静的な仮本文だけ）。完成本文に対する操作は無効にする（仕様 §A4）。
    // タイトルの変更は一覧側の既存操作で引き続きできる。
    const isProcessingDocument = document.status === 'processing';
    const canPrintPdf = isViewMode && !saving && !isPreparing && !isProcessingDocument;
    const pdfButtonTitle = isProcessingDocument
        ? '文字起こしが完了すると印刷できます'
        : saving
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

    // 要確認箇所（仕様 B3）。完成した文字起こし文書だけに置く（時刻リンクの無い通常の議事録には出ない）。
    // 🔴 パネルは独立コンポーネント（フックはそちらで走る）。ここでは要素を 1 つ置くだけ。
    //    本文編集中（表示モードでない）は本文アンカーを無効化し、確定した本文（document.text）で照合する。
    const reviewPanel = !isProcessingDocument && shouldShowTranscriptReviewPanel(document) ? (
        <TranscriptReviewPanel
            key={document.id ?? 'document'}
            documentId={document.id ?? 'document'}
            review={document.transcriptReview}
            bodyText={document.text}
            bodyState={isViewMode ? 'view' : 'editing'}
            canEdit={isEditable && !saving}
            onEditBody={isEditable
                ? () => {
                    setSaveError(null);
                    setIsViewMode(false);
                }
                : undefined}
            className={isViewMode ? 'mb-3' : 'max-h-[40%] shrink-0 overflow-y-auto'}
        />
    ) : null;

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
                                        className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center space-x-2 disabled:cursor-not-allowed disabled:opacity-50 ${!isViewMode
                                            ? 'bg-purple-100 text-purple-700'
                                            : 'text-gray-600 hover:text-gray-900'
                                            }`}
                                        disabled={saving || isProcessingDocument}
                                        title={isProcessingDocument
                                            ? '文字起こしが完了すると本文を編集できます（タイトルは一覧から変更できます）'
                                            : undefined}
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
                {isViewMode && isProcessingDocument ? (
                    // 🔴 processing の仮本文は文字起こし結果ではない。静的プレースホルダの代わりに状態カードを出す（仕様 §A4）
                    <ProcessingStateCard
                        document={document}
                        watch={processingWatch}
                        onCheck={onCheckProcessingStatus}
                    />
                ) : isViewMode ? (
                    <>
                        {/* 要確認箇所は PDF 本文領域（pdf-preview）の外。印刷・コピー・Markdown 保存に操作 UI や信頼度の色を混ぜない */}
                        {reviewPanel}
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
                                    documentId={document.id}
                                    review={document.transcriptReview}
                                    onRenameSpeaker={(from, to) => {
                                        setEditedContent(current => renameSpeakerLabel(current, from, to));
                                    }}
                                />
                            </article>
                        </div>
                    </>
                ) : reviewPanel ? (
                    // 編集中も候補の生成時抜粋を参照できるように残す（本文アンカーはパネル側で無効化される）
                    <div className="flex h-full flex-col gap-3">
                        {reviewPanel}
                        <div className="min-h-0 flex-1">
                            <textarea
                                value={editedContent}
                                onChange={(e) => setEditedContent(e.target.value)}
                                className="w-full h-full min-h-0 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-sm resize-none"
                                placeholder="コンテンツを入力"
                                disabled={saving}
                            />
                        </div>
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

            {/* 文書に従属する細い帯。時刻リンクを持たない文書では、この要素ごと null になる。
                処理中の仮本文は文字起こし結果として解釈しないので、帯も出さない */}
            {!isProcessingDocument && <TranscriptAudioBar document={document} />}

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

// ---------------------------------------------------------------------------------------------
// 処理中文書の状態カード（仕様 §A1・A4）。
// 🔴 パネル本体と別コンポーネントに切り出しているのは意図的（TranscriptDocumentView と同じ理由）。
//    パネルのテストはコンポーネントを素の関数として呼び、useState/useEffect/useRef/useImperativeHandle
//    だけをモックする。ここに切り出せば、パネル側は「要素を 1 つ置く」だけになり、
//    カードのフック（経過時間の 30 秒更新）は実描画のときにしか走らない。
// ---------------------------------------------------------------------------------------------

/** 経過時間の再計算間隔。時刻表示のために API を叩かず、30 秒より細かく更新しない（仕様 §A1） */
export const PROCESSING_ELAPSED_REFRESH_MS = 30_000;

/** 「開始待ち → 文字起こし → 取り込み → 完了」。等間隔は所要時間の比率を意味しない（仕様 §A4） */
const PROGRESS_STEPS: readonly { stage: TranscribeProgressStage; label: string }[] = [
    { stage: 'queued', label: '開始待ち' },
    { stage: 'transcribing', label: '文字起こし' },
    { stage: 'importing', label: '取り込み' },
    { stage: 'completed', label: '完了' },
];

const timestampToMillis = (timestamp: Timestamp | Date | undefined): number | undefined => {
    if (!timestamp) return undefined;
    if (timestamp instanceof Date) return timestamp.getTime();
    return typeof timestamp.toMillis === 'function' ? timestamp.toMillis() : undefined;
};

/**
 * 「状態の鮮度」の文言（仕様 §A1）。通信失敗・オフライン・確認停止は処理段階でもジョブ失敗でもない。
 * 最後の有効観測を残して「最終確認時は〜」を併記し、過去の観測が無いときだけ「状態を確認できません」。
 */
export function describeProcessingFreshness(
    watch: DocumentStatusWatchSnapshot | null,
    observation: ProgressObservation | null,
): string {
    const lastSeen = observation
        ? `最終確認時は「${describeProgressStage(observation.stage, 'detail')}」でした。`
        : '';
    if (!watch) {
        return observation
            ? `保存された記録です。${lastSeen}「状態を確認」で最新の状態を取得できます。`
            : '状態を確認できません。「状態を確認」をお試しください。';
    }
    switch (watch.mode) {
        case 'checking':
            return '状態を確認しています…';
        case 'waiting':
            return watch.lastError
                ? `現在の状態を確認できません（${watch.lastError.message}）。${lastSeen}自動で再試行します。`
                : '表示中は自動で状態を確認しています。';
        case 'paused_hidden':
            return `画面が非表示のため自動確認を止めています。${lastSeen}表示に戻ると確認を再開します。`;
        case 'paused_offline':
            return `オフラインのため自動確認を止めています。${lastSeen}回線が戻ると確認を再開します。`;
        case 'stopped_limit':
            return `自動確認を停止しました。文字起こしはサーバーで継続します。${lastSeen}「状態を確認」で確認を再開できます。`;
        case 'stopped_auth':
            return `権限または認証を確認してください。状態を確認できませんでした。${lastSeen}`;
        case 'stopped_not_found':
            return '文書またはジョブを確認できません。自動確認を停止しました（再提出は行いません）。';
        case 'terminal':
            return '結果を受け取りました。最新の文書を読み込んでいます…';
        case 'disposed':
            return lastSeen || '状態を確認できません。';
        default:
            return lastSeen || '状態を確認できません。';
    }
}

export interface ProcessingStateCardProps {
    document: Transcription;
    watch: DocumentStatusWatchSnapshot | null;
    onCheck?: () => void;
}

export function ProcessingStateCard({ document, watch, onCheck }: ProcessingStateCardProps): React.ReactElement {
    // 経過時間はローカルで足す。30 秒ごとの刻みと、応答の受信時刻のうち新しい方を「今」とし、
    // それ以外の理由で描き直さない（時刻表示のために API を叩かない・仕様 §A1）
    const [tickMs, setTickMs] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setTickMs(Date.now()), PROCESSING_ELAPSED_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, []);
    const lastResponseAtMs = watch?.lastResponseAtMs ?? null;
    const nowMs = Math.max(tickMs, lastResponseAtMs ?? 0);

    const observation = resolveProgressObservation(document.processingProgress, watch?.lastResponse);
    const stage = observation?.stage;
    const stageLabel = stage ? describeProgressStage(stage, 'detail') : '処理中・状態を確認しています';
    const jobCreatedAtMs = observation?.jobCreatedAtMs
        ?? document.processingProgress?.jobCreatedAtMs
        ?? timestampToMillis(document.createdAt);
    const serverNowMs = estimateServerNowMs(watch?.lastResponse, lastResponseAtMs, nowMs);
    const elapsedLabel = jobCreatedAtMs !== undefined ? describeElapsed(serverNowMs - jobCreatedAtMs) : null;
    const observedAtLabel = observation?.observedAtMs !== undefined ? formatClockTime(observation.observedAtMs) : null;
    const lastCheckedLabel = lastResponseAtMs !== null ? formatClockTime(lastResponseAtMs) : null;
    const isChecking = watch?.mode === 'checking';
    const isFailed = stage === 'failed';
    const isCompleted = stage === 'completed';
    const currentStepIndex = stage ? PROGRESS_STEPS.findIndex(step => step.stage === stage) : -1;
    const StageIcon = isFailed ? AlertCircle : isCompleted ? CheckCircle2 : Loader2;

    return (
        <section
            aria-label="文字起こしの状態"
            data-testid="processing-state-card"
            className="rounded-xl border border-purple-100 bg-white p-5 shadow-sm"
        >
            <h3 className="text-sm font-semibold text-gray-700">文字起こしの状態</h3>
            <p className={`mt-2 flex items-center gap-2 text-lg font-semibold ${isFailed ? 'text-red-800' : 'text-purple-900'}`}>
                {/* スピナーは装飾。段階はテキストで伝え、動きを減らす設定では静止アイコンにする */}
                <StageIcon
                    className={`h-5 w-5 shrink-0 ${isFailed
                        ? 'text-red-600'
                        : isCompleted
                            ? 'text-green-600'
                            : 'text-purple-600 motion-safe:animate-spin'}`}
                    aria-hidden="true"
                />
                {/* 段階変化だけを 1 つの live 領域で通知する。経過・時刻の更新は読み上げない */}
                <span role="status" aria-live="polite">{stageLabel}</span>
            </p>
            {!isFailed && (
                <ol
                    aria-label="文字起こしの段階（順序のみ。所要時間の比率ではありません）"
                    className="mt-3 flex flex-wrap gap-2 text-xs"
                >
                    {PROGRESS_STEPS.map((step, index) => {
                        const state = index < currentStepIndex ? 'done' : index === currentStepIndex ? 'current' : 'todo';
                        return (
                            <li
                                key={step.stage}
                                aria-current={state === 'current' ? 'step' : undefined}
                                className={`rounded-full border px-2 py-0.5 ${state === 'current'
                                    ? 'border-purple-400 bg-purple-50 font-semibold text-purple-900'
                                    : state === 'done'
                                        ? 'border-green-200 bg-green-50 text-green-800'
                                        : 'border-gray-200 bg-white text-gray-500'}`}
                            >
                                {state === 'done' ? '済 ' : state === 'current' ? '現在: ' : ''}{step.label}
                            </li>
                        );
                    })}
                </ol>
            )}
            {isFailed && document.text && (
                <p className="mt-3 whitespace-pre-line text-sm text-red-800">{document.text}</p>
            )}
            <dl className="mt-3 grid gap-2 text-xs text-gray-600 sm:grid-cols-3">
                <div>
                    <dt className="font-medium text-gray-500">受付からの経過</dt>
                    <dd className="text-gray-800">{elapsedLabel ?? '不明'}</dd>
                </div>
                <div>
                    <dt className="font-medium text-gray-500">状態の観測時刻</dt>
                    <dd className="text-gray-800">{observedAtLabel ?? '未観測'}</dd>
                </div>
                <div>
                    <dt className="font-medium text-gray-500">最終確認</dt>
                    <dd className="text-gray-800">{lastCheckedLabel ?? 'この画面ではまだ確認していません'}</dd>
                </div>
            </dl>
            <p className="mt-3 text-sm text-gray-700">{describeProcessingFreshness(watch, observation)}</p>
            {onCheck && !isCompleted && (
                <button
                    type="button"
                    onClick={onCheck}
                    disabled={isChecking}
                    aria-busy={isChecking || undefined}
                    className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg bg-purple-600 px-4 text-sm font-medium text-white transition-colors hover:bg-purple-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <RefreshCw className={`h-4 w-4 ${isChecking ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
                    {isChecking ? '確認しています…' : '状態を確認'}
                </button>
            )}
            <p className="mt-3 text-xs text-gray-500">
                この画面を離れても文字起こしは継続します。文書を開くと最新の状態を確認できます。
            </p>
        </section>
    );
}
