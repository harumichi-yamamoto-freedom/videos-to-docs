/**
 * POST /api/transcribe/status — 非同期バッチの**状態確認と確定**（設計 §3.7 改訂・2026-09-05）。
 *
 * クライアントが時々叩く。Azure が完了していれば、この短命関数が**その場で確定処理**する
 * （結果取得 → Markdown 化 → 文書更新 → ジョブ更新 → Azure ジョブ削除）。
 * 🔴 webhook が無くても poll だけで完結する（Hobby でも堅牢）。確定は job.status で冪等。
 */
import { createLogger } from '@/lib/logger';
import type {
    TranscribeStatusRequest,
    TranscribeStatusResponse,
    TranscribeBatchErrorBody,
} from '@/lib/transcribeBatchContract';
import { isTerminalBatchStatus } from '@/lib/azureBatchContract';
import { resolveRequestSubject } from '@/server/auth';
import { GenerateApiError } from '@/server/errors';
import { isOwnedBySubject } from '@/server/mediaSource';
import {
    getAzureCredentials,
    getBatchJob,
    fetchBatchResult,
    deleteBatchJob,
    parseBatchResult,
} from '@/server/azureBatchTranscribe';
import { buildTranscriptMarkdownFromBatch, describeBatchModel } from '@/server/finalizeTranscription';
import { completeTranscriptionDocument, failTranscriptionDocument } from '@/server/transcriptionDocument';
import {
    getTranscriptionJob,
    updateTranscriptionJob,
    type TranscriptionJob,
} from '@/server/transcriptionJob';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const logger = createLogger('api/transcribe/status');

const jsonResponse = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });

const errorResponse = (error: GenerateApiError): Response =>
    jsonResponse({ error: error.code, message: error.message } satisfies TranscribeBatchErrorBody, error.status);

const invalid = (message: string): GenerateApiError => new GenerateApiError('invalid_request', message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export function validateStatusBody(raw: unknown): TranscribeStatusRequest {
    if (!isRecord(raw) || typeof raw.jobId !== 'string' || !raw.jobId) {
        throw invalid('ジョブ ID がありません。ページを再読み込みしてください。');
    }
    return { jobId: raw.jobId };
}

/**
 * Azure が終端に達していれば確定処理。冪等（呼び出し側が job.status を running と確認済み）。
 * 成功: 結果 → Markdown → 文書完成 → ジョブ succeeded → Azure ジョブ削除。
 * 失敗: 文書に理由を残す → ジョブ failed → Azure ジョブ削除。
 * 未完: 何もしない。
 */
async function finalizeIfTerminal(job: TranscriptionJob): Promise<TranscribeJobPublicStatusInternal> {
    const credentials = getAzureCredentials();
    if (!credentials) {
        // 設定が消えた等。ジョブは running のまま（設定を直せば次の poll で進む）。
        return { status: 'running', docId: job.docId };
    }
    const state = await getBatchJob(job.azureSelfUrl, credentials);
    if (!isTerminalBatchStatus(state.status)) {
        return { status: 'running', docId: job.docId };
    }
    if (state.status === 'Failed') {
        const reason = state.error ?? 'Azure 側で処理に失敗しました。';
        await failTranscriptionDocument(job.docId, reason);
        await updateTranscriptionJob(job.id, { status: 'failed', error: reason });
        await deleteBatchJob(job.azureSelfUrl, credentials);
        return { status: 'failed', docId: job.docId, error: reason };
    }
    // Succeeded
    const result = await fetchBatchResult(job.azureSelfUrl, credentials);
    const parsed = parseBatchResult(result);
    const markdown = buildTranscriptMarkdownFromBatch(parsed);
    await completeTranscriptionDocument(job.docId, markdown, describeBatchModel(parsed));
    await updateTranscriptionJob(job.id, { status: 'succeeded', speakers: parsed.speakers });
    await deleteBatchJob(job.azureSelfUrl, credentials);
    logger.info('文字起こしを確定', { jobId: job.id, speakers: parsed.speakers, chars: markdown.length });
    return { status: 'succeeded', docId: job.docId };
}

interface TranscribeJobPublicStatusInternal {
    status: 'running' | 'succeeded' | 'failed';
    docId: string;
    error?: string;
}

export async function POST(request: Request): Promise<Response> {
    try {
        const body = validateStatusBody(await request.json().catch(() => {
            throw invalid('リクエストの本文を読み取れませんでした。');
        }));
        const subject = await resolveRequestSubject(request.headers);

        const job = await getTranscriptionJob(body.jobId);
        if (!job) throw new GenerateApiError('media_not_found', '文字起こしジョブが見つかりません。');
        if (!isOwnedBySubject(job.ownerId, subject)) {
            throw new GenerateApiError('forbidden', 'このジョブを参照する権限がありません。');
        }

        // 既に確定済みなら Azure を叩かずそのまま返す（冪等・二重確定しない）
        if (job.status !== 'running') {
            const response: TranscribeStatusResponse = {
                status: job.status,
                docId: job.docId,
                ...(job.error ? { error: job.error } : {}),
            };
            return jsonResponse(response, 200);
        }

        const outcome = await finalizeIfTerminal(job);
        const response: TranscribeStatusResponse = {
            status: outcome.status,
            docId: outcome.docId,
            ...(outcome.error ? { error: outcome.error } : {}),
        };
        return jsonResponse(response, 200);
    } catch (error) {
        if (error instanceof GenerateApiError) {
            logger.warn('status を拒否/失敗', { code: error.code, status: error.status });
            return errorResponse(error);
        }
        logger.error('status で想定外のエラー', error);
        return errorResponse(new GenerateApiError('upstream_error',
            '文字起こしの状態確認でエラーが発生しました。しばらくしてから再試行してください。'));
    }
}

export function GET(): Response {
    return jsonResponse({ error: 'invalid_request', message: 'POST でのみ利用できます。' }, 405);
}
