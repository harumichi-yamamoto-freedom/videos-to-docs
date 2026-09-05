/**
 * storagePath の形式検査・所有権判定・Storage からの取得。
 * 形式は `audio/{ownerId}/{name}` (storage.rules の match と同じ 2 段) で、それ以外は 400。
 */
import { GENERATE_MAX_MEDIA_BYTES, GENERATE_SYNC_MAX_MEDIA_BYTES } from '@/lib/generateApiContract';
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

/** 上限の表示用。既存の表記に合わせて 1MB = 1024*1024 バイトで切り捨てる */
const limitMb = (bytes: number): number => Math.floor(bytes / 1024 / 1024);

/**
 * 上限超のときに利用者へ見せる文。**経路ごとに「次に何ができるか」が違う**ので呼び出し側が決める。
 * (同期の文書生成を超えただけなら全文文字起こしは使えるが、バッチ経路の上限を超えたときは使えない)
 */
export type TooLargeMessage = (sizeBytes: number, maxBytes: number) => string;

const defaultTooLargeMessage: TooLargeMessage = (_sizeBytes, maxBytes) =>
    `ファイルが大きすぎます (上限 ${limitMb(maxBytes)}MB)。ビットレートを下げるか、ファイルを分割してから再試行してください。`;

/**
 * 同期の文書生成の上限 (GENERATE_SYNC_MAX_MEDIA_BYTES) を超えたときの文。
 * 🔴 「アップロードできない」と誤読させないこと: このサイズでも **全文文字起こしは動く**
 *    (非同期バッチは署名 URL 経由で、サーバは本文をメモリに載せない)。止まるのは文書生成だけ。
 * サイズは切り上げる。切り捨てだと 200MB をわずかに超えたファイルが
 * 「約200MB で、上限 200MB を超えています」と矛盾して読める。
 */
export const syncGenerateTooLargeMessage: TooLargeMessage = (sizeBytes, maxBytes) =>
    `このファイルは 約${Math.ceil(sizeBytes / 1024 / 1024)}MB で、議事録などの文書生成に送れる上限 ${limitMb(maxBytes)}MB を超えています。`
    + '全文文字起こしはこのままご利用いただけます。'
    + '文書生成も必要な場合は、ビットレートを下げるか録音を分割してから、もう一度お試しください。';

const toSizeBytes = (value: unknown): number => {
    const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
    return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * 存在とサイズだけ確認する (本文は取らない)。無ければ 404、上限超なら 413。
 * 🔴 `maxBytes` と文言を渡せる。**上限は経路ごとに違う**:
 *    - 同期の文書生成 (Gemini): 200MB (GENERATE_SYNC_MAX_MEDIA_BYTES)。本文を丸ごとメモリに載せるため。
 *    - 非同期バッチ (Azure): 1GB (AZURE_BATCH_MAX_AUDIO_BYTES)。署名 URL を渡すだけなので大きくてよい。
 *    既定は Storage 側の上限 (GENERATE_MAX_MEDIA_BYTES = 500MB) ＝ storage.rules を超える物は無いという
 *    最後の網でしかない。経路の上限は呼び出し側が明示すること。
 */
export async function statMedia(
    storagePath: string,
    maxBytes: number = GENERATE_MAX_MEDIA_BYTES,
    tooLargeMessage: TooLargeMessage = defaultTooLargeMessage,
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
        throw new GenerateApiError('media_too_large', tooLargeMessage(sizeBytes, maxBytes));
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

/**
 * 本文を Buffer で取る。ダウンロード後のサイズも再検査する (メタと実体がずれた時の保険)。
 * 🔴 ここは **メディア全体をサーバのメモリに載せる唯一の経路**。既定の上限は Storage 側の 500MB ではなく
 *    同期の文書生成用 (GENERATE_SYNC_MAX_MEDIA_BYTES)。ここに 500MB を持ち込むと OOM になる。
 */
export async function downloadMedia(
    info: MediaObjectInfo,
    maxBytes: number = GENERATE_SYNC_MAX_MEDIA_BYTES,
    tooLargeMessage: TooLargeMessage = syncGenerateTooLargeMessage,
): Promise<FetchedMedia> {
    const file = getAdminBucket().file(info.storagePath);
    const [bytes] = await file.download();
    if (bytes.length > maxBytes) {
        logger.warn('ダウンロード後のサイズが上限超', {
            storagePath: info.storagePath, sizeBytes: bytes.length, limit: maxBytes,
        });
        throw new GenerateApiError('media_too_large', tooLargeMessage(bytes.length, maxBytes));
    }
    logger.info('Storage からメディアを取得', {
        storagePath: info.storagePath,
        sizeBytes: bytes.length,
        contentType: info.contentType,
    });
    return { ...info, sizeBytes: bytes.length, bytes };
}
