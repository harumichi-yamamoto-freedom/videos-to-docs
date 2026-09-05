import { db } from './firebase';
import {
    collection,
    addDoc,
    getDoc,
    getDocs,
    increment,
    query,
    orderBy,
    limit,
    runTransaction,
    Timestamp,
    deleteField,
    doc,
    updateDoc,
    where,
    serverTimestamp,
} from 'firebase/firestore';
import { getCurrentUserId, getOwnerType } from './auth';
import type { DocumentProcessingProgress } from './transcribeBatchContract';
import type { TranscriptReview } from './transcriptReviewContract';
import { logAudit } from './auditLog';
import { validateDocumentSize } from './adminSettings';
import { updateUserStats } from './userManagement';
import { createLogger } from './logger';

const firestoreLogger = createLogger('firestore');


/**
 * 文書に保存された進捗投影を読取境界で正規化する（設計 §A3）。
 * 保存側は stageObservedAt を Firestore Timestamp で書くので、ここで ms へ直す。
 * 不正・欠損は undefined を返し、UI 側は投影なしとして扱う。
 */
const normalizeProcessingProgress = (raw: unknown): DocumentProcessingProgress | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    const stage = r.stage;
    const validStages = ['checking', 'queued', 'transcribing', 'importing', 'completed', 'failed'];
    if (typeof stage !== 'string' || !validStages.includes(stage)) return undefined;
    const observed = r.stageObservedAt;
    const stageObservedAtMs = observed instanceof Timestamp ? observed.toMillis()
        : typeof (observed as { toMillis?: () => number })?.toMillis === 'function'
            ? (observed as { toMillis: () => number }).toMillis()
            : typeof observed === 'number' ? observed : undefined;
    return {
        stage: stage as DocumentProcessingProgress['stage'],
        ...(typeof stageObservedAtMs === 'number' && { stageObservedAtMs }),
        ...(typeof r.jobCreatedAtMs === 'number' && { jobCreatedAtMs: r.jobCreatedAtMs }),
        ...(typeof r.audioSec === 'number' && { audioSec: r.audioSec }),
    };
};

/**
 * 完成文書に保存された要確認候補（設計 B2）。サーバが生成時に本文と同時に書く。旧文書ではフィールドごと無い。
 * 読取境界では形の最小確認だけ行い（object かつ version が数値・availability が文字列）、中身の再評価や補正はしない。
 * 本文との対応は UI 側が sourceTextHash の一致で判定する。
 */
const normalizeTranscriptReview = (raw: unknown): TranscriptReview | undefined => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const r = raw as { version?: unknown; availability?: unknown };
    if (typeof r.version !== 'number' || typeof r.availability !== 'string') return undefined;
    return raw as TranscriptReview;
};

export interface TranscriptionDocument {
    id?: string;
    title: string; // 文書タイトル（デフォルトはfileName）
    fileName: string;
    originalFileType: string; // 'video' or 'audio'
    transcription: string;
    status?: string;
    jobId?: string;
    /** 表示専用の進捗投影（設計 §A3・processing 文書のみ・サーバが書く） */
    processingProgress?: DocumentProcessingProgress;
    /** 要確認候補（設計 B2・completed 文書のみ・サーバが生成時に書く）。旧文書では無い */
    transcriptReview?: TranscriptReview;
    promptName: string; // 使用したプロンプト名
    generatedByModel?: string;
    generatedByThinkingLevel?: string;
    modelSelection?: 'default' | 'pinned';
    ownerType: 'guest' | 'user';
    ownerId: string; // "GUEST" または Auth uid
    createdBy: string; // "GUEST" または Auth uid
    createdAt: Timestamp | Date; // Firestore Timestamp または Date
    updatedAt?: Timestamp | Date;
    bitrate?: string;
    sampleRate?: number;
    audioStoragePath?: string;
}

// エイリアス（後方互換性のため）
export interface Transcription {
    id?: string;
    title: string; // 文書タイトル（デフォルトはfileName）
    fileName: string;
    text: string; // transcription のエイリアス
    status?: string;
    jobId?: string;
    processingProgress?: DocumentProcessingProgress;
    transcriptReview?: TranscriptReview;
    promptName: string;
    originalFileType?: string;
    generatedByModel?: string;
    generatedByThinkingLevel?: string;
    modelSelection?: 'default' | 'pinned';
    ownerType?: 'guest' | 'user';
    ownerId?: string;
    createdBy?: string;
    createdAt: Timestamp | Date;
    updatedAt?: Timestamp | Date;
    // 復元時に取りこぼすとStorageの音声が孤児になるため、一覧の読出しでも保持する。
    bitrate?: string;
    sampleRate?: number;
    audioStoragePath?: string;
}

