/**
 * 契約テスト（L5-問3(a)）: submit / status の**実ルート**を、外界の I/O だけ差し替えて通す。
 *
 * 🔴 本番で3回出た「tsc もテストも緑なのに壊れる」型は、いずれも継ぎ目がモックされ、
 *    ルートの orchestration（何を呼ぶか）を一度も実行していなかったのが原因（L5-問2）。
 *    ここでは parseStoragePath / isOwnedBySubject / parseBatchResult / buildTranscriptMarkdownFromBatch を
 *    **実物のまま**通し、「submit が実際に submitBatchJob と文書作成とジョブ作成を呼ぶ」
 *    「status が Succeeded で確定処理を最後まで配線している」ことを錠にする。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AzureBatchResult } from '@/lib/azureBatchContract';

// --- 外界の I/O だけモック（純関数は実物のまま） ---
vi.mock('@/server/auth', () => ({
    GUEST_OWNER_ID: 'GUEST',
    resolveRequestSubject: vi.fn(),
}));
vi.mock('@/server/rateLimit', () => ({
    enforceRateLimit: vi.fn(async () => ({ allowed: true, count: 1, limit: 50 })),
    clientIpFromHeaders: vi.fn(() => '203.0.113.1'),
}));
vi.mock('@/server/mediaSource', async (importActual) => ({
    ...(await importActual<typeof import('@/server/mediaSource')>()),
    statMedia: vi.fn(async () => ({ storagePath: 'audio/GUEST/x.mp3', sizeBytes: 8_000_000 })),
    getSignedReadUrl: vi.fn(async () => 'https://signed.example/x.mp3?sig=abc'),
}));
vi.mock('@/server/azureBatchTranscribe', async (importActual) => ({
    ...(await importActual<typeof import('@/server/azureBatchTranscribe')>()),
    getAzureCredentials: vi.fn(() => ({ endpoint: 'https://ep', apiKey: 'k' })),
    submitBatchJob: vi.fn(async () => ({ selfUrl: 'https://ep/speechtotext/transcriptions/JID?api-version=2024-11-15' })),
    getBatchJob: vi.fn(),
    fetchBatchResult: vi.fn(),
    deleteBatchJob: vi.fn(async () => undefined),
}));
vi.mock('@/server/transcriptionDocument', () => ({
    createProcessingDocument: vi.fn(async () => 'doc-1'),
    completeTranscriptionDocument: vi.fn(async () => undefined),
    failTranscriptionDocument: vi.fn(async () => undefined),
}));
vi.mock('@/server/transcriptionJob', () => ({
    createTranscriptionJob: vi.fn(async () => 'job-1'),
    getTranscriptionJob: vi.fn(),
    updateTranscriptionJob: vi.fn(async () => undefined),
}));

import { POST as submitPOST } from './submit/route';
import { POST as statusPOST } from './status/route';
import { resolveRequestSubject } from '@/server/auth';
import { submitBatchJob, getBatchJob, fetchBatchResult, deleteBatchJob } from '@/server/azureBatchTranscribe';
import { createProcessingDocument, completeTranscriptionDocument, failTranscriptionDocument } from '@/server/transcriptionDocument';
import { createTranscriptionJob, getTranscriptionJob, updateTranscriptionJob } from '@/server/transcriptionJob';

const guest = { kind: 'guest' as const };
const req = (body: unknown) => new Request('http://t/api', { method: 'POST', body: JSON.stringify(body) });

const sampleAzureResult = (): AzureBatchResult => ({
    durationMilliseconds: 60_000,
    combinedRecognizedPhrases: [{ display: 'こんにちは。よろしくお願いします。' }],
    recognizedPhrases: [
        { offsetMilliseconds: 0, durationMilliseconds: 2000, speaker: 1, nBest: [{ display: 'こんにちは。' }] },
        { offsetMilliseconds: 3000, durationMilliseconds: 2000, speaker: 2, nBest: [{ display: 'よろしくお願いします。' }] },
    ],
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveRequestSubject).mockResolvedValue(guest);
});

describe('POST /api/transcribe/submit（実ルートの配線）', () => {
    const validBody = {
        storagePath: 'audio/GUEST/x.mp3',
        fileName: 'x.mp3',
        mimeType: 'audio/mpeg',
        audioSec: 600,
        promptName: '全文文字起こし',
        originalFileType: 'audio',
    };

    it('🔴 submitBatchJob・文書作成・ジョブ作成を実際に呼び、{jobId,docId} を返す', async () => {
        const res = await submitPOST(req(validBody));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ jobId: 'job-1', docId: 'doc-1' });
        // #50 型（配線漏れ）の再発防止: 「呼ばれた」で錠にする
        expect(submitBatchJob).toHaveBeenCalledTimes(1);
        expect(createProcessingDocument).toHaveBeenCalledTimes(1);
        expect(createTranscriptionJob).toHaveBeenCalledTimes(1);
        // ジョブは Azure の self URL と文書 ID を結びつけて持つ
        expect(vi.mocked(createTranscriptionJob).mock.calls[0][0]).toMatchObject({
            docId: 'doc-1',
            azureSelfUrl: expect.stringContaining('/transcriptions/JID'),
            ownerType: 'guest',
        });
    });

    it('所有者でないパスは 403（Azure を呼ばない）', async () => {
        const res = await submitPOST(req({ ...validBody, storagePath: 'audio/someuser/x.mp3' }));
        expect(res.status).toBe(403);
        expect(submitBatchJob).not.toHaveBeenCalled();
    });

    it('音声長が 240 分超は 400（提出しない）', async () => {
        const res = await submitPOST(req({ ...validBody, audioSec: 241 * 60 }));
        expect(res.status).toBe(400);
        expect(submitBatchJob).not.toHaveBeenCalled();
    });

    it('audioSec 欠落は 400', async () => {
        const { audioSec, ...noSec } = validBody; void audioSec;
        const res = await submitPOST(req(noSec));
        expect(res.status).toBe(400);
    });
});

describe('POST /api/transcribe/status（確定処理の配線）', () => {
    const runningJob = {
        id: 'job-1', ownerId: 'GUEST', ownerType: 'guest' as const, docId: 'doc-1',
        azureSelfUrl: 'https://ep/speechtotext/transcriptions/JID?api-version=2024-11-15',
        status: 'running' as const, audioSec: 600, storagePath: 'audio/GUEST/x.mp3',
        promptName: 'p', createdAtMs: 0, updatedAtMs: 0,
    };

    it('Azure が Running のうちは文書を確定しない', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue(runningJob);
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Running' });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({ status: 'running', docId: 'doc-1' });
        expect(completeTranscriptionDocument).not.toHaveBeenCalled();
    });

    it('🔴 Succeeded で結果取得→Markdown化→文書完成→ジョブ更新→Azure削除まで貫通する', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue(runningJob);
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Succeeded' });
        vi.mocked(fetchBatchResult).mockResolvedValue(sampleAzureResult());
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({ status: 'succeeded', docId: 'doc-1' });
        expect(completeTranscriptionDocument).toHaveBeenCalledTimes(1);
        // 実の buildTranscriptMarkdownFromBatch を通した本文が入る（話者ラベル＋時刻）
        const [docId, markdown, model] = vi.mocked(completeTranscriptionDocument).mock.calls[0];
        expect(docId).toBe('doc-1');
        expect(markdown).toContain('よろしくお願いします');
        expect(model).toContain('Azure');
        expect(updateTranscriptionJob).toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'succeeded' }));
        expect(deleteBatchJob).toHaveBeenCalledTimes(1);
    });

    it('🔴 Failed でも文書は消さず、理由を残して failed を返す（L2-D1 是正）', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue(runningJob);
        vi.mocked(getBatchJob).mockResolvedValue({ status: 'Failed', error: 'AudioLengthLimitExceeded' });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        const body = await res.json();
        expect(body.status).toBe('failed');
        expect(body.error).toContain('AudioLength');
        expect(failTranscriptionDocument).toHaveBeenCalledTimes(1);
        expect(completeTranscriptionDocument).not.toHaveBeenCalled();
    });

    it('🔴 既に succeeded のジョブは Azure を叩かず即返す（冪等・二重確定しない）', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue({ ...runningJob, status: 'succeeded' });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(await res.json()).toEqual({ status: 'succeeded', docId: 'doc-1' });
        expect(getBatchJob).not.toHaveBeenCalled();
        expect(completeTranscriptionDocument).not.toHaveBeenCalled();
    });

    it('他人のジョブは 403', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue({ ...runningJob, ownerId: 'someuser', ownerType: 'user' });
        const res = await statusPOST(req({ jobId: 'job-1' }));
        expect(res.status).toBe(403);
    });

    it('存在しないジョブは 404', async () => {
        vi.mocked(getTranscriptionJob).mockResolvedValue(null);
        const res = await statusPOST(req({ jobId: 'nope' }));
        expect(res.status).toBe(404);
    });
});
