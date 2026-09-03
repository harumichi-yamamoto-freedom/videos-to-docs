/**
 * firebase-admin の遅延初期化 (プロセス内で 1 回だけ)。
 *
 * 資格情報:
 *   - `FIREBASE_SERVICE_ACCOUNT_JSON` があればサービスアカウント JSON (そのまま 1 行 or base64) を cert() に渡す。
 *   - 無ければ Application Default Credentials (ローカル開発・エミュレータ用)。
 *
 * エミュレータ: `FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` / `FIREBASE_STORAGE_EMULATOR_HOST`
 * が環境にあれば admin SDK が自動でそちらを向くため、ここで特別扱いはしない (projectId だけ合わせればよい)。
 */
import { applicationDefault, cert, getApps, initializeApp, type App, type Credential } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { createLogger } from '@/lib/logger';
import { GenerateApiError } from './errors';

const logger = createLogger('firebaseAdmin');

/** 複数の App と衝突しないよう名前を固定する (既定 app 名は firebase CLI 等が使うことがある) */
export const ADMIN_APP_NAME = 'videos-to-docs-server';

const NOT_CONFIGURED_MESSAGE =
    'サーバの設定が完了していません (Firebase 管理資格情報)。管理者に連絡してください。';

let cachedApp: App | null = null;

/** 判別は運用文書 (docs/api-generate.md) と同じ: 値が `{` で始まれば JSON 文字列、それ以外は base64 とみなして decode */
export function parseServiceAccountJson(raw: string): Record<string, unknown> {
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON が空です');
    }
    const text = trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new Error(
            trimmed.startsWith('{')
                ? 'FIREBASE_SERVICE_ACCOUNT_JSON を JSON として解釈できません'
                : 'FIREBASE_SERVICE_ACCOUNT_JSON を base64 → JSON として解釈できません',
            { cause: error },
        );
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON がオブジェクトではありません');
    }
    return value as Record<string, unknown>;
}

function buildCredential(): Credential {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (raw && raw.trim()) {
        const serviceAccount = parseServiceAccountJson(raw);
        logger.info('firebase-admin をサービスアカウント JSON で初期化', {
            projectId: serviceAccount.project_id,
            clientEmail: serviceAccount.client_email,
        });
        return cert(serviceAccount);
    }
    logger.info('firebase-admin を Application Default Credentials で初期化', {
        firestoreEmulator: process.env.FIRESTORE_EMULATOR_HOST,
        authEmulator: process.env.FIREBASE_AUTH_EMULATOR_HOST,
        storageEmulator: process.env.FIREBASE_STORAGE_EMULATOR_HOST,
    });
    return applicationDefault();
}

/** 初期化済みの admin App を返す (初回だけ initializeApp)。資格情報が壊れていれば 503 not_configured */
export function getAdminApp(): App {
    if (cachedApp) return cachedApp;

    const existing = getApps().find(app => app.name === ADMIN_APP_NAME);
    if (existing) {
        cachedApp = existing;
        return existing;
    }

    try {
        cachedApp = initializeApp(
            {
                credential: buildCredential(),
                projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
                storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
            },
            ADMIN_APP_NAME,
        );
        return cachedApp;
    } catch (error) {
        logger.error('firebase-admin の初期化に失敗', error);
        throw new GenerateApiError('not_configured', NOT_CONFIGURED_MESSAGE, { cause: error });
    }
}

export const getAdminAuth = (): Auth => getAuth(getAdminApp());

export const getAdminFirestore = (): Firestore => getFirestore(getAdminApp());

/** `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` の bucket。未設定なら 503 not_configured */
export function getAdminBucket() {
    const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
    if (!bucketName) {
        logger.error('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET が未設定');
        throw new GenerateApiError('not_configured', NOT_CONFIGURED_MESSAGE);
    }
    return getStorage(getAdminApp()).bucket(bucketName);
}

/** テスト専用: キャッシュを捨てて次回 getAdminApp で初期化し直す */
export function resetAdminAppForTests(): void {
    cachedApp = null;
}
