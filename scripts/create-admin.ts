/**
 * 初回管理者を作成するスクリプト
 * 
 * 使用方法:
 * 1. まず対象ユーザーでサインアップしてください
 * 2. Firebase Authentication で UID を確認
 * 3. 以下のコマンドで管理者権限を付与:
 *    npx tsx scripts/create-admin.ts YOUR_USER_UID
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

interface FirestoreUserData {
    uid: string;
    email: string;
    superuser: boolean;
    createdAt: admin.firestore.FieldValue;
    lastLoginAt: admin.firestore.FieldValue;
    promptCount: number;
    documentCount: number;
    displayName?: string;
}

interface ErrorWithCode {
    code?: string;
}

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

// コマンドライン引数からUIDを取得
const userUid = process.argv[2];

if (!userUid) {
    console.error('❌ エラー: ユーザーUIDを指定してください。\n');
    console.error('使用方法:');
    console.error('  npx tsx scripts/create-admin.ts YOUR_USER_UID\n');
    console.error('📝 UIDの確認方法:');
    console.error('1. Firebase Console > Authentication');
    console.error('2. ユーザー一覧で対象ユーザーのUIDをコピー\n');
    process.exit(1);
}

// Firebase Admin SDKの初期化
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function createAdmin() {
    console.log('🚀 管理者作成スクリプトを開始します...\n');
    console.log(`対象UID: ${userUid}\n`);

    try {
        // Firebase Authentication でユーザーが存在するか確認
        const authUser = await admin.auth().getUser(userUid);
        console.log('✅ Firebase Authentication でユーザーが見つかりました:');
        console.log(`   - Email: ${authUser.email}`);
        console.log(`   - DisplayName: ${authUser.displayName || '(未設定)'}\n`);

        // Firestore の users コレクションを確認
        const userRef = db.collection('users').doc(userUid);
        const userDoc = await userRef.get();

        if (userDoc.exists) {
            console.log('ℹ️  Firestore にユーザープロファイルが存在します。');
            console.log('   superuser フラグを更新します...\n');

            await userRef.update({
                superuser: true,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        } else {
            console.log('ℹ️  Firestore にユーザープロファイルが存在しません。');
            console.log('   新規作成します...\n');

            // undefined を避けるため、データを構築
            const userData: FirestoreUserData = {
                uid: userUid,
                email: authUser.email || '',
                superuser: true,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
                promptCount: 0,
                documentCount: 0,
            };

            // displayName がある場合のみ追加
            if (authUser.displayName) {
                userData.displayName = authUser.displayName;
            }

            await userRef.set(userData);
        }

        console.log('✅ 管理者権限の付与が完了しました！\n');
        console.log('📋 確認事項:');
        console.log('1. Firebase Console で users コレクションを確認');
        console.log('2. アプリにログインして /admin にアクセス');
        console.log('3. 管理者画面が表示されることを確認\n');

    } catch (error) {
        console.error('❌ エラーが発生しました:', error);
        if (isErrorWithCode(error) && error.code === 'auth/user-not-found') {
            console.error('\n💡 ヒント:');
            console.error('- 対象ユーザーが Firebase Authentication に存在することを確認してください');
            console.error('- Firebase Console > Authentication でUIDを確認してください\n');
        }
        process.exit(1);
    }
}

createAdmin().then(() => {
    console.log('👋 スクリプトを終了します。');
    process.exit(0);
}).catch((error) => {
    console.error('❌ 予期しないエラー:', error);
    process.exit(1);
});

function isErrorWithCode(error: unknown): error is ErrorWithCode {
    return typeof error === 'object' && error !== null && 'code' in error;
}

