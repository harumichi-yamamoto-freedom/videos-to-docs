'use client';

import React, {
    useCallback,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    AlertCircle,
    Check,
    Clock,
    Download,
    Edit2,
    FileText,
    Hourglass,
    RefreshCw,
    Search,
    Trash2,
    XCircle,
} from 'lucide-react';
import {
    deleteTranscription,
    getTranscriptions,
    Transcription,
    TranscriptionConflictError,
    updateTranscription,
} from '@/lib/firestore';
import { useAuth } from '@/hooks/useAuth';
import { describeProgressStage } from '@/hooks/batchTranscriptionClient';
import { createLogger } from '@/lib/logger';

const documentListLogger = createLogger('DocumentListSidebar');

// 一覧の定期取り直し間隔。本文つき最大100件を毎回転送するため、5秒では
// 待機中のタブだけで読取量が膨らむ(#9)。表示中のタブでも30秒未満にしない。
export const DOCUMENT_LIST_POLL_INTERVAL_MS = 30_000;

export type DocumentListStatus = 'loading' | 'success' | 'error';

export interface DocumentListStateChange {
    status: DocumentListStatus;
    count?: number;
}

export interface DocumentListSidebarProps {
    onDocumentClick: (transcription: Transcription) => void;
    onDocumentUpdated?: (documentId: string, patch: Pick<Transcription, 'title'>) => void;
    onDocumentDeleted?: (documentId: string) => void;
    onDocumentsChange?: (documents: Transcription[]) => void;
    onListStateChange?: (state: DocumentListStateChange) => void;
    updateTrigger?: number;
    selectedDocumentId?: string | null;
    isSelectedDocumentDirty?: boolean;
}

interface DocumentCollectionState {
    subjectKey: string | null;
    status: DocumentListStatus;
    documents: Transcription[];
    refreshWarning?: string;
}

interface OperationMessage {
    type: 'success' | 'warning' | 'error';
    text: string;
}

interface ActiveOperation {
    type: 'delete' | 'rename';
    documentId: string;
}

const actionVisibilityClasses = [
    '[@media(hover:hover)_and_(pointer:fine)]:pointer-events-none',
    '[@media(hover:hover)_and_(pointer:fine)]:opacity-0',
    '[@media(hover:hover)_and_(pointer:fine)]:group-hover:pointer-events-auto',
    '[@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100',
    '[@media(hover:hover)_and_(pointer:fine)]:focus-within:pointer-events-auto',
    '[@media(hover:hover)_and_(pointer:fine)]:focus-within:opacity-100',
].join(' ');

type ComparableTimestamp = Date | {
    seconds?: number;
    nanoseconds?: number;
    toMillis?: () => number;
    toDate?: () => Date;
};

const getTimestampKey = (timestamp: ComparableTimestamp | undefined): string | null => {
    if (!timestamp) return null;
    if (timestamp instanceof Date) return `millis:${timestamp.getTime()}`;
    if (typeof timestamp.toMillis === 'function') return `millis:${timestamp.toMillis()}`;
    if (typeof timestamp.toDate === 'function') return `millis:${timestamp.toDate().getTime()}`;
    return `timestamp:${timestamp.seconds ?? ''}:${timestamp.nanoseconds ?? ''}`;
};

