import { db } from './firebase';
import {
    collection,
    addDoc,
    getDocs,
    query,
    orderBy,
    limit,
    Timestamp,
    deleteDoc,
    deleteField,
    doc,
    updateDoc,
    where,
    serverTimestamp,
} from 'firebase/firestore';
import { getCurrentUserId, getOwnerType } from './auth';
import { logAudit } from './auditLog';
import { validateDocumentSize } from './adminSettings';
import { updateUserStats } from './userManagement';
import { createLogger } from './logger';

const firestoreLogger = createLogger('firestore');

export interface TranscriptionDocument {
    id?: string;
    title: string; // 文書タイトル（デフォルトはfileName）
    fileName: string;
    originalFileType: string; // 'video' or 'audio'
    transcription: string;
    promptName: string; // 使用したプロンプト名
    generatedByModel?: string;
    generatedByThinkingLevel?: string;
    modelSelection?: 'default' | 'pinned';
    ownerType: 'guest' | 'user';
    ownerId: string; // "GUEST" または Auth uid
    createdBy: string; // "GUEST" または Auth uid
    createdAt: Timestamp | Date; // Firestore Timestamp または Date
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
    promptName: string;
    generatedByModel?: string;
    generatedByThinkingLevel?: string;
    modelSelection?: 'default' | 'pinned';
    createdAt: Timestamp | Date;
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
            const ownerType = data.ownerType || 'guest';
            const ownerId = data.ownerId || 'GUEST';
            const createdBy = data.createdBy || 'GUEST';

            // ログインユーザーの場合、ゲストデータを除外
            if (getOwnerType() === 'user' && ownerType === 'guest') {
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
                promptName: data.promptName || '不明',
                generatedByModel: data.generatedByModel,
                generatedByThinkingLevel: data.generatedByThinkingLevel,
                modelSelection: data.modelSelection,
                ownerType: ownerType as 'guest' | 'user',
                ownerId: ownerId,
                createdBy: createdBy,
                bitrate: data.bitrate,
                sampleRate: data.sampleRate,
                audioStoragePath: data.audioStoragePath,
                createdAt,
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
export async function getTranscriptions(limitCount: number = 100): Promise<Transcription[]> {
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
        const documents: Transcription[] = [];

        querySnapshot.forEach((docSnapshot) => {
            const data = docSnapshot.data();

            // 移行期間中: フィールドがない場合はゲスト扱い
            const ownerType = data.ownerType || 'guest';

            // ログインユーザーの場合、ゲストデータを除外
            if (getOwnerType() === 'user' && ownerType === 'guest') {
                return; // スキップ
            }

            // タイムスタンプがnullの場合のフォールバック
            const createdAt = data.createdAt ? data.createdAt : new Date();

            documents.push({
                id: docSnapshot.id,
                title: data.title || data.fileName, // 既存データの後方互換性
                fileName: data.fileName,
                text: data.transcription ?? data.text ?? '', // transcription を text にマッピング
                promptName: data.promptName || '不明',
                generatedByModel: data.generatedByModel,
                generatedByThinkingLevel: data.generatedByThinkingLevel,
                modelSelection: data.modelSelection,
                createdAt,
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
                promptName: data.promptName || '不明',
                generatedByModel: data.generatedByModel,
                generatedByThinkingLevel: data.generatedByThinkingLevel,
                modelSelection: data.modelSelection,
                createdAt,
            });
        });

        return documents;
    } catch (error) {
        firestoreLogger.error('指定ユーザーの文書取得に失敗', error, { ownerId, limitCount });
        throw new Error('指定したユーザーの文書取得に失敗しました');
    }
}

/**
 * 文書のタイトルを更新
 */
export async function updateTranscriptionTitle(documentId: string, newTitle: string): Promise<void> {
    try {
        const docRef = doc(db, 'transcriptions', documentId);
        await updateDoc(docRef, {
            title: newTitle,
        });

        // 監査ログを記録
        await logAudit('document_update', 'document', documentId, { title: newTitle });
    } catch (error) {
        firestoreLogger.error('文書タイトルの更新に失敗', error, { documentId });
        throw new Error('タイトルの更新に失敗しました');
    }
}

/**
 * 文書のコンテンツを更新
 */
export async function updateTranscriptionContent(documentId: string, newContent: string): Promise<void> {
    try {
        const docRef = doc(db, 'transcriptions', documentId);
        await updateDoc(docRef, {
            transcription: newContent,
            text: deleteField(),
            updatedAt: serverTimestamp(),
        });

        // 監査ログを記録
        await logAudit('document_update', 'document', documentId, { content: 'updated' });
    } catch (error) {
        firestoreLogger.error('文書コンテンツの更新に失敗', error, { documentId });
        throw new Error('コンテンツの更新に失敗しました');
    }
}

/**
 * Firestoreから文書を削除
 */
export async function deleteTranscription(documentId: string): Promise<void> {
    try {
        const userId = getCurrentUserId();
        const ownerType = getOwnerType();

        await deleteDoc(doc(db, 'transcriptions', documentId));

        // 監査ログを記録
        await logAudit('document_delete', 'document', documentId);

        // ユーザー統計を更新
        if (ownerType === 'user') {
            await updateUserStats(userId, 0, -1);
        }
    } catch (error) {
        firestoreLogger.error('文書の削除に失敗', error, { documentId });
        throw new Error('文書の削除に失敗しました');
    }
}
