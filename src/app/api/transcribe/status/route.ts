/**
 * POST /api/transcribe/status — 非同期バッチの**状態確認と確定**（設計 §3.7 改訂・2026-09-05）。
 *
 * クライアントが時々叩く。Azure が完了していれば、この短命関数が**その場で確定処理**する
 * （結果取得 → Markdown 化 → 文書とジョブを原子的に更新 → Azure ジョブ削除）。
 * 🔴 webhook が無くても poll だけで完結する（Hobby でも堅牢）。確定は job.status で冪等。
 */
import { createLogger } from '@/lib/logger';
import type {
    TranscribeStatusRequest,
    TranscribeStatusResponse,
    TranscribeBatchErrorBody,
    TranscribeProgressStage,
} from '@/lib/transcribeBatchContract';
import { isTerminalBatchStatus, type AzureBatchStatus } from '@/lib/azureBatchContract';
import { resolveRequestSubject } from '@/server/auth';
import { GenerateApiError } from '@/server/errors';
import { isOwnedBySubject } from '@/server/mediaSource';
import { getAdminFirestore } from '@/server/firebaseAdmin';
import { TRANSCRIPTIONS_COLLECTION, writeProcessingProgress } from '@/server/transcriptionDocument';
import {
    getAzureCredentials,
    getBatchJob,
    fetchBatchResult,
    deleteBatchJob,
    parseBatchResult,
} from '@/server/azureBatchTranscribe';
import { buildTranscriptMarkdownFromBatch, describeBatchModel } from '@/server/finalizeTranscription';
import {
    claimJobForFinalize,
    commitTerminalOutcome,
    FINALIZE_LEASE_MS,
    getTranscriptionJob,
    getTranscriptionJobByDocId,
    recordAzureObservation,
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

const isPositiveFinite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;

const isAzureStatus = (value: unknown): value is AzureBatchStatus =>
    value === 'NotStarted' || value === 'Running' || value === 'Succeeded' || value === 'Failed';

/** finalizing は確定権であり、表示段階は最後の有効な Azure 観測からのみ導出する。 */
const observedStage = (job: TranscriptionJob): Exclude<TranscribeProgressStage, 'completed' | 'failed'> => {
    switch (job.azureStatus) {
        case 'NotStarted': return 'queued';
        case 'Running': return 'transcribing';
        case 'Succeeded': return 'importing';
        default: return 'checking';
    }
};

const progressMetadata = (job: TranscriptionJob) => ({
    ...(isPositiveFinite(job.azureStatusCheckedAtMs) && { azureStatusCheckedAtMs: job.azureStatusCheckedAtMs }),
    ...(isPositiveFinite(job.createdAtMs) && { createdAtMs: job.createdAtMs }),
    ...(isPositiveFinite(job.audioSec) && { audioSec: job.audioSec }),
});

const statusResponse = (job: TranscriptionJob, stage = observedStage(job)): Response => {
    const response: TranscribeStatusResponse = {
        status: job.status === 'finalizing' ? 'running' : job.status,
        docId: job.docId,
        ...(job.error ? { error: job.error } : {}),
        stage: job.status === 'succeeded' ? 'completed' : job.status === 'failed' ? 'failed' : stage,
        ...progressMetadata(job),
        serverNowMs: Date.now(),
    };
    return jsonResponse(response, 200);
};

/** 確認失敗でも HTTP エラーを維持し、最後の有効観測の時刻を進めず返す。 */
const errorResponse = (error: GenerateApiError, job?: TranscriptionJob): Response =>
    jsonResponse({
        error: error.code,
        message: error.message,
        ...(job && { docId: job.docId, stage: 'checking', ...progressMetadata(job) }),
        serverNowMs: Date.now(),
    } satisfies TranscribeBatchErrorBody & Partial<TranscribeStatusResponse>, error.status);

const statusCheckError = (error: unknown): GenerateApiError => error instanceof GenerateApiError
    ? error
    : new GenerateApiError('upstream_error',
        '文字起こしの状態確認でエラーが発生しました。しばらくしてから再試行してください。');

const invalid = (message: string): GenerateApiError => new GenerateApiError('invalid_request', message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export function validateStatusBody(raw: unknown): TranscribeStatusRequest {
    if (!isRecord(raw) || (raw.jobId === undefined) === (raw.docId === undefined)) {
        throw invalid('ジョブ ID または文書 ID のどちらかを指定してください。');
    }
    if (raw.jobId !== undefined) {
        if (typeof raw.jobId !== 'string' || !raw.jobId.trim()) throw invalid('ジョブ ID が不正です。');
        return { jobId: raw.jobId };
    }
    if (typeof raw.docId !== 'string' || !raw.docId.trim()) throw invalid('文書 ID が不正です。');
    return { docId: raw.docId };
}

/**
 * Azure が終端に達していれば確定処理（呼び出し側が CAS で確定権を取得済み）。
 * 成功: 結果 → Markdown → 文書とジョブを原子的に確定 → Azure ジョブ削除。
 * 失敗: 文書に理由を残してジョブと原子的に確定。取り込み失敗では Azure の結果を残す。
 * 未完: ジョブを running に戻し、次の poll で再確認する。
 */
async function finalizeIfTerminal(job: TranscriptionJob): Promise<Response> {
    const credentials = getAzureCredentials();
    if (!credentials) {
        // 設定が消えた等。設定を直せば次の poll で進むよう、確定権を解放する。
        await updateTranscriptionJob(job.id, { status: 'running' });
        return statusResponse({ ...job, status: 'running' }, 'checking');
    }
    let state: Awaited<ReturnType<typeof getBatchJob>>;
    try {
        state = await getBatchJob(job.azureSelfUrl, credentials);
        if (!isAzureStatus(state.status)) {
            throw new GenerateApiError('upstream_error', '文字起こしの状態を確認できませんでした。しばらくしてから再試行してください。');
        }
    } catch (error) {
        await updateTranscriptionJob(job.id, { status: 'running' });
        const failure = statusCheckError(error);
        logger.warn('Azure の状態確認に失敗', { jobId: job.id, code: failure.code });
        return errorResponse(failure, job);
    }
    const observedJob = await recordAzureObservation(job.id, state.status);
    if (!observedJob) throw new GenerateApiError('media_not_found', '文字起こしジョブが見つかりません。');
    job = observedJob;
    // 遅れた照会中に別リクエストが終端化した場合は、現在の終端を優先する。
    if (job.status === 'succeeded' || job.status === 'failed') return statusResponse(job);
    if (job.azureStatus !== state.status) {
        // 保存済み Azure 終端から逆戻りする観測は採用せず、鮮度も更新しない。
        await updateTranscriptionJob(job.id, { status: 'running' });
        return errorResponse(new GenerateApiError('upstream_error',
            '文字起こしの状態を確認できませんでした。しばらくしてから再試行してください。'), job);
    }
    await writeProcessingProgress(job.docId, job.ownerId, {
        jobId: job.id,
        stage: observedStage(job),
        ...(isPositiveFinite(job.createdAtMs) && { jobCreatedAtMs: job.createdAtMs }),
        ...(isPositiveFinite(job.audioSec) && { audioSec: job.audioSec }),
    });
    if (!isTerminalBatchStatus(state.status)) {
        await updateTranscriptionJob(job.id, { status: 'running' });
        return statusResponse({ ...job, status: 'running' });
    }
    if (state.status === 'Failed') {
        const reason = state.error ?? 'Azure 側で処理に失敗しました。';
        const committed = await commitTerminalOutcome({
            jobId: job.id,
            docId: job.docId,
            expectedOwnerId: job.ownerId,
            outcome: { kind: 'failed', reason },
        });
        if (committed === 'not_owner') return getCurrentPublicStatus(job.id);
        await deleteBatchJob(job.azureSelfUrl, credentials);
        return statusResponse({ ...job, status: 'failed', error: reason });
    }
    // Succeeded
    let parsed: ReturnType<typeof parseBatchResult>;
    let markdown: string;
    let generatedByModel: string;
    try {
        const result = await fetchBatchResult(job.azureSelfUrl, credentials);
        parsed = parseBatchResult(result);
        markdown = buildTranscriptMarkdownFromBatch(parsed);
        generatedByModel = describeBatchModel(parsed);
    } catch {
        const reason = '文字起こし結果の取り込みに失敗しました。もう一度お試しください。';
        logger.warn('文字起こし結果の取り込みに失敗', { jobId: job.id });
        const committed = await commitTerminalOutcome({
            jobId: job.id,
            docId: job.docId,
            expectedOwnerId: job.ownerId,
            outcome: { kind: 'failed', reason },
        });
        if (committed === 'not_owner') return getCurrentPublicStatus(job.id);
        // 未取り込みの結果は削除せず、Azure 側の TTL に任せる。
        return statusResponse({ ...job, status: 'failed', error: reason });
    }
    // 保存失敗は取り込み失敗として確定せず、finalizing のリース切れ後に再試行する。
    const committed = await commitTerminalOutcome({
        jobId: job.id,
        docId: job.docId,
        expectedOwnerId: job.ownerId,
        outcome: { kind: 'succeeded', transcription: markdown, generatedByModel, speakers: parsed.speakers },
    });
    if (committed === 'not_owner') return getCurrentPublicStatus(job.id);
    await deleteBatchJob(job.azureSelfUrl, credentials);
    logger.info('文字起こしを確定', { jobId: job.id, speakers: parsed.speakers, chars: markdown.length });
    return statusResponse({ ...job, status: 'succeeded' });
}

async function getCurrentPublicStatus(jobId: string): Promise<Response> {
    const current = await getTranscriptionJob(jobId);
    if (!current) throw new GenerateApiError('media_not_found', '文字起こしジョブが見つかりません。');
    return statusResponse(current);
}

export async function POST(request: Request): Promise<Response> {
    try {
        const body = validateStatusBody(await request.json().catch(() => {
            throw invalid('リクエストの本文を読み取れませんでした。');
        }));
        const subject = await resolveRequestSubject(request.headers);

        let job: TranscriptionJob | null;
        if (body.docId !== undefined) {
            const snap = await getAdminFirestore().collection(TRANSCRIPTIONS_COLLECTION).doc(body.docId).get();
            if (!snap.exists) throw new GenerateApiError('media_not_found', '文書が見つかりません。');
            const document = snap.data();
            if (!isOwnedBySubject(String(document?.ownerId ?? ''), subject)) {
                throw new GenerateApiError('forbidden', 'この文書を参照する権限がありません。');
            }
            job = typeof document?.jobId === 'string' && document.jobId
                ? await getTranscriptionJob(document.jobId)
                : null;
            // jobId 未付与の既存文書や、紐付けが残っていない文書も再確定できる。
            if (!job || job.docId !== body.docId) job = await getTranscriptionJobByDocId(body.docId);
        } else {
            job = await getTranscriptionJob(body.jobId);
        }
        if (!job) throw new GenerateApiError('media_not_found', '文字起こしジョブが見つかりません。');
        if (!isOwnedBySubject(job.ownerId, subject)) {
            throw new GenerateApiError('forbidden', 'このジョブを参照する権限がありません。');
        }

        // 確定済み/確定中は即返す。クラッシュで期限切れになったリースだけ再取得する。
        const expiredFinalize = job.status === 'finalizing'
            && Date.now() - job.updatedAtMs > FINALIZE_LEASE_MS;
        if (job.status !== 'running' && !expiredFinalize) {
            return statusResponse(job);
        }

        const claimedJob = await claimJobForFinalize(job.id);
        if (!claimedJob) {
            return await getCurrentPublicStatus(job.id);
        }

        return await finalizeIfTerminal(claimedJob);
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
