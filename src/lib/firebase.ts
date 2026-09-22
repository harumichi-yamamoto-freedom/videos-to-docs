import { initializeApp, getApps, getApp } from 'firebase/app';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectAuthEmulator, getAuth, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { connectStorageEmulator, getStorage } from 'firebase/storage';
import { createLogger } from './logger';

const firebaseLogger = createLogger('firebase');

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

// Firebase Storageインスタンスをエクスポート
export const storage = getStorage(app);

/**
 * ローカル開発・e2e 用: `NEXT_PUBLIC_FIREBASE_USE_EMULATOR=1` のときだけブラウザ側 SDK を
 * Firebase エミュレータへ向ける（README の `firebase emulators:start` はサーバ側 firebase-admin しか
 * 向いておらず、ブラウザは本番へ書いていた）。
 * 🔴 Vercel には絶対に設定しない。値は build 時にバンドルへ埋まるので、本番ビルドでは未設定 = 何もしない。
 * ホストは既定のエミュレータポート。変えるときは NEXT_PUBLIC_FIREBASE_EMULATOR_HOST（例 127.0.0.1）。
 */
if (process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR === '1' && typeof window !== 'undefined') {
    const host = process.env.NEXT_PUBLIC_FIREBASE_EMULATOR_HOST || '127.0.0.1';
    const marker = '__vtdEmulatorConnected';
    const scope = window as unknown as Record<string, boolean>;
    if (!scope[marker]) {
        scope[marker] = true;
        connectFirestoreEmulator(db, host, 8080);
        connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
        connectStorageEmulator(storage, host, 9199);
        firebaseLogger.warn('Firebase エミュレータに接続 (ローカル開発・e2e 用)', { host });
    }
}

// 認証状態をローカルストレージに永続化（タブ跨ぎ保持）
if (typeof window !== 'undefined') {
    setPersistence(auth, browserLocalPersistence).catch((error) => {
        firebaseLogger.error('認証永続化の設定に失敗', error);
    });
}

