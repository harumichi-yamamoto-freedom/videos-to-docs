/**
 * POST /api/transcribe/submit — 非同期バッチ文字起こしの**提出**（設計 §3.7 改訂・2026-09-05）。
 *
 * 短命な関数: 音声を分割せず、Azure バッチジョブを 1 本投げ、処理中の文書とジョブ状態を作って即返す。
 * 完了は /api/transcribe/status（poll）または webhook で拾う。Vercel 300 秒には当たらない。
 *
 * 検査順: 本文 → 主体(401) → 所有権(403) → Azure 設定(503) → Storage 存在/サイズ(404/413)
 *        → 音声長(400) → 時間あたり上限(429) → 署名URL → バッチ提出 → 文書/ジョブ作成 → 200。
 * 🔴 レートは **1 ジョブ 1 消費**（チャンク方式の最大 36 消費/商談を解消）。
 */
import { createLogger } from '@/lib/logger';
import {
    AZURE_BATCH_MAX_AUDIO_BYTES,
    AZURE_BATCH_MAX_AUDIO_SEC,
} from '@/lib/azureBatchContract';
import type {
    TranscribeSubmitRequest,
    TranscribeSubmitResponse,
    TranscribeBatchErrorBody,
} from '@/lib/transcribeBatchContract';
import { resolveRequestSubject } from '@/server/auth';
import { GenerateApiError } from '@/server/errors';
import { getSignedReadUrl, isOwnedBySubject, parseStoragePath, statMedia } from '@/server/mediaSource';
import { clientIpFromHeaders, enforceRateLimit } from '@/server/rateLimit';
import { getAzureCredentials, submitBatchJob } from '@/server/azureBatchTranscribe';
import { attachJobToDocument, createProcessingDocument } from '@/server/transcriptionDocument';
import { createTranscriptionJob } from '@/server/transcriptionJob';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const logger = createLogger('api/transcribe/submit');

/** Azure batch は完了まで最大24時間。長尺は内部再試行で音源取得が6時間を超え得るため、24時間有効にする。 */
const SIGNED_URL_TTL_MS = 24 * 60 * 60 * 1000;

const jsonResponse = (body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
    });

const errorResponse = (error: GenerateApiError): Response => {
    const body: TranscribeBatchErrorBody = {
        error: error.code,
        message: error.message,
        ...(error.retryAfterSec !== undefined && { retryAfterSec: error.retryAfterSec }),
    };
    const headers: Record<string, string> = error.retryAfterSec !== undefined
        ? { 'retry-after': String(error.retryAfterSec) }
        : {};
    return jsonResponse(body, error.status, headers);
};

const invalid = (message: string): GenerateApiError => new GenerateApiError('invalid_request', message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export function validateSubmitBody(raw: unknown): TranscribeSubmitRequest {
    const reload = 'ページを再読み込みして、もう一度お試しください。';
    if (!isRecord(raw)) throw invalid(`リクエストの形式が不正です。${reload}`);
    const { storagePath, fileName, mimeType, audioSec, promptName, title, originalFileType } = raw;
    if (typeof storagePath !== 'string' || !storagePath) throw invalid(`アップロード先の情報がありません。${reload}`);
    if (typeof fileName !== 'string' || !fileName) throw invalid(`ファイル名がありません。${reload}`);
    if (typeof mimeType !== 'string' || !mimeType) throw invalid(`ファイル種別がありません。${reload}`);
    if (typeof audioSec !== 'number' || !Number.isFinite(audioSec) || audioSec <= 0) {
        throw invalid(`音声の長さが取得できませんでした。${reload}`);
    }
    if (typeof promptName !== 'string' || !promptName) throw invalid(`プロンプト名がありません。${reload}`);
    if (typeof originalFileType !== 'string' || !originalFileType) throw invalid(`ファイル種別がありません。${reload}`);
    return {
        storagePath,
        fileName,
        mimeType,
        audioSec,
        promptName,
        originalFileType,
        ...(typeof title === 'string' && title ? { title } : {}),
    };
}

export async function POST(request: Request): Promise<Response> {
    const startedAt = Date.now();
    try {
        const body = validateSubmitBody(await request.json().catch(() => {
            throw invalid('リクエストの本文を読み取れませんでした。ページを再読み込みしてください。');
        }));

        const subject = await resolveRequestSubject(request.headers);

        const parsed = parseStoragePath(body.storagePath);
        if (!parsed) throw invalid('アップロード先の形式が不正です。ページを再読み込みしてください。');
        if (!isOwnedBySubject(parsed.ownerId, subject)) {
            throw new GenerateApiError('forbidden', 'このファイルを処理する権限がありません。');
        }

        const credentials = getAzureCredentials();
        if (!credentials) {
            throw new GenerateApiError('not_configured', '文字起こしが設定されていません。管理者にお問い合わせください。');
        }

        // 音声長の上限（Azure バッチ・話者分離有効時 240 分）
        if (body.audioSec > AZURE_BATCH_MAX_AUDIO_SEC) {
            throw invalid(`音声が長すぎます（上限 ${Math.floor(AZURE_BATCH_MAX_AUDIO_SEC / 60)} 分）。分割してお試しください。`);
        }

        // Storage 上のサイズ確認（バッチは 1GB まで）
        await statMedia(body.storagePath, AZURE_BATCH_MAX_AUDIO_BYTES);

        // 🔴 1 ジョブ 1 消費。チャンク方式の「1 試行 1 消費（最大 36/商談）」を解消。
        const rate = await enforceRateLimit(subject, clientIpFromHeaders(request.headers));

        // Azure が音声を取得するための署名付き URL（音声バイトは Firebase→Azure 直行・Vercel は通らない）
        const signedUrl = await getSignedReadUrl(body.storagePath, SIGNED_URL_TTL_MS);
        const { selfUrl } = await submitBatchJob(signedUrl, credentials, `vtd:${parsed.name}`);

        // 文書を先に作り一覧へ即出す → ジョブ状態を残す（タブ非依存）
        const ownerType = subject.kind === 'user' ? 'user' : 'guest';
        const docId = await createProcessingDocument({
            ownerId: parsed.ownerId,
            ownerType,
            fileName: body.fileName,
            promptName: body.promptName,
            originalFileType: body.originalFileType,
            audioStoragePath: body.storagePath,
            ...(body.title ? { title: body.title } : {}),
        });
        const jobId = await createTranscriptionJob({
            ownerId: parsed.ownerId,
            ownerType,
            docId,
            azureSelfUrl: selfUrl,
            audioSec: body.audioSec,
            storagePath: body.storagePath,
            promptName: body.promptName,
        });
        await attachJobToDocument(docId, jobId, parsed.ownerId);

        console.log(JSON.stringify({
            event: 'transcribe.submit',
            jobId, docId, audioSec: body.audioSec, subjectKind: subject.kind,
            rateCount: rate.count, rateLimit: rate.limit, elapsedMs: Date.now() - startedAt,
        }));

        const response: TranscribeSubmitResponse = { jobId, docId };
        return jsonResponse(response, 200);
    } catch (error) {
        if (error instanceof GenerateApiError) {
            logger.warn('submit を拒否/失敗', { code: error.code, status: error.status });
            return errorResponse(error);
        }
        logger.error('submit で想定外のエラー', error);
        return errorResponse(new GenerateApiError('upstream_error',
            '文字起こしの登録中にエラーが発生しました。しばらくしてから再試行してください。'));
    }
}

export function GET(): Response {
    return jsonResponse({ error: 'invalid_request', message: 'POST でのみ利用できます。' }, 405, { allow: 'POST' });
}
