/**
 * アカウント削除時の関連データクリーンアップ
 */

import { db } from './firebase';
import { collection, query, where, getDocs, doc, writeBatch } from 'firebase/firestore';
import { logAudit } from './auditLog';
import { createLogger } from './logger';

const accountDeletionLogger = createLogger('accountDeletion');

/**
 * ユーザーに関連するすべてのFirestoreデータを削除
 */
export async function deleteUserData(userId: string, userEmail?: string): Promise<void> {
    try {
        accountDeletionLogger.info('ユーザー関連データの削除を開始', { userId });

        // 監査ログを記録（削除前）
        await logAudit('user_delete', 'user', userId, {
            userEmail: userEmail || '',
            dataCleanup: true
        });

        const batch = writeBatch(db);
        let totalDeleted = 0;

        // 1. プロンプトを削除
        const promptsQuery = query(
            collection(db, 'prompts'),
            where('ownerId', '==', userId)
        );
        const promptsSnapshot = await getDocs(promptsQuery);
        promptsSnapshot.forEach((doc) => {
            batch.delete(doc.ref);
            totalDeleted++;
        });
        accountDeletionLogger.info('プロンプトの削除対象を検出', {
            userId,
            prompts: promptsSnapshot.size,
        });

        // 2. 文書を削除
        const transcriptionsQuery = query(
            collection(db, 'transcriptions'),
            where('ownerId', '==', userId)
        );
        const transcriptionsSnapshot = await getDocs(transcriptionsQuery);
        transcriptionsSnapshot.forEach((doc) => {
            batch.delete(doc.ref);
            totalDeleted++;
        });
        accountDeletionLogger.info('文書の削除対象を検出', {
            userId,
            documents: transcriptionsSnapshot.size,
        });

        // 3. リレーションシップを削除
        const relationshipsCol = collection(db, 'relationships');
        const relationshipIds = new Set<string>();

        const supervisorQuery = query(relationshipsCol, where('supervisorId', '==', userId));
        const supervisorSnapshot = await getDocs(supervisorQuery);
        supervisorSnapshot.forEach((docSnap) => {
            if (relationshipIds.has(docSnap.id)) return;
            relationshipIds.add(docSnap.id);
            batch.delete(docSnap.ref);
            totalDeleted++;
        });

        const subordinateQuery = query(relationshipsCol, where('subordinateId', '==', userId));
        const subordinateSnapshot = await getDocs(subordinateQuery);
        subordinateSnapshot.forEach((docSnap) => {
            if (relationshipIds.has(docSnap.id)) return;
            relationshipIds.add(docSnap.id);
            batch.delete(docSnap.ref);
            totalDeleted++;
        });
        accountDeletionLogger.info('リレーションシップの削除対象を検出', {
            userId,
            relationships: relationshipIds.size,
        });

        // 4. ユーザープロファイルを削除
        const userRef = doc(db, 'users', userId);
        batch.delete(userRef);
        totalDeleted++;
        accountDeletionLogger.info('ユーザープロファイルを削除対象に追加', { userId });

        // バッチコミット（一括削除）
        await batch.commit();
        accountDeletionLogger.info('関連データの削除が完了', {
            userId,
            totalDeleted,
        });

    } catch (error) {
        accountDeletionLogger.error('ユーザー関連データの削除に失敗', error, { userId });
        throw new Error('関連データの削除に失敗しました');
    }
}

/**
 * アカウント削除前の確認情報を取得
 */
export async function getUserDeletionInfo(userId: string): Promise<{
    promptCount: number;
    documentCount: number;
}> {
    try {
        // プロンプト数を取得
        const promptsQuery = query(
            collection(db, 'prompts'),
            where('ownerId', '==', userId)
        );
        const promptsSnapshot = await getDocs(promptsQuery);

        // 文書数を取得
        const transcriptionsQuery = query(
            collection(db, 'transcriptions'),
            where('ownerId', '==', userId)
        );
        const transcriptionsSnapshot = await getDocs(transcriptionsQuery);

        return {
            promptCount: promptsSnapshot.size,
            documentCount: transcriptionsSnapshot.size,
        };
    } catch (error) {
        accountDeletionLogger.error('削除前情報の取得に失敗', error, { userId });
        return {
            promptCount: 0,
            documentCount: 0,
        };
    }
}

