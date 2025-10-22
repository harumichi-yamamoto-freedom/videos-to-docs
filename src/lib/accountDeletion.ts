/**
 * アカウント削除時の関連データクリーンアップ
 */

import { db } from './firebase';
import { collection, query, where, getDocs, deleteDoc, doc, writeBatch } from 'firebase/firestore';
import { logAudit } from './auditLog';

/**
 * ユーザーに関連するすべてのFirestoreデータを削除
 */
export async function deleteUserData(userId: string, userEmail?: string): Promise<void> {
    try {
        console.log(`🗑️ ユーザー ${userId} のデータ削除を開始...`);

        // 監査ログを記録（削除前）
        await logAudit('user_delete', 'user', userId, {
            userEmail: userEmail || '',
            dataCleanup: true
        });

        const batch = writeBatch(db);
        let totalDeleted = 0;

        // 1. プロンプトを削除
        console.log('📝 プロンプトを削除中...');
        const promptsQuery = query(
            collection(db, 'prompts'),
            where('ownerId', '==', userId)
        );
        const promptsSnapshot = await getDocs(promptsQuery);
        promptsSnapshot.forEach((doc) => {
            batch.delete(doc.ref);
            totalDeleted++;
        });
        console.log(`   ✅ ${promptsSnapshot.size}件のプロンプトを削除予定`);

        // 2. 文書を削除
        console.log('📄 文書を削除中...');
        const transcriptionsQuery = query(
            collection(db, 'transcriptions'),
            where('ownerId', '==', userId)
        );
        const transcriptionsSnapshot = await getDocs(transcriptionsQuery);
        transcriptionsSnapshot.forEach((doc) => {
            batch.delete(doc.ref);
            totalDeleted++;
        });
        console.log(`   ✅ ${transcriptionsSnapshot.size}件の文書を削除予定`);

        // 3. ユーザープロファイルを削除
        console.log('👤 ユーザープロファイルを削除中...');
        const userRef = doc(db, 'users', userId);
        batch.delete(userRef);
        totalDeleted++;
        console.log('   ✅ ユーザープロファイルを削除予定');

        // バッチコミット（一括削除）
        console.log(`\n🔄 ${totalDeleted}件のドキュメントを削除中...`);
        await batch.commit();
        console.log('✅ すべてのデータ削除が完了しました');

    } catch (error) {
        console.error('❌ データ削除エラー:', error);
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
        console.error('削除情報取得エラー:', error);
        return {
            promptCount: 0,
            documentCount: 0,
        };
    }
}