export interface TranscriptionUpdatePatch {
    title?: string;
    transcription?: string;
}

export interface TranscriptionUpdateOptions {
    /**
     * 楽観的並行性制御の期待値。呼び出し側が最後に読み込んだ updatedAt を渡すと、
     * transaction内で保存済みの updatedAt と突き合わせ、不一致なら書き込まずに
     * TranscriptionConflictError で拒否する。
     * undefined = 検査しない（従来挙動）。null = 「updatedAt未設定の文書を読んだ」。
     */
    expectedUpdatedAt?: Timestamp | Date | null;
}

/**
 * 他の場所（別タブ・別端末）で先に更新された文書への上書き保存の拒否。
 * 「保存に失敗」と区別し、呼び出し側が最新の読み込み導線を出せるようにする。
 */
export class TranscriptionConflictError extends Error {
    constructor() {
        super('他の場所で更新されています。内容を確認してから保存し直してください。');
        this.name = 'TranscriptionConflictError';
    }
}

/**
 * updatedAt同士の一致判定。競合検査と「採用予約が指す版か」の判定を
 * この1関数に集約する(判定が二重実装になると片方だけ較正される)。
 */
export function isSameUpdatedAt(
    stored: unknown,
    expected: Timestamp | Date | null,
): boolean {
    if (stored === undefined || stored === null) return expected === null;
    if (expected === null) return false;

    const storedTimestamp = stored as {
        isEqual?: (other: unknown) => boolean;
        toMillis?: () => number;
    };
    if (typeof storedTimestamp.isEqual === 'function' && !(expected instanceof Date)) {
        return storedTimestamp.isEqual(expected);
    }

    const storedMillis = stored instanceof Date
        ? stored.getTime()
        : typeof storedTimestamp.toMillis === 'function'
            ? storedTimestamp.toMillis()
            : null;
    const expectedMillis = expected instanceof Date
        ? expected.getTime()
        : expected.toMillis();
    return storedMillis !== null && storedMillis === expectedMillis;
}

export type DeleteTranscriptionResult = 'deleted' | 'deletedWithWarning';

export interface TranscriptionOwnerScope {
    ownerId: string;
    ownerType: 'guest' | 'user';
}

/**
 * Firestoreに文書を保存
 */
export async function saveTranscription(
    fileName: string,
    transcription: string,
    promptName: string,
    originalFileType: string,
    bitrate?: string,
    sampleRate?: number,
    title?: string,
    audioStoragePath?: string,
    generatedByModel?: string,
    modelSelection?: 'default' | 'pinned',
    // 既存の positional 呼び出しを維持するため、新規引数は末尾に追加する。
    generatedByThinkingLevel?: string,
    /** 呼び出し側がジョブ開始時に固定した所有者UID。実際に書き込む userId と一致しなければ保存しない */
    expectedOwnerUid?: string,
): Promise<string> {
    try {
        const userId = getCurrentUserId();
        const ownerType = getOwnerType();

        // 書き込む userId そのものを照合する。呼び出し側で確認してから
        // ここへ到達するまでの間に認証が変わっても取り違えない
        if (expectedOwnerUid !== undefined && expectedOwnerUid !== userId) {
            // UID は利用者に見せず、突き合わせに必要な値はログにだけ残す
            firestoreLogger.error('保存先の所有者が処理開始時から変わったため保存を中止', undefined, {
                fileName,
                promptName,
                expectedOwnerUid,
                currentUserId: userId,
            });
            throw new Error(
                'ログイン状態が処理の開始時から変わったため、保存を中止しました。ログインし直してから、もう一度お試しください。'
            );
        }

        // サイズチェック
        const sizeValidation = await validateDocumentSize(transcription);
        if (!sizeValidation.valid) {
            throw new Error(
                `文書のサイズが上限を超えています。` +
                `（現在: ${(sizeValidation.size / 1024).toFixed(2)}KB / ` +
                `上限: ${(sizeValidation.maxSize / 1024).toFixed(2)}KB）`
            );
        }

        const docRef = await addDoc(collection(db, 'transcriptions'), {
            title: title || fileName, // デフォルトはfileName
            fileName,
            originalFileType,
            transcription,
            promptName,
            bitrate,
            sampleRate,
            ownerType,
            ownerId: userId,
            createdBy: userId,
            createdAt: serverTimestamp(),
            ...(audioStoragePath && { audioStoragePath }),
            ...(generatedByModel !== undefined && { generatedByModel }),
            ...(generatedByThinkingLevel !== undefined && { generatedByThinkingLevel }),
            ...(modelSelection !== undefined && { modelSelection }),
        });

        // 監査ログを記録
        await logAudit('document_create', 'document', docRef.id, { fileName, promptName, ownerType });

        // ユーザー統計を更新
        if (ownerType === 'user') {
            await updateUserStats(userId, 0, 1);
        }

        return docRef.id;
    } catch (error) {
        firestoreLogger.error('文書の保存に失敗', error, { fileName, promptName });
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('文書の保存に失敗しました');
    }
}

