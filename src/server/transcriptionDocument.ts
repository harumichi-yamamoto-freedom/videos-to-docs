/**
 * 非同期バッチ用の**サーバ側（Admin SDK）文書書き込み**。
 *
 * 🔴 なぜサーバが書くか: バッチはブラウザのタブと無関係に Azure 側で走る。完了を webhook / poll の
 *    どちらで受けても、**タブが閉じていても文書へ書けるように**サーバが所有する（設計 §7.3）。
 * 🔴 クライアントが一覧で読む `transcriptions` コレクションに、同じ形で書く（追加フィールドは `status`）。
 *    既存の読み取りは未知フィールドを無視するので後方互換。
 * 🔴 失敗しても文書は消さない（設計 §4.4・L2-D1 の是正）。理由を本文に残す。
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminFirestore } from './firebaseAdmin';
import { createLogger } from '@/lib/logger';

const logger = createLogger('server/transcriptionDocument');

export const TRANSCRIPTIONS_COLLECTION = 'transcriptions';

export type TranscriptionDocStatus = 'processing' | 'completed' | 'failed';

export interface CreateProcessingDocInput {
    ownerId: string;
    ownerType: 'guest' | 'user';
    fileName: string;
    promptName: string;
    title?: string;
    originalFileType: string; // 'audio' | 'video'
    audioStoragePath?: string;
}

const PROCESSING_PLACEHOLDER = '（文字起こしを実行しています。完了すると自動で反映されます。数分〜十数分かかることがあります。）';

/** 文書を 'processing' で先に作り、一覧へ即出す。返り値は docId。 */
export async function createProcessingDocument(input: CreateProcessingDocInput): Promise<string> {
    const ref = getAdminFirestore().collection(TRANSCRIPTIONS_COLLECTION).doc();
    await ref.set({
        title: input.title || input.fileName,
        fileName: input.fileName,
        originalFileType: input.originalFileType,
        transcription: PROCESSING_PLACEHOLDER,
        promptName: input.promptName,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        createdBy: input.ownerId,
        status: 'processing' satisfies TranscriptionDocStatus,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        ...(input.audioStoragePath && { audioStoragePath: input.audioStoragePath }),
    });
    logger.info('処理中の文書を作成', { docId: ref.id, ownerType: input.ownerType });
    return ref.id;
}

/** 完了: 本文を書き込み、status を completed にする。 */
export async function completeTranscriptionDocument(
    docId: string,
    transcription: string,
    generatedByModel: string,
    expectedOwnerId: string,
): Promise<void> {
    const db = getAdminFirestore();
    const ref = db.collection(TRANSCRIPTIONS_COLLECTION).doc(docId);
    const completed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
            logger.warn('削除済みの文書の完成をスキップ', { docId });
            return false;
        }
        const doc = snap.data();
        if (doc?.ownerId !== expectedOwnerId) {
            logger.warn('所有者が異なる文書の完成をスキップ', { docId });
            return false;
        }
        if (doc.status !== 'processing') {
            logger.warn('処理中でない文書の完成をスキップ', { docId });
            return false;
        }
        tx.set(ref, {
            transcription,
            generatedByModel,
            status: 'completed' satisfies TranscriptionDocStatus,
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return true;
    });
    if (completed) logger.info('文書を完成', { docId, chars: transcription.length });
}

/**
 * 失敗: 文書は消さず、理由を本文に残して status を failed にする（件数だけの警報にしない）。
 * 🔴 「何も無い」より「なぜ失敗したかが読める」方が利用者にとって良い（L2-D1・設計 §4.4）。
 */
export async function failTranscriptionDocument(docId: string, reason: string, expectedOwnerId: string): Promise<void> {
    const db = getAdminFirestore();
    const ref = db.collection(TRANSCRIPTIONS_COLLECTION).doc(docId);
    const failed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
            logger.warn('削除済みの文書の失敗更新をスキップ', { docId });
            return false;
        }
        const doc = snap.data();
        if (doc?.ownerId !== expectedOwnerId) {
            logger.warn('所有者が異なる文書の失敗更新をスキップ', { docId });
            return false;
        }
        if (doc.status !== 'processing') {
            logger.warn('処理中でない文書の失敗更新をスキップ', { docId });
            return false;
        }
        tx.set(ref, {
            transcription: `文字起こしに失敗しました。\n\n理由: ${reason}\n\nお手数ですが、もう一度お試しください。`,
            status: 'failed' satisfies TranscriptionDocStatus,
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return true;
    });
    if (failed) logger.warn('文書を失敗として記録', { docId, reason: reason.slice(0, 200) });
}
