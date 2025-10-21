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
} from 'firebase/firestore';

export interface TranscriptionDocument {
    id?: string;
    fileName: string;
    originalFileType: string; // 'video' or 'audio'
    transcription: string;
    promptName: string; // 使用したプロンプト名
    createdAt: any; // Firestore Timestamp または Date
    bitrate?: string;
    sampleRate?: number;
}

// エイリアス（後方互換性のため）
export interface Transcription {
    id?: string;
    fileName: string;
    text: string; // transcription のエイリアス
    promptName: string;
    createdAt: any;
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
        const docRef = await addDoc(collection(db, 'transcriptions'), {
            fileName,
            originalFileType,
            transcription,
            promptName,
            bitrate,
            sampleRate,
            createdAt: Timestamp.now(),
        });

        return docRef.id;
    } catch (error) {
        console.error('Firestore保存エラー:', error);
        throw new Error('文書の保存に失敗しました');
    }
}

/**
 * Firestoreから文書を取得（新しい順） - TranscriptionDocument形式
 */
export async function getTranscriptionDocuments(limitCount: number = 20): Promise<TranscriptionDocument[]> {
    try {
        const q = query(
            collection(db, 'transcriptions'),
            orderBy('createdAt', 'desc'),
            limit(limitCount)
        );

        const querySnapshot = await getDocs(q);
        const documents: TranscriptionDocument[] = [];

        querySnapshot.forEach((docSnapshot) => {
            const data = docSnapshot.data();
            documents.push({
                id: docSnapshot.id,
                fileName: data.fileName,
                originalFileType: data.originalFileType,
                transcription: data.transcription,
                promptName: data.promptName || '不明',
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
 */
export async function getTranscriptions(limitCount: number = 100): Promise<Transcription[]> {
    try {
        const q = query(
            collection(db, 'transcriptions'),
            orderBy('createdAt', 'desc'),
            limit(limitCount)
        );

        const querySnapshot = await getDocs(q);
        const documents: Transcription[] = [];

        querySnapshot.forEach((docSnapshot) => {
            const data = docSnapshot.data();
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