/**
 * Firestoreから文書を取得（新しい順） - TranscriptionDocument形式
 * 現在のユーザーが所有している文書のみ取得
 */
export async function getTranscriptionDocuments(limitCount: number = 20): Promise<TranscriptionDocument[]> {
    try {
        const userId = getCurrentUserId();
        const ownerType = getOwnerType();

        let q;
        if (ownerType === 'guest') {
            // ゲストの場合: ゲスト共有の文書を取得
            q = query(
                collection(db, 'transcriptions'),
                where('ownerType', '==', 'guest'),
                orderBy('createdAt', 'desc'),
                limit(limitCount)
            );
        } else {
            // ログイン済みの場合: 自分の文書のみ取得
            q = query(
                collection(db, 'transcriptions'),
                where('ownerId', '==', userId),
                orderBy('createdAt', 'desc'),
                limit(limitCount)
            );
        }

        const querySnapshot = await getDocs(q);
        const documents: TranscriptionDocument[] = [];

        querySnapshot.forEach((docSnapshot) => {
            const data = docSnapshot.data();

            // 移行期間中: フィールドがない場合はゲスト扱い
            const documentOwnerType = data.ownerType || 'guest';
            const ownerId = data.ownerId || 'GUEST';
            const createdBy = data.createdBy || 'GUEST';

            // ログインユーザーの場合、ゲストデータを除外
            if (getOwnerType() === 'user' && documentOwnerType === 'guest') {
                return; // スキップ
            }

            // タイムスタンプがnullの場合のフォールバック
            const createdAt = data.createdAt ? data.createdAt.toDate() : new Date();

            documents.push({
                id: docSnapshot.id,
                title: data.title || data.fileName, // 既存データの後方互換性
                fileName: data.fileName,
                originalFileType: data.originalFileType,
                transcription: data.transcription ?? data.text ?? '',
                status: data.status,
                jobId: data.jobId,
                processingProgress: normalizeProcessingProgress(data.processingProgress),
                transcriptReview: normalizeTranscriptReview(data.transcriptReview),
                promptName: data.promptName || '不明',
                generatedByModel: data.generatedByModel,
                generatedByThinkingLevel: data.generatedByThinkingLevel,
                modelSelection: data.modelSelection,
                ownerType: documentOwnerType as 'guest' | 'user',
                ownerId: ownerId,
                createdBy: createdBy,
                bitrate: data.bitrate,
                sampleRate: data.sampleRate,
                audioStoragePath: data.audioStoragePath,
                createdAt,
                updatedAt: data.updatedAt,
            });
        });

        return documents;
    } catch (error) {
        firestoreLogger.error('文書の取得に失敗', error, { limitCount });
        throw new Error('文書の取得に失敗しました');
    }
}

/**
 * Firestoreから文書を取得（新しい順） - Transcription形式（簡略版）
 * 現在のユーザーが所有している文書のみ取得
 */
