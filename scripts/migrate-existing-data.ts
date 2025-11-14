/**
 * 既存データを認証対応に移行するスクリプト
 * 
 * このスクリプトは、認証機能実装前に作成されたデータに
 * ownerType, ownerId, createdBy フィールドを追加します。
 * 
 * 前提条件:
 * 1. firebase-admin パッケージがインストールされていること
 *    npm install -D firebase-admin
 * 
 * 2. Firebase プロジェクトのサービスアカウントキーを取得
 *    - Firebase Console > プロジェクト設定 > サービスアカウント
 *    - 「新しい秘密鍵の生成」をクリック
 *    - ダウンロードしたJSONファイルをプロジェクトルートに配置
 *    - ファイル名を `serviceAccountKey.json` に変更
 * 
 * 実行方法:
 * npx tsx scripts/migrate-existing-data.ts
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../src/lib/logger';

const migrateLogger = createLogger('migrate-data');

// サービスアカウントキーのパス
const serviceAccountPath = path.join(process.cwd(), 'serviceAccountKey.json');

// サービスアカウントキーの存在確認
if (!fs.existsSync(serviceAccountPath)) {
    migrateLogger.error('serviceAccountKey.json が見つかりません');
    migrateLogger.error('セットアップ手順:');
    migrateLogger.error('1. Firebase Console にアクセス');
    migrateLogger.error('2. プロジェクト設定 > サービスアカウント');
    migrateLogger.error('3. 「新しい秘密鍵の生成」をクリック');
    migrateLogger.error('4. ダウンロードしたJSONファイルをプロジェクトルートに配置');
    migrateLogger.error('5. ファイル名を "serviceAccountKey.json" に変更');
    process.exit(1);
}

// Firebase Admin SDKの初期化
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function migrateCollection(collectionName: string) {
    migrateLogger.info(`${collectionName} コレクションの移行を開始`);

    const snapshot = await db.collection(collectionName).get();
    let migratedCount = 0;
    let skippedCount = 0;

    if (snapshot.empty) {
        migrateLogger.info(`${collectionName} コレクションにデータがありません`);
        return;
    }

    for (const docSnapshot of snapshot.docs) {
        const data = docSnapshot.data();

        // 既に ownerType が設定されている場合はスキップ
        if (data.ownerType) {
            skippedCount++;
            migrateLogger.info(`${docSnapshot.id} はスキップ（既に移行済み）`);
            continue;
        }

        try {
            await db.collection(collectionName).doc(docSnapshot.id).update({
                ownerType: 'guest',
                ownerId: 'GUEST',
                createdBy: 'GUEST',
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            migratedCount++;
            migrateLogger.info(`${docSnapshot.id} を移行しました`);
        } catch (error) {
            migrateLogger.error(`${docSnapshot.id} の移行に失敗`, error);
        }
    }

    migrateLogger.info(`${collectionName} の移行完了`, {
        migratedCount,
        skippedCount,
        total: snapshot.size,
    });
}

async function main() {
    migrateLogger.info('データ移行スクリプトを開始');
    migrateLogger.info('注意: このスクリプトは既存のデータを変更します。本番環境で実行する前にバックアップを取得してください');

    // 5秒待機（誤実行防止）
    migrateLogger.info('5秒後に開始します');
    await new Promise(resolve => setTimeout(resolve, 5000));

    try {
        // プロンプトの移行
        await migrateCollection('prompts');

        // 文書の移行
        await migrateCollection('transcriptions');

        migrateLogger.info('すべての移行が完了しました');
    } catch (error) {
        migrateLogger.error('移行中にエラーが発生しました', error);
        process.exit(1);
    }
}

// スクリプトの実行
main().then(() => {
    migrateLogger.info('スクリプトを終了します');
    process.exit(0);
}).catch((error) => {
    migrateLogger.error('予期しないエラーが発生しました', error);
    process.exit(1);
});

