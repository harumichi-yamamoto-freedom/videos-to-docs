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
    doc,
    where,
    serverTimestamp,
} from 'firebase/firestore';
import { getCurrentUserId, getOwnerType } from './auth';

export interface TranscriptionDocument {
    id?: string;
    fileName: string;
    originalFileType: string; // 'video' or 'audio'
    transcription: string;
    promptName: string; // 使用したプロンプト名
    ownerType: 'guest' | 'user';
    ownerId: string; // "GUEST" または Auth uid
    createdBy: string; // "GUEST" または Auth uid
    createdAt: Timestamp | Date; // Firestore Timestamp または Date
    bitrate?: string;
    sampleRate?: number;
}

// エイリアス（後方互換性のため）
export interface Transcription {
    id?: string;
    fileName: string;
    text: string; // transcription のエイリアス
    promptName: string;
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
    sampleRate?: number
): Promise<string> {
    try {
        const userId = getCurrentUserId();
        const ownerType = getOwnerType();

        const docRef = await addDoc(collection(db, 'transcriptions'), {
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
        });

        return docRef.id;
    } catch (error) {
        console.error('Firestore保存エラー:', error);
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

            documents.push({
                id: docSnapshot.id,
                fileName: data.fileName,
                originalFileType: data.originalFileType,
                transcription: data.transcription,
                promptName: data.promptName || '不明',
                ownerType: ownerType as 'guest' | 'user',
                ownerId: ownerId,
                createdBy: createdBy,
                bitrate: data.bitrate,
                sampleRate: data.sampleRate,
                createdAt: data.createdAt.toDate(),
            });
        });

        return documents;
    } catch (error) {
        console.error('Firestore取得エラー:', error);
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

            documents.push({
                id: docSnapshot.id,
                fileName: data.fileName,
                text: data.transcription, // transcription を text にマッピング
                promptName: data.promptName || '不明',
                createdAt: data.createdAt,
            });
        });

        return documents;
    } catch (error) {
        console.error('Firestore取得エラー:', error);
        throw new Error('文書の取得に失敗しました');
    }
}

/**
 * Firestoreから文書を削除
 */
export async function deleteTranscription(documentId: string): Promise<void> {
    try {
        await deleteDoc(doc(db, 'transcriptions', documentId));
    } catch (error) {
        console.error('Firestore削除エラー:', error);
        throw new Error('文書の削除に失敗しました');
    }
}