const hashText = (value: string): string => {
    // 定期取り直しで長い本文を比較するため、本文そのものではなく安定した指紋を使う。
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${value.length}:${(hash >>> 0).toString(16)}`;
};

const getLegacyContentKey = (transcription: Transcription): string => JSON.stringify([
    transcription.title,
    transcription.fileName,
    transcription.promptName,
    hashText(transcription.text),
    transcription.originalFileType ?? null,
    transcription.generatedByModel ?? null,
    transcription.generatedByThinkingLevel ?? null,
    transcription.modelSelection ?? null,
    transcription.ownerType ?? null,
    transcription.ownerId ?? null,
    transcription.createdBy ?? null,
    getTimestampKey(transcription.createdAt as ComparableTimestamp | undefined),
]);

// 進捗投影（processingProgress）と status は、本文・updatedAt・並び順を変えずに更新される（仕様 §A3）。
// 版印（updatedAt）だけで同一視すると「開始待ち→取り込み中」の前進が画面に出ないので、同一版判定に加える。
const getProcessingStateKey = (transcription: Transcription): string => JSON.stringify([
    transcription.status ?? null,
    transcription.processingProgress?.stage ?? null,
    transcription.processingProgress?.stageObservedAtMs ?? null,
    transcription.processingProgress?.jobCreatedAtMs ?? null,
    transcription.processingProgress?.audioSec ?? null,
]);

export const hasSameDocumentVersion = (
    currentDocument: Transcription,
    nextDocument: Transcription,
): boolean => {
    if (getProcessingStateKey(currentDocument) !== getProcessingStateKey(nextDocument)) return false;

    const currentUpdatedAtKey = getTimestampKey(
        currentDocument.updatedAt as ComparableTimestamp | undefined,
    );
    const nextUpdatedAtKey = getTimestampKey(
        nextDocument.updatedAt as ComparableTimestamp | undefined,
    );

    if (currentUpdatedAtKey !== null || nextUpdatedAtKey !== null) {
        return currentUpdatedAtKey !== null && currentUpdatedAtKey === nextUpdatedAtKey;
    }

    return getLegacyContentKey(currentDocument) === getLegacyContentKey(nextDocument)
        // ハッシュ衝突で変更を見逃さないよう、指紋一致時は本文も厳密比較する。
        && currentDocument.text === nextDocument.text;
};

/**
 * 一覧行の段階バッジ文言（仕様 §A1・A4）。一覧は保存された投影しか持たないので、
 * 「最終確認時」の情報だと分かる表現にし、投影の無い旧 processing 文書は「処理中・詳細を確認」。
 * 一覧の全行を継続 status 照会する構成にはしない（詳細を開いた文書だけが継続確認される）。
 */
export const describeProcessingBadge = (
    transcription: Pick<Transcription, 'status' | 'processingProgress'>,
    formatObservedAt: (ms: number) => string,
): string | null => {
    if (transcription.status === 'failed') return '文字起こしに失敗しました';
    if (transcription.status !== 'processing') return null;
    const progress = transcription.processingProgress;
    if (!progress) return '処理中・詳細を確認';
    const label = describeProgressStage(progress.stage);
    return progress.stageObservedAtMs !== undefined
        ? `最終確認時: ${label}（${formatObservedAt(progress.stageObservedAtMs)}）`
        : `最終確認時: ${label}`;
};

const preserveUnchangedDocumentReferences = (
    currentDocuments: Transcription[],
    nextDocuments: Transcription[],
): Transcription[] => {
    const currentById = new Map(
        currentDocuments
            .filter((document): document is Transcription & { id: string } => Boolean(document.id))
            .map(document => [document.id, document]),
    );

    return nextDocuments.map(document => {
        if (!document.id) return document;
        const currentDocument = currentById.get(document.id);
        return currentDocument
            && hasSameDocumentVersion(currentDocument, document)
            ? currentDocument
            : document;
    });
};

export const DocumentListSidebar: React.FC<DocumentListSidebarProps> = ({
    onDocumentClick,
    onDocumentUpdated,
    onDocumentDeleted,
    onDocumentsChange,
    onListStateChange,
    updateTrigger,
    selectedDocumentId,
    isSelectedDocumentDirty = false,
}) => {
    const { user, loading: authLoading } = useAuth();
    const ownerType = user ? 'user' : 'guest';
    const ownerId = user?.uid ?? 'GUEST';
    const subjectKey = authLoading ? null : JSON.stringify([ownerType, ownerId]);
    const searchInputId = useId();
    const [collectionState, setCollectionState] = useState<DocumentCollectionState>({
        subjectKey: null,
        status: 'loading',
        documents: [],
    });
    const [editingDocId, setEditingDocId] = useState<string | null>(null);
    const [editedTitle, setEditedTitle] = useState('');
    const [savingDocumentId, setSavingDocumentId] = useState<string | null>(null);
    const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
    const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(null);
    const [operationMessage, setOperationMessage] = useState<OperationMessage | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const subjectGenerationRef = useRef(0);
    const requestIdRef = useRef(0);
    const subjectKeyRef = useRef(subjectKey);
    const documentsRef = useRef<Transcription[]>([]);
    const activeOperationRef = useRef<ActiveOperation | null>(null);
    const activeFetchRequestRef = useRef<number | null>(null);
    const successfulSubjectKeyRef = useRef<string | null>(null);
    const documentButtonRefs = useRef(new Map<string, HTMLButtonElement>());
    const refreshButtonRef = useRef<HTMLButtonElement>(null);
    const deleteCancelButtonRef = useRef<HTMLButtonElement>(null);
    const editingInputRef = useRef<HTMLInputElement>(null);
    // 改名の競合検査の期待値。ポーリングで前進する行のライブな updatedAt からで
    // なく、編集を開始した時点の版で固定する（本文保存のpinと同じ規律）。
    const editingBaselineUpdatedAtRef = useRef<Transcription['updatedAt'] | null>(null);
    const editingDocIdRef = useRef<string | null>(null);
    // 編集セッション世代。取り直しの着弾が基準(editingBaseline)へ書けるのは
    // 「その取り直しを予約した編集セッションが今も続いている」時だけ。文書IDと
    // owner世代だけの検査では、S1が予約した取り直しがS2の再編集セッションへ
    // 別writer版の基準を書き込み、S2保存が無警告上書きになる(ABA)。
    const editingSessionRef = useRef(0);
    const callbacksRef = useRef({
        onDocumentUpdated,
        onDocumentDeleted,
        onDocumentsChange,
        onListStateChange,
    });

    subjectKeyRef.current = subjectKey;
    editingDocIdRef.current = editingDocId;
    callbacksRef.current = {
        onDocumentUpdated,
        onDocumentDeleted,
        onDocumentsChange,
        onListStateChange,
    };

    const invalidatePendingRequests = useCallback(() => {
        subjectGenerationRef.current += 1;
        requestIdRef.current += 1;
        activeFetchRequestRef.current = null;
    }, []);

    const visibleState: DocumentCollectionState = collectionState.subjectKey === subjectKey
        ? collectionState
        : {
            subjectKey,
            status: 'loading',
            documents: [],
        };
    const transcriptions = visibleState.documents;
    const loading = visibleState.status === 'loading';

    const loadTranscriptionsForSubject = useCallback(async (
        requestedSubjectKey: string,
        requestedOwnerId: string,
        requestedOwnerType: 'guest' | 'user',
        generation: number,
        showLoading: boolean,
    ) => {
        const requestId = ++requestIdRef.current;
        activeFetchRequestRef.current = requestId;
        const isCurrentRequest = () => (
            subjectGenerationRef.current === generation
            && requestIdRef.current === requestId
            && subjectKeyRef.current === requestedSubjectKey
        );

        if (showLoading && isCurrentRequest()) {
            setCollectionState(previous => ({
                subjectKey: requestedSubjectKey,
                status: 'loading',
                documents: previous.subjectKey === requestedSubjectKey ? previous.documents : [],
            }));
            callbacksRef.current.onListStateChange?.({ status: 'loading' });
        }

        try {
            const fetchedDocuments = await getTranscriptions(100, {
                ownerId: requestedOwnerId,
                ownerType: requestedOwnerType,
            });
            if (!isCurrentRequest()) return;

            const documents = preserveUnchangedDocumentReferences(
                documentsRef.current,
                fetchedDocuments,
            );
            documentsRef.current = documents;
            successfulSubjectKeyRef.current = requestedSubjectKey;
            setCollectionState({
                subjectKey: requestedSubjectKey,
                status: 'success',
                documents,
            });
            callbacksRef.current.onDocumentsChange?.(documents);
            callbacksRef.current.onListStateChange?.({
                status: 'success',
                count: documents.length,
            });
        } catch (error) {
            if (!isCurrentRequest()) return;

            documentListLogger.error('文書一覧の取得に失敗', error, {
                subjectKey: requestedSubjectKey,
            });
            const hasSuccessfulSnapshot = successfulSubjectKeyRef.current === requestedSubjectKey;
            if (showLoading || !hasSuccessfulSnapshot) {
                setCollectionState(previous => ({
                    subjectKey: requestedSubjectKey,
                    status: 'error',
                    documents: previous.subjectKey === requestedSubjectKey ? previous.documents : [],
                }));
                callbacksRef.current.onListStateChange?.({ status: 'error' });
                return;
            }

            // quiet更新が手動更新中のloadingを追い越して失敗しても、最後の成功結果へ戻す。
            // 一時的な表示状態ではなく成功スナップショットの有無で非遮断かを決める。
            setCollectionState({
                subjectKey: requestedSubjectKey,
                status: 'success',
                documents: documentsRef.current,
                refreshWarning: '最新の文書一覧を取得できませんでした。',
            });
            callbacksRef.current.onListStateChange?.({
                status: 'success',
                count: documentsRef.current.length,
            });
        } finally {
            if (activeFetchRequestRef.current === requestId) {
                activeFetchRequestRef.current = null;
            }
        }
    }, []);

    useLayoutEffect(() => {
        const generation = ++subjectGenerationRef.current;
        ++requestIdRef.current;
        documentsRef.current = [];
        activeOperationRef.current = null;
        activeFetchRequestRef.current = null;
        successfulSubjectKeyRef.current = null;
        setCollectionState({
            subjectKey,
            status: 'loading',
            documents: [],
        });
        setEditingDocId(null);
        setEditedTitle('');
        editingBaselineUpdatedAtRef.current = null;
        setSavingDocumentId(null);
        setPendingDeleteId(null);
        setDeletingDocumentId(null);
        setOperationMessage(null);
        callbacksRef.current.onDocumentsChange?.([]);
        callbacksRef.current.onListStateChange?.({ status: 'loading' });

        if (subjectKey === null) return;

        // 非表示タブでは一覧の読取(本文つき最大100件)を一切発生させない。初回取得も
        // 表示されるまで保留し、表示中だけ DOCUMENT_LIST_POLL_INTERVAL_MS ごとに静かに
        // 取り直す。非表示→表示の復帰時は即時に1回取り直してから周期を仕切り直す。
        let pollTimer: number | null = null;
        const stopPolling = () => {
            if (pollTimer === null) return;
            window.clearInterval(pollTimer);
            pollTimer = null;
        };
        const startPolling = () => {
            stopPolling();
            pollTimer = window.setInterval(() => {
                if (activeFetchRequestRef.current !== null) return;
                void loadTranscriptionsForSubject(subjectKey, ownerId, ownerType, generation, false);
            }, DOCUMENT_LIST_POLL_INTERVAL_MS);
        };
        const handleVisibilityChange = () => {
            if (document.hidden) {
                stopPolling();
                return;
            }
            if (activeFetchRequestRef.current === null) {
                void loadTranscriptionsForSubject(subjectKey, ownerId, ownerType, generation, false);
            }
            startPolling();
        };

        if (!document.hidden) {
            void loadTranscriptionsForSubject(subjectKey, ownerId, ownerType, generation, true);
            startPolling();
        }
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            stopPolling();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            invalidatePendingRequests();
        };
    }, [invalidatePendingRequests, loadTranscriptionsForSubject, ownerId, ownerType, subjectKey]);

    useLayoutEffect(() => {
        if (!updateTrigger || subjectKey === null) return;
        void loadTranscriptionsForSubject(
            subjectKey,
            ownerId,
            ownerType,
            subjectGenerationRef.current,
            false,
        );
    }, [loadTranscriptionsForSubject, ownerId, ownerType, subjectKey, updateTrigger]);

    const publishLocalDocuments = useCallback((
        documents: Transcription[],
        notifyDocumentsChange = true,
    ) => {
        const currentSubjectKey = subjectKeyRef.current;
        if (currentSubjectKey === null) return;

        ++requestIdRef.current;
        activeFetchRequestRef.current = null;
        documentsRef.current = documents;
        successfulSubjectKeyRef.current = currentSubjectKey;
        setCollectionState({
            subjectKey: currentSubjectKey,
            status: 'success',
            documents,
        });
        if (notifyDocumentsChange) {
            callbacksRef.current.onDocumentsChange?.(documents);
        }
        callbacksRef.current.onListStateChange?.({
            status: 'success',
            count: documents.length,
        });
    }, []);

    const refreshDocuments = () => {
        if (subjectKey === null) return;
        setOperationMessage(null);
        void loadTranscriptionsForSubject(
            subjectKey,
            ownerId,
            ownerType,
            subjectGenerationRef.current,
            true,
        );
    };

    const downloadDocument = (transcription: Transcription) => {
        const blob = new Blob([transcription.text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${transcription.title}_${transcription.promptName}.txt`;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
    };

    const restoreDocumentButtonFocus = useCallback((documentId: string) => {
        window.requestAnimationFrame(() => {
            const focusTarget = documentButtonRefs.current.get(documentId) ?? refreshButtonRef.current;
            focusTarget?.focus();
        });
    }, []);

    const requestDelete = (transcription: Transcription) => {
        if (!transcription.id || activeOperationRef.current) return;
        setEditingDocId(null);
        setPendingDeleteId(transcription.id);
        setOperationMessage(null);
    };

    const handleDelete = async (transcription: Transcription) => {
        if (!transcription.id) return;

        const documentId = transcription.id;
        const operationSubjectKey = subjectKeyRef.current;
        const operationGeneration = subjectGenerationRef.current;
        if (operationSubjectKey === null || activeOperationRef.current) return;
        const operation: ActiveOperation = { type: 'delete', documentId };
        activeOperationRef.current = operation;
        const isOperationCurrent = () => (
            subjectKeyRef.current === operationSubjectKey
            && subjectGenerationRef.current === operationGeneration
            && activeOperationRef.current === operation
        );
        let deletionFailed = false;

        try {
            setDeletingDocumentId(documentId);
            setOperationMessage(null);
            const result = await deleteTranscription(documentId);
            if (!isOperationCurrent()) return;

            const deletedDocumentIndex = documentsRef.current.findIndex(document => document.id === documentId);
            const documents = documentsRef.current.filter(document => document.id !== documentId);
            const nextFocusDocumentId = documents[Math.min(deletedDocumentIndex, documents.length - 1)]?.id;
            // 親への削除反映はonDocumentDeletedが担う。ここでonDocumentsChangeへ
            // ローカルsnapshotを流すと、サイドバーが持つ保存前本文+旧版印のstale
            // コピーがpageの確定済みentryを巻き戻し、版未確定警告も偽clearされる
            // (改名経路と同じ理由でnotifyしない)。
            publishLocalDocuments(documents, false);
            callbacksRef.current.onDocumentDeleted?.(documentId);
            setPendingDeleteId(null);
            setOperationMessage(result === 'deletedWithWarning'
                ? {
                    type: 'warning',
                    text: '文書は削除されましたが、履歴または統計の更新に失敗しました。',
                }
                : {
                    type: 'success',
                    text: '文書を削除しました。',
                });
            if (nextFocusDocumentId) {
                restoreDocumentButtonFocus(nextFocusDocumentId);
            } else {
                window.requestAnimationFrame(() => refreshButtonRef.current?.focus());
            }
        } catch (error) {
            documentListLogger.error('文書の削除に失敗', error, { documentId });
            if (!isOperationCurrent()) return;
            deletionFailed = true;
            setOperationMessage({
                type: 'error',
                text: '文書を削除できませんでした。時間をおいて再度お試しください。',
            });
        } finally {
            if (isOperationCurrent()) {
                activeOperationRef.current = null;
                setDeletingDocumentId(null);
                if (deletionFailed) {
                    window.requestAnimationFrame(() => deleteCancelButtonRef.current?.focus());
                }
            }
        }
    };

    const handleEditTitle = (transcription: Transcription) => {
        if (!transcription.id || activeOperationRef.current) return;
        setPendingDeleteId(null);
        setEditingDocId(transcription.id);
        editingDocIdRef.current = transcription.id;
        setEditedTitle(transcription.title);
        editingSessionRef.current += 1;
        editingBaselineUpdatedAtRef.current = transcription.updatedAt ?? null;
        setOperationMessage(null);

        // 版印を剥がした直後の行(updatedAt未確定)から編集を始めた場合、そのままだと
        // 初回保存が必ず偽競合する。このセッション自身の取り直しで基準を種付けする。
        if (transcription.updatedAt === undefined && subjectKeyRef.current !== null) {
            void reloadAndRefreshEditingBaseline(
                transcription.id,
                subjectKeyRef.current,
                subjectGenerationRef.current,
                editingSessionRef.current,
                transcription.title,
            );
        }
    };

    const filteredTranscriptions = useMemo(() => {
        if (!searchQuery.trim()) return transcriptions;

        const normalized = searchQuery.toLocaleLowerCase('ja-JP');
        return transcriptions.filter((transcription) => {
            const title = transcription.title?.toLocaleLowerCase('ja-JP') || '';
            const fileName = transcription.fileName?.toLocaleLowerCase('ja-JP') || '';
            const promptName = transcription.promptName?.toLocaleLowerCase('ja-JP') || '';
            return (
                title.includes(normalized)
                || fileName.includes(normalized)
                || promptName.includes(normalized)
            );
        });
    }, [searchQuery, transcriptions]);

    const handleSaveTitle = async (transcription: Transcription) => {
        if (!transcription.id) return;

        const nextTitle = editedTitle.trim();
        if (!nextTitle) {
            setOperationMessage({ type: 'error', text: 'タイトルを入力してください。' });
            return;
        }

        if (nextTitle === transcription.title) {
            setEditingDocId(null);
            setEditedTitle('');
            restoreDocumentButtonFocus(transcription.id);
            return;
        }

        const documentId = transcription.id;
        const operationSubjectKey = subjectKeyRef.current;
        const operationGeneration = subjectGenerationRef.current;
        if (operationSubjectKey === null || activeOperationRef.current) return;
        const operation: ActiveOperation = { type: 'rename', documentId };
        activeOperationRef.current = operation;
        const isOperationCurrent = () => (
            subjectKeyRef.current === operationSubjectKey
            && subjectGenerationRef.current === operationGeneration
            && activeOperationRef.current === operation
        );
        let renameFailed = false;

        try {
            setSavingDocumentId(documentId);
            setOperationMessage(null);
            await updateTranscription(documentId, { title: nextTitle }, {
                expectedUpdatedAt: editingBaselineUpdatedAtRef.current ?? null,
            });
            if (!isOperationCurrent()) return;

            const latestDocument = documentsRef.current.find(document => document.id === documentId);
            if (latestDocument) {
                // commit後にpollが他者版を格納済みだと、行の updatedAt を温存した
                // タイトルpatchは「古い改名+最新版印」の捏造になり、同版pollは参照を
                // 温存するため自然回復もしない。版印は剥がして未確定に落とす。
                const updatedDocument = {
                    ...latestDocument,
                    title: nextTitle,
                    updatedAt: undefined,
                };
                const documents = documentsRef.current.map(document => (
                    document.id === documentId ? updatedDocument : document
                ));
                publishLocalDocuments(documents, false);
            }
            // 一覧更新との競合でローカル一覧から消えていても、Firestoreの改名成功は親へ伝える。
            callbacksRef.current.onDocumentUpdated?.(documentId, { title: nextTitle });
            setEditingDocId(null);
            setEditedTitle('');
            setOperationMessage({ type: 'success', text: 'タイトルを更新しました。' });
            restoreDocumentButtonFocus(documentId);
            // 剥がした版印は実状態の取り直しで即座に埋め戻す。編集は閉じたので
            // 基準への書き込みは行わない(次の編集セッションが自分で種付けする)。
            void loadTranscriptionsForSubject(
                operationSubjectKey,
                ownerId,
                ownerType,
                operationGeneration,
                false,
            );
        } catch (error) {
            documentListLogger.error('文書タイトルの更新に失敗', error, { documentId });
            if (!isOperationCurrent()) return;
            renameFailed = true;
            if (error instanceof TranscriptionConflictError) {
                setOperationMessage({
                    type: 'error',
                    text: '他の場所で更新されています。最新の状態を取得しました。内容を確認してから、もう一度お試しください。',
                });
                // 取り直しの着弾で基準を最新版へ進め、再試行を成功可能にする。
                // 予約はこの(失敗した)編集セッションに紐づく。
                void reloadAndRefreshEditingBaseline(
                    documentId,
                    operationSubjectKey,
                    operationGeneration,
                    editingSessionRef.current,
                );
            } else {
                setOperationMessage({
                    type: 'error',
                    text: 'タイトルを更新できませんでした。入力内容は保持されています。',
                });
            }
        } finally {
            if (isOperationCurrent()) {
                activeOperationRef.current = null;
                setSavingDocumentId(null);
                if (renameFailed) {
                    window.requestAnimationFrame(() => editingInputRef.current?.focus());
                }
            }
        }
    };

    // 静かな取り直しの着弾で、それを予約した編集セッションの競合検査基準を
    // 最新版へ前進させる。競合後の再試行が案内どおり成功し、剥がした版印の行から
    // 始めた編集が偽競合しないための共通機構。
    //
    // expectedTitle は種付け経路(編集開始時の無言取得)だけが渡す:
    // 取得結果のタイトルが編集開始時に見ていた値と一致する時だけ基準に採り、
    // 不一致(=第三者の改名が挟まった)なら据え置いて保存を競合へ流す。
    // 見ていない版を無言で基準に採ると初回保存が競合検査素通りになる。
    // 競合経路が無条件なのは意図的な非対称: そちらは競合表示と「内容を確認して
    // から」の案内、着弾後の行表示の更新がセットで、同意の形成を伴うため。
    const reloadAndRefreshEditingBaseline = async (
        documentId: string,
        operationSubjectKey: string,
        operationGeneration: number,
        editingSession: number,
        expectedTitle?: string,
    ): Promise<void> => {
        await loadTranscriptionsForSubject(
            operationSubjectKey,
            ownerId,
            ownerType,
            operationGeneration,
            false,
        );
        if (subjectGenerationRef.current !== operationGeneration) return;
        if (editingSessionRef.current !== editingSession) return;
        if (editingDocIdRef.current !== documentId) return;

        const refreshedDocument = documentsRef.current
            .find(document => document.id === documentId);
        if (expectedTitle !== undefined && refreshedDocument?.title !== expectedTitle) {
            return;
        }
        editingBaselineUpdatedAtRef.current = refreshedDocument?.updatedAt ?? null;
    };

    const handleCancelEdit = (documentId: string) => {
        setEditingDocId(null);
        editingDocIdRef.current = null;
        // セッションを進め、閉じた編集が予約した取り直しの書き込みを無効化する。
        editingSessionRef.current += 1;
        setEditedTitle('');
        restoreDocumentButtonFocus(documentId);
    };

    const handleCancelDelete = (documentId: string) => {
        setPendingDeleteId(null);
        restoreDocumentButtonFocus(documentId);
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

    const operationMessageClasses = operationMessage?.type === 'error'
        ? 'border-red-200 bg-red-50 text-red-800'
        : operationMessage?.type === 'warning'
            ? 'border-amber-200 bg-amber-50 text-amber-900'
            : 'border-green-200 bg-green-50 text-green-800';

    return (
        <div className="h-full flex flex-col bg-gradient-to-br from-gray-50 to-gray-100">
            <div className="p-6 bg-white border-b border-purple-100">
                <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center space-x-2 min-w-0">
                        <FileText className="w-6 h-6 shrink-0 text-purple-600" />
                        <div className="min-w-0">
                            <h2 className="text-xl font-bold text-gray-900">
                                生成された文書
                            </h2>
                            {visibleState.status === 'success' ? (
                                <p className="text-xs text-gray-500 mt-1">
                                    全{transcriptions.length}件 / 表示{filteredTranscriptions.length}件
                                </p>
                            ) : visibleState.status === 'error' ? (
                                <p className="text-xs text-red-600 mt-1">件数を取得できませんでした</p>
                            ) : (
                                <div
                                    role="status"
                                    aria-label="文書件数を読み込み中"
                                    className="h-3 w-28 mt-2 rounded bg-gray-200 animate-pulse"
                                />
                            )}
                        </div>
                    </div>
                    <button
                        ref={refreshButtonRef}
                        type="button"
                        onClick={refreshDocuments}
                        disabled={loading || subjectKey === null}
                        className="min-w-11 min-h-11 inline-flex items-center justify-center hover:bg-purple-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                        aria-label="文書一覧を更新"
                        title="更新"
                    >
                        <RefreshCw className={`w-5 h-5 text-purple-600 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
                <label
                    htmlFor={searchInputId}
                    className="block text-xs font-medium text-gray-700 mb-1.5"
                >
                    文書を検索
                </label>
                <div className="flex items-center space-x-2">
                    <div className="relative flex-1">
                        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                            id={searchInputId}
                            type="search"
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder="キーワードを入力"
                            className="w-full min-h-11 pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                        />
                    </div>
                    {searchQuery && (
                        <button
                            type="button"
                            onClick={() => setSearchQuery('')}
                            className="min-h-11 px-2 text-xs text-purple-600 hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                        >
                            クリア
                        </button>
                    )}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {operationMessage && (
                    <div
                        role={operationMessage.type === 'error' ? 'alert' : 'status'}
                        className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm ${operationMessageClasses}`}
                    >
                        <span>{operationMessage.text}</span>
                        <button
                            type="button"
                            onClick={() => setOperationMessage(null)}
                            className="min-w-11 min-h-11 inline-flex items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
                            aria-label="メッセージを閉じる"
                        >
                            <XCircle className="w-4 h-4" />
                        </button>
                    </div>
                )}

                {visibleState.refreshWarning && (
                    <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                        {visibleState.refreshWarning}
                    </div>
                )}

                {visibleState.status === 'loading' ? (
                    <div aria-label="文書一覧を読み込み中" className="space-y-3">
                        {[0, 1, 2].map(index => (
                            <div key={index} className="h-32 rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
                                <div className="h-4 w-3/4 rounded bg-gray-200 animate-pulse" />
                                <div className="h-3 w-1/2 mt-4 rounded bg-gray-100 animate-pulse" />
                                <div className="h-3 w-2/3 mt-3 rounded bg-gray-100 animate-pulse" />
                            </div>
                        ))}
                    </div>
                ) : visibleState.status === 'error' ? (
                    <div role="alert" className="bg-white rounded-xl p-8 shadow-sm border border-red-100">
                        <div className="flex flex-col items-center justify-center text-center text-gray-600">
                            <FileText className="w-12 h-12 mb-3 text-red-300" />
                            <p className="text-sm font-medium text-gray-900">文書一覧を取得できませんでした</p>
                            <p className="text-xs mt-1">通信状況をご確認のうえ、再度お試しください。</p>
                            <button
                                type="button"
                                onClick={refreshDocuments}
                                className="min-h-11 mt-4 px-4 rounded-lg bg-purple-600 text-sm font-medium text-white hover:bg-purple-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
                            >
                                再読み込み
                            </button>
                        </div>
                    </div>
                ) : transcriptions.length === 0 ? (
                    <div className="bg-white rounded-xl p-8 shadow-sm">
                        <div className="flex flex-col items-center justify-center text-gray-400 text-center">
                            <FileText className="w-12 h-12 mb-2 opacity-50" />
                            <p className="text-sm">文書がまだありません</p>
                            <p className="text-xs mt-1">ホームで文書を生成してください。</p>
                        </div>
                    </div>
                ) : filteredTranscriptions.length === 0 ? (
                    <div className="bg-white rounded-xl p-8 shadow-sm">
                        <div className="flex flex-col items-center justify-center text-gray-400 text-center">
                            <Search className="w-10 h-10 mb-2 opacity-50" />
                            <p className="text-sm">検索条件に一致する文書がありません</p>
                            <p className="text-xs mt-1">別のキーワードをお試しください。</p>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filteredTranscriptions.map((transcription) => {
                            const documentId = transcription.id;
                            const isEditing = editingDocId === documentId;
                            const isSelected = selectedDocumentId === documentId;
                            const isDirtySelectedDocument = isSelected && isSelectedDocumentDirty;
                            const isPendingDelete = pendingDeleteId === documentId;
                            const isDeleting = deletingDocumentId === documentId;
                            const isSaving = savingDocumentId === documentId;
                            const hasActiveOperation = savingDocumentId !== null || deletingDocumentId !== null;
                            const processingBadge = describeProcessingBadge(
                                transcription,
                                (ms) => formatDate(new Date(ms)),
                            );
                            const isFailedDocument = transcription.status === 'failed';

                            return (
                                <article
                                    key={documentId}
                                    className={`relative bg-white rounded-xl shadow-sm transition-all group border ${isEditing
                                        ? 'border-purple-300 shadow-md'
                                        : isSelected
                                            ? 'border-purple-400 shadow-md ring-2 ring-purple-200'
                                            : 'border-gray-100 hover:shadow-md hover:border-purple-200'
                                        }`}
                                >
                                    {isEditing ? (
                                        <div className="p-4">
                                            <label htmlFor={`document-title-${documentId}`} className="block text-xs font-medium text-gray-700 mb-1.5">
                                                文書タイトル
                                            </label>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    ref={editingInputRef}
                                                    id={`document-title-${documentId}`}
                                                    type="text"
                                                    value={editedTitle}
                                                    onChange={(event) => setEditedTitle(event.target.value)}
                                                    className="min-w-0 flex-1 min-h-11 px-3 py-2 text-sm border border-purple-300 rounded focus:outline-none focus:ring-2 focus:ring-purple-500"
                                                    placeholder="タイトルを入力"
                                                    autoFocus
                                                    onKeyDown={(event) => {
                                                        if (event.key === 'Enter') void handleSaveTitle(transcription);
                                                        if (event.key === 'Escape' && documentId) handleCancelEdit(documentId);
                                                    }}
                                                    disabled={isSaving}
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => void handleSaveTitle(transcription)}
                                                    disabled={isSaving}
                                                    className="min-w-11 min-h-11 inline-flex items-center justify-center bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
                                                    aria-label="タイトルを保存"
                                                    title="保存"
                                                >
                                                    <Check className="w-4 h-4" />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => documentId && handleCancelEdit(documentId)}
                                                    disabled={isSaving}
                                                    className="min-w-11 min-h-11 inline-flex items-center justify-center bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-500"
                                                    aria-label="タイトル編集をキャンセル"
                                                    title="キャンセル"
                                                >
                                                    <XCircle className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <button
                                                ref={(element) => {
                                                    if (!documentId) return;
                                                    if (element) documentButtonRefs.current.set(documentId, element);
                                                    else documentButtonRefs.current.delete(documentId);
                                                }}
                                                type="button"
                                                onClick={() => onDocumentClick(transcription)}
                                                className="w-full min-h-32 rounded-xl p-4 pr-40 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
                                                aria-current={isSelected ? 'true' : undefined}
                                                aria-label={processingBadge
                                                    ? `「${transcription.title}」を選択（${processingBadge}）`
                                                    : `「${transcription.title}」を選択`}
                                            >
                                                <h3 className="text-sm font-semibold text-gray-900 truncate group-hover:text-purple-700 transition-colors">
                                                    {transcription.title}
                                                </h3>
                                                <p className="text-xs text-gray-500 mt-2 truncate">
                                                    {transcription.fileName}
                                                </p>
                                                <p className="text-xs text-purple-600 mt-1 font-medium truncate">
                                                    {transcription.promptName}
                                                </p>
                                                {processingBadge && (
                                                    // 段階はテキストとアイコンで伝える。色だけに依存せず、スピナーも回さない（一覧は静的な「最終確認時」）
                                                    <span
                                                        data-processing-badge={isFailedDocument ? 'failed' : 'processing'}
                                                        className={`mt-2 inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${isFailedDocument
                                                            ? 'border-red-200 bg-red-50 text-red-800'
                                                            : 'border-amber-200 bg-amber-50 text-amber-900'
                                                            }`}
                                                    >
                                                        {isFailedDocument
                                                            ? <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
                                                            : <Hourglass className="h-3 w-3 shrink-0" aria-hidden="true" />}
                                                        <span className="truncate">{processingBadge}</span>
                                                    </span>
                                                )}
                                                <span className="flex items-center space-x-2 mt-2 text-xs text-gray-500">
                                                    <Clock className="w-3 h-3" />
                                                    <span>{formatDate(transcription.createdAt)}</span>
                                                </span>
                                            </button>

                                            {!isPendingDelete && (
                                                <div className={`absolute right-2 top-2 flex items-center gap-1 transition-opacity ${actionVisibilityClasses}`}>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleEditTitle(transcription)}
                                                        disabled={hasActiveOperation}
                                                        className="min-w-11 min-h-11 inline-flex items-center justify-center hover:bg-purple-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                                                        aria-label={`「${transcription.title}」のタイトルを編集`}
                                                        title="タイトルを編集"
                                                    >
                                                        <Edit2 className="w-4 h-4 text-purple-600" />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => downloadDocument(transcription)}
                                                        className="min-w-11 min-h-11 inline-flex items-center justify-center hover:bg-purple-50 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                                                        aria-label={`「${transcription.title}」をTXTでダウンロード`}
                                                        title="TXTをダウンロード"
                                                    >
                                                        <Download className="w-4 h-4 text-blue-600" />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => requestDelete(transcription)}
                                                        disabled={hasActiveOperation}
                                                        className="min-w-11 min-h-11 inline-flex items-center justify-center hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                                                        aria-label={`「${transcription.title}」を削除`}
                                                        title="削除"
                                                    >
                                                        <Trash2 className="w-4 h-4 text-red-600" />
                                                    </button>
                                                </div>
                                            )}

                                            {isPendingDelete && (
                                                <div
                                                    role="alertdialog"
                                                    aria-labelledby={`delete-dialog-title-${documentId}`}
                                                    aria-describedby={`delete-dialog-description-${documentId}`}
                                                    className="border-t border-red-100 bg-red-50 p-3 rounded-b-xl"
                                                >
                                                    <p id={`delete-dialog-title-${documentId}`} className="text-sm text-red-900">
                                                        {isDirtySelectedDocument
                                                            ? '未保存の変更がある文書を削除しますか'
                                                            : `「${transcription.title}」を削除しますか？`}
                                                    </p>
                                                    <p id={`delete-dialog-description-${documentId}`} className="text-xs text-red-700 mt-1">この操作は取り消せません。</p>
                                                    <div className="flex justify-end gap-2 mt-3">
                                                        <button
                                                            ref={deleteCancelButtonRef}
                                                            type="button"
                                                            onClick={() => documentId && handleCancelDelete(documentId)}
                                                            disabled={isDeleting}
                                                            autoFocus
                                                            className="min-h-11 px-4 rounded-lg border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-500"
                                                        >
                                                            キャンセル
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => void handleDelete(transcription)}
                                                            disabled={isDeleting}
                                                            className="min-h-11 px-4 rounded-lg bg-red-600 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
                                                        >
                                                            {isDeleting ? '削除中…' : '削除する'}
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </article>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};
