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

// サービスアカウントキーのパス
const serviceAccountPath = path.join(process.cwd(), 'serviceAccountKey.json');

// サービスアカウントキーの存在確認
if (!fs.existsSync(serviceAccountPath)) {
    console.error('❌ エラー: serviceAccountKey.json が見つかりません。');
    console.error('\n📖 セットアップ手順:');
    console.error('1. Firebase Console にアクセス');
    console.error('2. プロジェクト設定 > サービスアカウント');
    console.error('3. 「新しい秘密鍵の生成」をクリック');
    console.error('4. ダウンロードしたJSONファイルをプロジェクトルートに配置');
    console.error('5. ファイル名を "serviceAccountKey.json" に変更\n');
    process.exit(1);
}

// Firebase Admin SDKの初期化
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function migrateCollection(collectionName: string) {
    console.log(`\n📦 ${collectionName} コレクションの移行を開始...`);

    const snapshot = await db.collection(collectionName).get();
    let migratedCount = 0;
    let skippedCount = 0;

    if (snapshot.empty) {
        console.log(`  ℹ️  ${collectionName} コレクションにデータがありません`);
        return;
    }

    for (const docSnapshot of snapshot.docs) {
        const data = docSnapshot.data();

        // 既に ownerType が設定されている場合はスキップ
        if (data.ownerType) {
            skippedCount++;
            console.log(`  ⏭️  ${docSnapshot.id} はスキップ（既に移行済み）`);
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
            console.log(`  ✅ ${docSnapshot.id} を移行しました`);
        } catch (error) {
            console.error(`  ❌ ${docSnapshot.id} の移行に失敗:`, error);
        }
    }

    console.log(`\n✨ ${collectionName} の移行完了:`);
    console.log(`   - 移行済み: ${migratedCount}件`);
    console.log(`   - スキップ: ${skippedCount}件`);
    console.log(`   - 合計: ${snapshot.size}件`);
}

async function main() {
    console.log('🚀 データ移行スクリプトを開始します...\n');
    console.log('⚠️  注意: このスクリプトは既存のデータを変更します。');
    console.log('   本番環境で実行する前に、必ずバックアップを取ってください。\n');

    // 5秒待機（誤実行防止）
    console.log('5秒後に開始します...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    try {
        // プロンプトの移行
        await migrateCollection('prompts');

        // 文書の移行
        await migrateCollection('transcriptions');

        console.log('\n🎉 すべての移行が完了しました！');
    } catch (error) {
        console.error('\n❌ 移行中にエラーが発生しました:', error);
        process.exit(1);
    }
}

// スクリプトの実行
main().then(() => {
    console.log('\n👋 スクリプトを終了します。');
    process.exit(0);
}).catch((error) => {
    console.error('\n❌ 予期しないエラーが発生しました:', error);
    process.exit(1);
});

