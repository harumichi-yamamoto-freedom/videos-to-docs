import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, setPersistence, browserLocalPersistence } from 'firebase/auth';

// Firebase設定（環境変数から読み込み）
const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Firebaseアプリの初期化（既に初期化されている場合は再利用）
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Firestoreインスタンスをエクスポート
export const db = getFirestore(app);

// Firebase Authenticationインスタンスをエクスポート
export const auth = getAuth(app);

// 認証状態をローカルストレージに永続化（タブ跨ぎ保持）
if (typeof window !== 'undefined') {
    setPersistence(auth, browserLocalPersistence).catch((error) => {
        console.error('認証永続化設定エラー:', error);
    });
}

