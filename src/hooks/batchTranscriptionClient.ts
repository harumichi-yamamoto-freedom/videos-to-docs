/**
 * 非同期バッチ文字起こしのクライアント側（設計 §3.7 改訂・2026-09-05）。
 *
 * 流れ: 既にアップロード済みの音声パスで **提出** → **状態確認をポーリング** → 完了。
 * 🔴 文書はサーバが作って完成させる（タブ非依存）。クライアントは saveTranscription を呼ばない。
 * 🔴 認証は既存の生成 API と同じ形（firebase は遅延 import。モジュール先頭で読むと鍵の無い
 *    環境で Auth 初期化が落ちる）。未ログイン（ゲスト）はヘッダを付けない。
 */
import { GENERATE_AUTH_HEADER } from '@/lib/generateApiContract';
import {
    TRANSCRIBE_SUBMIT_PATH,
    TRANSCRIBE_STATUS_PATH,
    type TranscribeSubmitRequest,
    type TranscribeSubmitResponse,
    type TranscribeStatusResponse,
    type TranscribeBatchErrorBody,
} from '@/lib/transcribeBatchContract';

async function authHeaders(): Promise<Record<string, string>> {
    let token: string | null = null;
    try {
        const { auth } = await import('@/lib/firebase');
        token = (await auth.currentUser?.getIdToken()) ?? null;
    } catch {
        token = null;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers[GENERATE_AUTH_HEADER] = `Bearer ${token}`;
    return headers;
}

const messageFrom = (json: unknown, fallback: string): string => {
    const body = json as Partial<TranscribeBatchErrorBody> | null;
    return (body && typeof body.message === 'string' && body.message) || fallback;
};

/** ジョブを提出。音声は既に Storage にある前提。短命に {jobId, docId} が返る。 */
export async function submitBatchTranscription(
    req: TranscribeSubmitRequest,
    signal?: AbortSignal,
): Promise<TranscribeSubmitResponse> {
    const response = await fetch(TRANSCRIBE_SUBMIT_PATH, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify(req),
        ...(signal ? { signal } : {}),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(messageFrom(json, `文字起こしの登録に失敗しました (${response.status})`));
    }
    return json as TranscribeSubmitResponse;
}

/** ジョブの状態を 1 回問い合わせる。完了していればサーバがその場で文書を確定する。 */
export async function fetchBatchStatus(
    jobId: string,
    signal?: AbortSignal,
): Promise<TranscribeStatusResponse> {
    const response = await fetch(TRANSCRIBE_STATUS_PATH, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ jobId }),
        ...(signal ? { signal } : {}),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(messageFrom(json, `状態の確認に失敗しました (${response.status})`));
    }
    return json as TranscribeStatusResponse;
}

export interface PollOptions {
    signal?: AbortSignal;
    /** 問い合わせ間隔（既定 15 秒。バッチは分単位なので細かく叩かない） */
    intervalMs?: number;
    /** 全体の待ち上限（既定 90 分）。超えたらポーリングを諦める（ジョブ自体は生きている） */
    timeoutMs?: number;
    /** 毎回の状態を UI に伝える */
    onTick?: (status: TranscribeStatusResponse) => void;
    /** テスト用: 待ちを差し替える */
    wait?: (ms: number) => Promise<void>;
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 終端（succeeded/failed）になるまでポーリングする。中止は例外を投げる。 */
export async function pollBatchStatus(jobId: string, options: PollOptions = {}): Promise<TranscribeStatusResponse> {
    const { signal, intervalMs = 15_000, timeoutMs = 90 * 60_000, onTick, wait = defaultWait } = options;
    const startedAt = Date.now();
    for (;;) {
        if (signal?.aborted) throw signal.reason ?? new Error('中止しました');
        const status = await fetchBatchStatus(jobId, signal);
        onTick?.(status);
        if (status.status !== 'running') return status;
        if (Date.now() - startedAt > timeoutMs) {
            // ジョブは Azure 側で継続中。文書は「処理中」のまま残り、後で開けば確定できる。
            return status;
        }
        await wait(intervalMs);
    }
}

export interface RunBatchTranscriptionInput {
    storagePath: string;
    fileName: string;
    mimeType: string;
    audioSec: number;
    promptName: string;
    originalFileType: string;
    title?: string;
    signal?: AbortSignal;
    onTick?: (status: TranscribeStatusResponse) => void;
    pollIntervalMs?: number;
}

export interface RunBatchTranscriptionResult {
    success: boolean;
    docId: string;
    /** まだ処理中（ポーリング上限に達した）。文書は「処理中」のまま */
    pending?: boolean;
    error?: string;
}

/** 提出 → ポーリング → 結果。文書はサーバが保存済み。 */
export async function runBatchTranscription(
    input: RunBatchTranscriptionInput,
): Promise<RunBatchTranscriptionResult> {
    const { jobId, docId } = await submitBatchTranscription(
        {
            storagePath: input.storagePath,
            fileName: input.fileName,
            mimeType: input.mimeType,
            audioSec: input.audioSec,
            promptName: input.promptName,
            originalFileType: input.originalFileType,
            ...(input.title ? { title: input.title } : {}),
        },
        input.signal,
    );
    const final = await pollBatchStatus(jobId, {
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.pollIntervalMs ? { intervalMs: input.pollIntervalMs } : {}),
        ...(input.onTick ? { onTick: input.onTick } : {}),
    });
    if (final.status === 'succeeded') return { success: true, docId };
    if (final.status === 'failed') return { success: false, docId, ...(final.error ? { error: final.error } : {}) };
    // running のまま上限に達した: 失敗ではない。文書は処理中で残る。
    return { success: false, docId, pending: true };
}