export async function getTranscriptions(
    limitCount: number = 100,
    ownerScope?: TranscriptionOwnerScope,
): Promise<Transcription[]> {
    try {
        const userId = ownerScope?.ownerId ?? getCurrentUserId();
        const ownerType = ownerScope?.ownerType ?? getOwnerType();

        let q;
        if (ownerType === 'guest') {
            // ゲストの場合: ゲスト共有の文書を取得
            q = query(
                collection(db, 'transcriptions'),
                where('ownerType', '==', 'guest'),
                orderBy('createdAt', 'desc'),
                limit(limitCount)
            );
        } else {
            // ログイン済みの場合: 自分の文書のみ取得
            q = query(
                collection(db, 'transcriptions'),
                where('ownerId', '==', userId),
                orderBy('createdAt', 'desc'),
                limit(limitCount)
            );
        }

        const querySnapshot = await getDocs(q);
        // オフライン時などcache由来の読取は、サーバの現在版の証拠にならない。
        // 版印を確定として下流(競合検査の期待値・版未確定警告のclear)に使わせない
        // よう、cache読取の行は updatedAt を未確定(undefined)へ剥がす。
        const isFromCache = Boolean(
            (querySnapshot as { metadata?: { fromCache?: boolean } }).metadata?.fromCache,
        );
        const documents: Transcription[] = [];

        querySnapshot.forEach((docSnapshot) => {
            const data = docSnapshot.data();

            // 移行期間中: フィールドがない場合はゲスト扱い
            const documentOwnerType = data.ownerType || 'guest';

            // ログインユーザーの場合、ゲストデータを除外
            if (ownerType === 'user' && documentOwnerType === 'guest') {
                return; // スキップ
            }

            // タイムスタンプがnullの場合のフォールバック
            const createdAt = data.createdAt ? data.createdAt : new Date();

            documents.push({
                id: docSnapshot.id,
                title: data.title || data.fileName, // 既存データの後方互換性
                fileName: data.fileName,
                text: data.transcription ?? data.text ?? '', // transcription を text にマッピング
                status: data.status,
                jobId: data.jobId,
                processingProgress: normalizeProcessingProgress(data.processingProgress),
                transcriptReview: normalizeTranscriptReview(data.transcriptReview),
                promptName: data.promptName || '不明',
                originalFileType: data.originalFileType,
                generatedByModel: data.generatedByModel,
                generatedByThinkingLevel: data.generatedByThinkingLevel,
                modelSelection: data.modelSelection,
                ownerType: documentOwnerType as 'guest' | 'user',
                ownerId: data.ownerId || 'GUEST',
                createdBy: data.createdBy || data.ownerId || 'GUEST',
                createdAt,
                updatedAt: isFromCache ? undefined : data.updatedAt,
                bitrate: data.bitrate,
                sampleRate: data.sampleRate,
                audioStoragePath: data.audioStoragePath,
            });
        });

        return documents;
    } catch (error) {
        firestoreLogger.error('文書の取得に失敗', error, { limitCount });
        throw new Error('文書の取得に失敗しました');
    }
}

export async function getTranscriptionsByOwnerId(ownerId: string, limitCount: number = 100): Promise<Transcription[]> {
    try {
        const q = query(
            collection(db, 'transcriptions'),
            where('ownerId', '==', ownerId),
            orderBy('createdAt', 'desc'),
            limit(limitCount)
        );

        const querySnapshot = await getDocs(q);
        const documents: Transcription[] = [];

        querySnapshot.forEach((docSnapshot) => {
            const data = docSnapshot.data();
            const createdAt = data.createdAt ? data.createdAt.toDate() : new Date();

            documents.push({
                id: docSnapshot.id,
                title: data.title || data.fileName,
                fileName: data.fileName,
                text: data.transcription ?? data.text ?? '',
                status: data.status,
                jobId: data.jobId,
                processingProgress: normalizeProcessingProgress(data.processingProgress),
                transcriptReview: normalizeTranscriptReview(data.transcriptReview),
                promptName: data.promptName || '不明',
                originalFileType: data.originalFileType,
                generatedByModel: data.generatedByModel,
                generatedByThinkingLevel: data.generatedByThinkingLevel,
                modelSelection: data.modelSelection,
                ownerType: (data.ownerType || 'guest') as 'guest' | 'user',
                ownerId: data.ownerId || 'GUEST',
                createdBy: data.createdBy || data.ownerId || 'GUEST',
                createdAt,
                updatedAt: data.updatedAt,
                bitrate: data.bitrate,
                sampleRate: data.sampleRate,
                audioStoragePath: data.audioStoragePath,
            });
        });

        return documents;
    } catch (error) {
        firestoreLogger.error('指定ユーザーの文書取得に失敗', error, { ownerId, limitCount });
        throw new Error('指定したユーザーの文書取得に失敗しました');
    }
}

