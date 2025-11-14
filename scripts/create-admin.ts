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
import { createLogger } from '../src/lib/logger';

const scriptLogger = createLogger('create-admin');

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
    scriptLogger.error('serviceAccountKey.json が見つかりません');
    scriptLogger.error('📖 セットアップ手順:');
    scriptLogger.error('1. Firebase Console にアクセス');
    scriptLogger.error('2. プロジェクト設定 > サービスアカウント');
    scriptLogger.error('3. 「新しい秘密鍵の生成」をクリック');
    scriptLogger.error('4. ダウンロードしたJSONファイルをプロジェクトルートに配置');
    scriptLogger.error('5. ファイル名を "serviceAccountKey.json" に変更');
    process.exit(1);
}

// コマンドライン引数からUIDを取得
const userUid = process.argv[2];

if (!userUid) {
    scriptLogger.error('ユーザーUIDを指定してください');
    scriptLogger.error('使用方法: npx tsx scripts/create-admin.ts YOUR_USER_UID');
    scriptLogger.error('UIDの確認方法:');
    scriptLogger.error('1. Firebase Console > Authentication');
    scriptLogger.error('2. ユーザー一覧で対象ユーザーのUIDをコピー');
    process.exit(1);
}

// Firebase Admin SDKの初期化
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function createAdmin() {
    scriptLogger.info('管理者作成スクリプトを開始');
    scriptLogger.info(`対象UID: ${userUid}`);

    try {
        // Firebase Authentication でユーザーが存在するか確認
        const authUser = await admin.auth().getUser(userUid);
        scriptLogger.info('Firebase Authentication でユーザーが見つかりました', {
            email: authUser.email,
            displayName: authUser.displayName || '(未設定)',
        });

        // Firestore の users コレクションを確認
        const userRef = db.collection('users').doc(userUid);
        const userDoc = await userRef.get();

        if (userDoc.exists) {
            scriptLogger.info('Firestore にユーザープロファイルが存在するため superuser を更新');

            await userRef.update({
                superuser: true,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        } else {
            scriptLogger.info('Firestore にユーザープロファイルが存在しません。新規作成します');

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

        scriptLogger.info('管理者権限の付与が完了しました');
        scriptLogger.info('確認事項:');
        scriptLogger.info('1. Firebase Console で users コレクションを確認');
        scriptLogger.info('2. アプリにログインして /admin にアクセス');
        scriptLogger.info('3. 管理者画面が表示されることを確認');

    } catch (error) {
        scriptLogger.error('エラーが発生しました', error);
        if (isErrorWithCode(error) && error.code === 'auth/user-not-found') {
            scriptLogger.error('対象ユーザーが Firebase Authentication に存在するか確認してください');
            scriptLogger.error('Firebase Console > Authentication でUIDを確認してください');
        }
        process.exit(1);
    }
}

createAdmin().then(() => {
    scriptLogger.info('スクリプトを終了します');
    process.exit(0);
}).catch((error) => {
    scriptLogger.error('予期しないエラーが発生しました', error);
    process.exit(1);
});

function isErrorWithCode(error: unknown): error is ErrorWithCode {
    return typeof error === 'object' && error !== null && 'code' in error;
}

