/**
 * 呼び出し主体の解決。`Authorization: Bearer <Firebase ID token>` があれば firebase-admin で検証して uid、
 * ヘッダが無ければ GUEST (未ログイン利用は製品仕様)。ヘッダがあって無効なら 401。
 */
import { GENERATE_AUTH_HEADER } from '@/lib/generateApiContract';
import { createLogger } from '@/lib/logger';
import { GenerateApiError } from './errors';
import { getAdminAuth } from './firebaseAdmin';

const logger = createLogger('server/auth');

export type RequestSubject =
    | { kind: 'guest' }
    | { kind: 'user'; uid: string };

/** Storage 上の未ログイン利用者のディレクトリ名 (storage.rules の "GUEST" と一致) */
export const GUEST_OWNER_ID = 'GUEST';

const UNAUTHORIZED_MESSAGE =
    'ログイン情報が無効か期限切れです。ページを再読み込みして、もう一度ログインしてから再試行してください。';

/** ヘッダ値から Bearer トークンを取り出す。ヘッダ無し → null、形式不正 → '' (呼び出し側で 401) */
export function extractBearerToken(headerValue: string | null): string | null {
    if (headerValue === null) return null;
    const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(headerValue);
    return match ? match[1] : '';
}

export async function resolveRequestSubject(headers: Headers): Promise<RequestSubject> {
    const token = extractBearerToken(headers.get(GENERATE_AUTH_HEADER));
    if (token === null) {
        return { kind: 'guest' };
    }
    if (!token) {
        logger.warn('Authorization ヘッダの形式が不正 (Bearer <token> ではない)');
        throw new GenerateApiError('unauthorized', UNAUTHORIZED_MESSAGE);
    }
    try {
        const decoded = await getAdminAuth().verifyIdToken(token);
        return { kind: 'user', uid: decoded.uid };
    } catch (error) {
        if (error instanceof GenerateApiError) throw error;
        logger.warn('ID トークンの検証に失敗', {
            error: error instanceof Error ? error.message : String(error),
        });
        throw new GenerateApiError('unauthorized', UNAUTHORIZED_MESSAGE, { cause: error });
    }
}