/**
 * 本文が上限を超えたことによる保存拒否。
 * 「保存に失敗」で潰さず、本文を削れば保存できると呼び出し側が案内するために区別する。
 */
export class DocumentSizeLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DocumentSizeLimitError';
    }
}

/**
 * 保存済み本文のバイト数を取得する。文書が無い場合と読めなかった場合は null。
 */
async function getStoredTranscriptionSize(documentId: string): Promise<number | null> {
    try {
        const snapshot = await getDoc(doc(db, 'transcriptions', documentId));
        if (!snapshot.exists()) return null;

        const data = snapshot.data();
        return new Blob([data.transcription ?? data.text ?? '']).size;
    } catch (error) {
        firestoreLogger.error('保存済み本文サイズの取得に失敗', error, { documentId });
        return null;
    }
}

/**
 * 本文サイズの上限を、更新と復元の双方で同じ基準として課す。
 * 上限を超えていても保存済み本文より大きくならない更新は許可する。
 * （上限引き下げ後の既存文書が、本文を削る編集すらできなくなるのを防ぐため）
 */
async function assertTranscriptionSizeAllowed(
    documentId: string,
    transcription: string,
): Promise<void> {
    const sizeValidation = await validateDocumentSize(transcription);
    if (sizeValidation.valid) return;

    const storedSize = await getStoredTranscriptionSize(documentId);
    if (storedSize !== null && sizeValidation.size <= storedSize) return;

    throw new DocumentSizeLimitError(
        `文書のサイズが上限を超えています。` +
        `（現在: ${(sizeValidation.size / 1024).toFixed(2)}KB / ` +
        `上限: ${(sizeValidation.maxSize / 1024).toFixed(2)}KB）`,
    );
}

export async function updateTranscription(
    documentId: string,
    patch: TranscriptionUpdatePatch,
    options?: TranscriptionUpdateOptions,
): Promise<Timestamp | null> {
    const updatePayload: Record<string, unknown> = {};
    const auditDetails: Record<string, string> = {};

    if (patch.title !== undefined) {
        updatePayload.title = patch.title;
        auditDetails.title = patch.title;
    }

    if (patch.transcription !== undefined) {
        updatePayload.transcription = patch.transcription;
        updatePayload.text = deleteField();
        auditDetails.content = 'updated';
    }

    if (Object.keys(updatePayload).length === 0) {
        throw new Error('更新内容が指定されていません');
    }

    if (patch.transcription !== undefined) {
        await assertTranscriptionSizeAllowed(documentId, patch.transcription);
    }

    updatePayload.updatedAt = serverTimestamp();
    const expectedUpdatedAt = options?.expectedUpdatedAt;
    const docRef = doc(db, 'transcriptions', documentId);

    if (expectedUpdatedAt === undefined) {
        try {
            await updateDoc(docRef, updatePayload);
        } catch (error) {
            firestoreLogger.error('文書の更新に失敗', error, { documentId });
            throw new Error('文書の更新に失敗しました');
        }
    } else {
        try {
            await runTransaction(db, async transaction => {
                const snapshot = await transaction.get(docRef);
                // 文書ごと消えていた場合も「他の場所での変更」として同じ導線
                // （最新を読み込む→欠落バナー）へ流す。
                if (
                    !snapshot.exists()
                    || !isSameUpdatedAt(snapshot.data().updatedAt, expectedUpdatedAt)
                ) {
                    throw new TranscriptionConflictError();
                }

                transaction.update(docRef, updatePayload);
            });
        } catch (error) {
            if (error instanceof TranscriptionConflictError) throw error;
            firestoreLogger.error('文書の更新に失敗', error, { documentId });
            throw new Error('文書の更新に失敗しました');
        }
    }

    try {
        await logAudit('document_update', 'document', documentId, auditDetails);
    } catch (error) {
        firestoreLogger.error('文書更新後の監査ログ記録に失敗', error, { documentId });
    }

    if (expectedUpdatedAt === undefined) return null;

    // serverTimestampの実値は書き込み時点では分からない。次回保存の期待値として
    // 読み戻して返す。読めなくても保存自体は成功している。
    return readBackWrittenUpdatedAt(documentId, {
        title: patch.title,
        transcription: patch.transcription,
    });
}

