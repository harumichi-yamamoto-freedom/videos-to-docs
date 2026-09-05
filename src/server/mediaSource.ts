/**
 * storagePath の形式検査・所有権判定・Storage からの取得。
 * 形式は `audio/{ownerId}/{name}` (storage.rules の match と同じ 2 段) で、それ以外は 400。
 */
import { GENERATE_MAX_MEDIA_BYTES } from '@/lib/generateApiContract';
import { createLogger } from '@/lib/logger';
import { GUEST_OWNER_ID, type RequestSubject } from './auth';
import { GenerateApiError } from './errors';
import { getAdminBucket } from './firebaseAdmin';

const logger = createLogger('server/mediaSource');

export interface ParsedStoragePath {
    ownerId: string;
    name: string;
}

/** 1 セグメントとして許す文字: 空・`.`・`..`・区切り (/ \)・制御文字・NUL を拒否 */
const SEGMENT_PATTERN = /^[^\x00-\x1f\x7f/\\]+$/;

const isSafeSegment = (segment: string): boolean =>
    SEGMENT_PATTERN.test(segment) && segment !== '.' && segment !== '..';

/** `audio/{ownerId}/{name}` を分解する。形式外 (段数違い・パストラバーサル・空セグメント) は null */
export function parseStoragePath(storagePath: string): ParsedStoragePath | null {
    if (typeof storagePath !== 'string' || storagePath.length === 0 || storagePath.length > 1024) {
        return null;
    }
    const segments = storagePath.split('/');
    if (segments.length !== 3 || segments[0] !== 'audio') {
        return null;
    }
    const [, ownerId, name] = segments;
    if (!isSafeSegment(ownerId) || !isSafeSegment(name)) {
        return null;
    }
    return { ownerId, name };
}

/** ログイン中は自分の uid のディレクトリだけ、未ログインは GUEST だけ (ログイン中の GUEST 参照も不可) */
export function isOwnedBySubject(ownerId: string, subject: RequestSubject): boolean {
    return subject.kind === 'user'
        ? ownerId === subject.uid
        : ownerId === GUEST_OWNER_ID;
}

export interface MediaObjectInfo {
    storagePath: string;
    sizeBytes: number;
    /** Storage 上の contentType (ブラウザは動画も audio/mpeg で上げるので Gemini へ渡す種別ではない) */
    contentType?: string;
}

export interface FetchedMedia extends MediaObjectInfo {
    bytes: Buffer;
}

const NOT_FOUND_MESSAGE =
    'ファイルが見つかりません。アップロードをやり直して、もう一度変換してください。';
const TOO_LARGE_MESSAGE =
    `ファイルが大きすぎます (上限 ${Math.floor(GENERATE_MAX_MEDIA_BYTES / 1024 / 1024)}MB)。ビットレートを下げるか、ファイルを分割してから再試行してください。`;

const toSizeBytes = (value: unknown): number => {
    const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
    return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * 存在とサイズだけ確認する (本文は取らない)。無ければ 404、上限超なら 413。
 * 🔴 `maxBytes` を渡せる。同期経路は 100MB (GENERATE_MAX_MEDIA_BYTES)、
 *    非同期バッチ経路は Azure の 1GB (AZURE_BATCH_MAX_AUDIO_BYTES) と、上限が違うため。
 */
export async function statMedia(
    storagePath: string,
    maxBytes: number = GENERATE_MAX_MEDIA_BYTES,
): Promise<MediaObjectInfo> {
    const file = getAdminBucket().file(storagePath);
    const [exists] = await file.exists();
    if (!exists) {
        logger.warn('Storage にファイルが無い', { storagePath });
        throw new GenerateApiError('media_not_found', NOT_FOUND_MESSAGE);
    }
    const [metadata] = await file.getMetadata();
    const sizeBytes = toSizeBytes(metadata?.size);
    const contentType = typeof metadata?.contentType === 'string' ? metadata.contentType : undefined;
    if (sizeBytes > maxBytes) {
        logger.warn('Storage 上のファイルが上限超', { storagePath, sizeBytes, limit: maxBytes });
        throw new GenerateApiError('media_too_large',
            `ファイルが大きすぎます (上限 ${Math.floor(maxBytes / 1024 / 1024)}MB)。`);
    }
    return { storagePath, sizeBytes, contentType };
}

/**
 * Azure が音声を取得するための **署名付き読み取り URL** を作る（v4）。
 * 🔴 非同期バッチは音声を URL で受け取る。Firebase Storage の署名 URL を Azure が fetch する。
 *    鍵ではなく期限つきの URL なので、TTL を短く保つ（ジョブ完了までの数十分で十分）。
 */
export async function getSignedReadUrl(storagePath: string, ttlMs: number): Promise<string> {
    const file = getAdminBucket().file(storagePath);
    const [url] = await file.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + ttlMs,
    });
    return url;
}

/** 本文を Buffer で取る。ダウンロード後のサイズも再検査する (メタと実体がずれた時の保険) */
export async function downloadMedia(info: MediaObjectInfo): Promise<FetchedMedia> {
    const file = getAdminBucket().file(info.storagePath);
    const [bytes] = await file.download();
    if (bytes.length > GENERATE_MAX_MEDIA_BYTES) {
        logger.warn('ダウンロード後のサイズが上限超', { storagePath: info.storagePath, sizeBytes: bytes.length });
        throw new GenerateApiError('media_too_large', TOO_LARGE_MESSAGE);
    }
    logger.info('Storage からメディアを取得', {
        storagePath: info.storagePath,
        sizeBytes: bytes.length,
        contentType: info.contentType,
    });
    return { ...info, sizeBytes: bytes.length, bytes };
}
