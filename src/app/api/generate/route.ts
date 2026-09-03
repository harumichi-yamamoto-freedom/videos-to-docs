/**
 * POST /api/generate — サーバ経由の文書生成 (#4)。契約は src/lib/generateApiContract.ts。
 * 検査順: 本文 → 主体 (401) → パス/所有権/MIME (400/403) → キー在否 (503) → Storage 存在/サイズ (404/413)
 *        → 時間あたり上限 (429) → 取得 → Gemini (502/504) → 200。
 * 中止: クライアントが fetch を切ってもサーバ側の処理は継続し得る (仕様として許容)。
 */
import {
    GENERATE_ALLOWED_MIME_PREFIXES,
    type GenerateErrorBody,
    type GenerateRequestBody,
    type GenerateResponseBody,
} from '@/lib/generateApiContract';
import { createLogger } from '@/lib/logger';
import { resolveRequestSubject, type RequestSubject } from '@/server/auth';
import { GenerateApiError } from '@/server/errors';
import { assertGeminiConfigured, GeminiServerClient } from '@/server/geminiServer';
import { downloadMedia, isOwnedBySubject, parseStoragePath, statMedia } from '@/server/mediaSource';
import { clientIpFromHeaders, enforceRateLimit } from '@/server/rateLimit';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const logger = createLogger('api/generate');

const THINKING_LEVELS = new Set(['default', 'low', 'medium', 'high']);
const MAX_PROMPT_CONTENT_CHARS = 200_000;

const jsonResponse = (body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
    });

const errorResponse = (error: GenerateApiError): Response => {
    const body: GenerateErrorBody = error.toBody();
    const headers: Record<string, string> = error.retryAfterSec !== undefined
        ? { 'retry-after': String(error.retryAfterSec) }
        : {};
    return jsonResponse(body, error.status, headers);
};

const invalid = (message: string): GenerateApiError => new GenerateApiError('invalid_request', message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** 本文の形を契約に照らす。欠落・型違いは 400 (利用者向けの文言は「ページを再読み込み」) */
export function validateRequestBody(raw: unknown): GenerateRequestBody {
    const reload = 'ページを再読み込みして、もう一度変換してください。';
    if (!isRecord(raw)) throw invalid(`リクエストの形式が不正です。${reload}`);
    const { storagePath, fileName, mimeType, prompt } = raw;
    if (typeof storagePath !== 'string' || !storagePath) throw invalid(`アップロード先の情報がありません。${reload}`);
    if (typeof fileName !== 'string' || !fileName) throw invalid(`ファイル名がありません。${reload}`);
    if (typeof mimeType !== 'string' || !GENERATE_ALLOWED_MIME_PREFIXES.some(prefix => mimeType.startsWith(prefix))) {
        throw invalid('音声または動画ファイルのみ変換できます。対応形式のファイルを選び直してください。');
    }
    if (!isRecord(prompt)) throw invalid(`プロンプトの情報がありません。${reload}`);
    const { name, content, model, thinkingLevel } = prompt;
    if (typeof name !== 'string') throw invalid(`プロンプト名が不正です。${reload}`);
    if (typeof content !== 'string') throw invalid(`プロンプト本文が不正です。${reload}`);
    if (content.length > MAX_PROMPT_CONTENT_CHARS) throw invalid('プロンプトが長すぎます。プロンプト本文を短くしてから再試行してください。');
    if (typeof model !== 'string') throw invalid(`モデル指定が不正です。${reload}`);
    if (typeof thinkingLevel !== 'string' || !THINKING_LEVELS.has(thinkingLevel)) {
        throw invalid(`思考レベルの指定が不正です。${reload}`);
    }
    return {
        storagePath,
        fileName,
        mimeType,
        prompt: { name, content, model, thinkingLevel: thinkingLevel as GenerateRequestBody['prompt']['thinkingLevel'] },
    };
}

async function readJsonBody(request: Request): Promise<unknown> {
    try {
        return await request.json();
    } catch {
        throw invalid('リクエスト本文を読み取れませんでした。ページを再読み込みして、もう一度変換してください。');
    }
}

function assertOwnership(storagePath: string, subject: RequestSubject): void {
    const parsed = parseStoragePath(storagePath);
    if (!parsed) {
        throw invalid('アップロード先のパスが不正です。ページを再読み込みして、もう一度変換してください。');
    }
    if (!isOwnedBySubject(parsed.ownerId, subject)) {
        logger.warn('storagePath の所有者が主体と不一致', {
            ownerId: parsed.ownerId, subjectKind: subject.kind,
        });
        throw new GenerateApiError('forbidden',
            'このファイルを変換する権限がありません。自分でアップロードしたファイルを選び直してください。');
    }
}

export async function POST(request: Request): Promise<Response> {
    const startedAt = Date.now();
    try {
        const body = validateRequestBody(await readJsonBody(request));
        const subject = await resolveRequestSubject(request.headers);
        assertOwnership(body.storagePath, subject);
        assertGeminiConfigured();

        const info = await statMedia(body.storagePath);
        const rate = await enforceRateLimit(subject, clientIpFromHeaders(request.headers));
        const media = await downloadMedia(info);

        const client = new GeminiServerClient();
        const generated = await client.generate({
            bytes: media.bytes,
            mimeType: body.mimeType,
            fileName: body.fileName,
            prompt: body.prompt,
        });

        const elapsedMs = Date.now() - startedAt;
        const response: GenerateResponseBody = {
            text: generated.text,
            usedModel: generated.usedModel,
            thinkingLevel: generated.thinkingLevel,
            transport: generated.transport,
            usage: generated.usage,
            elapsedMs,
        };
        // 計器: Vercel runtime logs で 1 行 JSON として拾えるようにする (logger の整形を通さない)
        console.log(JSON.stringify({
            event: 'generate.success',
            usedModel: generated.usedModel,
            transport: generated.transport,
            usage: generated.usage,
            elapsedMs,
            subjectKind: subject.kind,
            rateCount: rate.count,
            rateLimit: rate.limit,
            sizeBytes: media.sizeBytes,
        }));
        return jsonResponse(response, 200);
    } catch (error) {
        if (error instanceof GenerateApiError) {
            logger.warn('generate を拒否/失敗', {
                code: error.code, status: error.status, elapsedMs: Date.now() - startedAt,
                cause: error.cause instanceof Error ? error.cause.message : undefined,
            });
            return errorResponse(error);
        }
        logger.error('generate で想定外のエラー', error, { elapsedMs: Date.now() - startedAt });
        return errorResponse(new GenerateApiError('upstream_error',
            '文書の生成中にエラーが発生しました。しばらくしてから再試行してください。'));
    }
}

export function GET(): Response {
    return jsonResponse({ error: 'invalid_request', message: 'POST でのみ利用できます。' }, 405, { allow: 'POST' });
}