/**
 * commit直後のupdatedAt読み戻し。commitと読取は原子でないため、間に別writer
 * （競合検査なしのタイトル改名等）が割り込むと、読めたupdatedAtは自分が書いた版の
 * 証拠にならない。書いたフィールドの一致を確認し、崩れていたらnullを返して
 * 呼び出し側に期待値を据え置かせる（安全側=次回保存は競合として止まる）。
 */
async function readBackWrittenUpdatedAt(
    documentId: string,
    writtenFields: { title?: string; transcription?: string },
): Promise<Timestamp | null> {
    try {
        const freshSnapshot = await getDoc(doc(db, 'transcriptions', documentId));
        if (!freshSnapshot.exists()) return null;
        // cacheからの読み戻しはcommit後のサーバ状態の証拠にならない(オフラインで
        // commitだけ通った場合、cacheの旧版でフィールドが偶然一致し得る)。
        if (
            (freshSnapshot as { metadata?: { fromCache?: boolean } }).metadata?.fromCache
        ) {
            return null;
        }

        const freshData = freshSnapshot.data();
        const writtenFieldsIntact =
            (writtenFields.title === undefined || freshData.title === writtenFields.title)
            && (writtenFields.transcription === undefined
                || freshData.transcription === writtenFields.transcription);
        if (!writtenFieldsIntact) return null;

        return (freshData.updatedAt as Timestamp | undefined) ?? null;
    } catch (error) {
        firestoreLogger.error('保存後のupdatedAt再読込に失敗', error, { documentId });
        return null;
    }
}

/**
 * 一覧から消えた編集中の文書を、保持中のスナップショットから同じIDへ復元する。
 * 既存文書が一時的に一覧へ現れなかっただけの場合は、本文関連フィールドだけを更新する。
 */
export async function restoreTranscription(
    documentId: string,
    source: Transcription,
    patch: TranscriptionUpdatePatch,
    options?: TranscriptionUpdateOptions,
): Promise<Timestamp | null> {
    const currentOwnerId = getCurrentUserId();
    const currentOwnerType = getOwnerType();
    const sourceOwnerType = source.ownerType ?? currentOwnerType;
    const sourceOwnerId = source.ownerId ?? (sourceOwnerType === 'guest' ? 'GUEST' : currentOwnerId);

    if (sourceOwnerType !== currentOwnerType || sourceOwnerId !== currentOwnerId) {
        throw new Error('所有者が変わった文書は復元できません');
    }

    const title = patch.title ?? source.title;
    const transcription = patch.transcription ?? source.text;
    await assertTranscriptionSizeAllowed(documentId, transcription);

    const transcriptionRef = doc(db, 'transcriptions', documentId);
    const restorePayload: Record<string, unknown> = {
        title,
        fileName: source.fileName,
        originalFileType: source.originalFileType ?? 'unknown',
        transcription,
        promptName: source.promptName,
        ownerType: sourceOwnerType,
        ownerId: sourceOwnerId,
        createdBy: source.createdBy ?? sourceOwnerId,
        createdAt: source.createdAt,
        updatedAt: serverTimestamp(),
        ...(source.status !== undefined && { status: source.status }),
        ...(source.jobId !== undefined && { jobId: source.jobId }),
        ...(source.generatedByModel !== undefined && {
            generatedByModel: source.generatedByModel,
        }),
        ...(source.generatedByThinkingLevel !== undefined && {
            generatedByThinkingLevel: source.generatedByThinkingLevel,
        }),
        ...(source.modelSelection !== undefined && {
            modelSelection: source.modelSelection,
        }),
        // 再作成で欠けるとStorageの音声を参照する手段が失われ孤児になる。
        ...(source.bitrate !== undefined && { bitrate: source.bitrate }),
        ...(source.sampleRate !== undefined && { sampleRate: source.sampleRate }),
        ...(source.audioStoragePath !== undefined && {
            audioStoragePath: source.audioStoragePath,
        }),
    };

    try {
        await runTransaction(db, async transaction => {
            const transcriptionSnapshot = await transaction.get(transcriptionRef);

            if (transcriptionSnapshot.exists()) {
                const existingData = transcriptionSnapshot.data();
                const existingOwnerType = existingData.ownerType || 'guest';
                const existingOwnerId = existingData.ownerId || 'GUEST';
                if (existingOwnerType !== currentOwnerType || existingOwnerId !== currentOwnerId) {
                    throw new Error('所有者が変わった文書は復元できません');
                }

                // 一覧は取得上限つきで「消えた」は削除の証拠にならない。圏外化して
                // いただけの文書が別の場所で更新されていたら、古いdraftで消さない。
                const expectedUpdatedAt = options?.expectedUpdatedAt;
                if (
                    expectedUpdatedAt !== undefined
                    && !isSameUpdatedAt(existingData.updatedAt, expectedUpdatedAt)
                ) {
                    throw new TranscriptionConflictError();
                }

                transaction.update(transcriptionRef, {
                    title,
                    transcription,
                    text: deleteField(),
                    updatedAt: restorePayload.updatedAt,
                });
                return;
            }

            const userRef = currentOwnerType === 'user'
                ? doc(db, 'users', currentOwnerId)
                : null;
            const userSnapshot = userRef
                ? await transaction.get(userRef)
                : null;

            transaction.set(transcriptionRef, restorePayload, { merge: true });
            if (userRef && userSnapshot?.exists()) {
                transaction.update(userRef, { documentCount: increment(1) });
            }
        });
    } catch (error) {
        if (error instanceof TranscriptionConflictError) throw error;
        firestoreLogger.error('文書の復元に失敗', error, { documentId });
        throw new Error('文書の復元に失敗しました');
    }

    try {
        await logAudit('document_update', 'document', documentId, {
            title,
            content: 'restored',
        });
    } catch (error) {
        firestoreLogger.error('文書復元後の監査ログ記録に失敗', error, { documentId });
    }

    // 復元もserverTimestampを書くため、次回保存の期待値を読み戻して返す
    // （返せないときの据え置きは偽競合=安全側で、一覧のrefetchが解消する）。
    return readBackWrittenUpdatedAt(documentId, { title, transcription });
}

/**
 * 文書のタイトルを更新
 */
export async function updateTranscriptionTitle(documentId: string, newTitle: string): Promise<void> {
    await updateTranscription(documentId, { title: newTitle });
}

/**
 * 文書のコンテンツを更新
 */
export async function updateTranscriptionContent(documentId: string, newContent: string): Promise<void> {
    await updateTranscription(documentId, { transcription: newContent });
}

async function recordDocumentDeletionAudit(userId: string, documentId: string): Promise<void> {
    const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : undefined;
    await addDoc(collection(db, 'auditLogs'), {
        userId,
        action: 'document_delete',
        resourceType: 'document',
        resourceId: documentId,
        timestamp: serverTimestamp(),
        ...(userAgent !== undefined && { userAgent }),
    });
}

/**
 * Firestoreから文書を削除
 */
export async function deleteTranscription(documentId: string): Promise<DeleteTranscriptionResult> {
    // 監査ログは「誰が消したか」なので現在の認証主体で記録する。
    const userId = getCurrentUserId();
    const transcriptionRef = doc(db, 'transcriptions', documentId);

    let deleted: boolean;

    try {
        deleted = await runTransaction(db, async transaction => {
            const transcriptionSnapshot = await transaction.get(transcriptionRef);
            if (!transcriptionSnapshot.exists()) return false;

            // 件数は削除した人ではなく、削除される文書の所有者から引く。
            const documentData = transcriptionSnapshot.data();
            const documentOwnerType = documentData.ownerType || 'guest';
            const documentOwnerId = documentData.ownerId || 'GUEST';
            // ゲスト所有はusersドキュメントを持たない（作成時も加算していない）。
            const ownerRef = documentOwnerType === 'user'
                ? doc(db, 'users', documentOwnerId)
                : null;
            const ownerSnapshot = ownerRef
                ? await transaction.get(ownerRef)
                : null;

            transaction.delete(transcriptionRef);

            if (ownerRef && ownerSnapshot?.exists()) {
                const documentCount = ownerSnapshot.data().documentCount;
                if (Number.isFinite(documentCount) && documentCount >= 1) {
                    transaction.update(ownerRef, { documentCount: increment(-1) });
                }
            }

            return true;
        });
    } catch (error) {
        firestoreLogger.error('文書の削除に失敗', error, { documentId });
        throw new Error('文書の削除に失敗しました');
    }

    // 既に削除済みなら成功扱いにするが、監査ログと件数減算は重複させない。
    if (!deleted) return 'deleted';

    try {
        await recordDocumentDeletionAudit(userId, documentId);
    } catch (error) {
        firestoreLogger.error('文書削除後の監査ログ記録に失敗', error, { documentId });
        return 'deletedWithWarning';
    }

    return 'deleted';
}
