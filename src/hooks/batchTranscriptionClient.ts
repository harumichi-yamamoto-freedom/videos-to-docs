/**
 * 非同期バッチ文字起こしのクライアント側（設計 §3.7 改訂・2026-09-05、進捗段階表示 仕様 §A・2026-09-05）。
 *
 * 流れ: 既にアップロード済みの音声パスで **提出** → **状態確認をポーリング** → 完了。
 * 🔴 文書はサーバが作って完成させる（タブ非依存）。クライアントは saveTranscription を呼ばない。
 * 🔴 認証は既存の生成 API と同じ形（firebase は遅延 import。モジュール先頭で読むと鍵の無い
 *    環境で Auth 初期化が落ちる）。未ログイン（ゲスト）はヘッダを付けない。
 * 🔴 同一 docId の実行中 status リクエストは共有し、同じ画面内で二重 poll を作らない（仕様 §A2 手順3）。
 *    状態確認は再提出ではない。このモジュールのどの確認経路も submit を呼ばない。
 */
import { GENERATE_AUTH_HEADER } from '@/lib/generateApiContract';
import {
    TRANSCRIBE_SUBMIT_PATH,
    TRANSCRIBE_STATUS_PATH,
    type DocumentProcessingProgress,
    type TranscribeProgressStage,
    type TranscribeSubmitRequest,
    type TranscribeSubmitResponse,
    type TranscribeStatusRequest,
    type TranscribeStatusResponse,
    type TranscribeBatchErrorBody,
} from '@/lib/transcribeBatchContract';

/** 状態確認の基本間隔（仕様 §A2 手順1・3。バッチは分単位なので細かく叩かない） */
export const STATUS_POLL_INTERVAL_MS = 15_000;
/** 自動確認の上限（仕様 §A2 手順5。超えても文書は「処理中」で残り、サーバ側の処理は継続する） */
export const STATUS_POLL_TIMEOUT_MS = 90 * 60_000;
/** HTTP 一時失敗時の間隔（仕様 §A2 手順4: 30 秒→60 秒。成功で基本間隔へ戻す） */
export const STATUS_RETRY_INTERVALS_MS: readonly number[] = [30_000, 60_000];

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

/**
 * 状態確認の HTTP 失敗。呼出元が 401/403/404/429 を区別して確認を止めたり間隔を延ばしたりできるよう、
 * 文言だけでなく HTTP ステータスと Retry-After を持つ。
 */
export class TranscribeStatusError extends Error {
    readonly httpStatus: number;
    readonly code: string | undefined;
    /** 429 などで指示された待ち時間（ms）。無ければ undefined */
    readonly retryAfterMs: number | undefined;

    constructor(
        message: string,
        details: { httpStatus: number; code?: string; retryAfterMs?: number },
    ) {
        super(message);
        this.name = 'TranscribeStatusError';
        this.httpStatus = details.httpStatus;
        this.code = details.code;
        this.retryAfterMs = details.retryAfterMs;
    }
}

const parseRetryAfterMs = (response: Response, json: unknown): number | undefined => {
    const body = json as Partial<TranscribeBatchErrorBody> | null;
    if (body && typeof body.retryAfterSec === 'number' && Number.isFinite(body.retryAfterSec) && body.retryAfterSec >= 0) {
        return Math.round(body.retryAfterSec * 1000);
    }
    // テストダブルは headers を持たないことがあるので、存在するときだけ読む。
    const header = typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : null;
    if (!header) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const dateMs = Date.parse(header);
    return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
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

async function fetchTranscriptionStatus(request: TranscribeStatusRequest): Promise<TranscribeStatusResponse> {
    const response = await fetch(TRANSCRIBE_STATUS_PATH, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify(request),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
        const body = json as Partial<TranscribeBatchErrorBody> | null;
        throw new TranscribeStatusError(messageFrom(json, `状態の確認に失敗しました (${response.status})`), {
            httpStatus: response.status,
            ...(body && typeof body.error === 'string' ? { code: body.error } : {}),
            ...(() => {
                const retryAfterMs = parseRetryAfterMs(response, json);
                return retryAfterMs !== undefined ? { retryAfterMs } : {};
            })(),
        });
    }
    return json as TranscribeStatusResponse;
}

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new Error('中止しました');

/**
 * 共有リクエストを呼出元ごとの中止シグナルと競争させる。
 * 🔴 fetch 自体には呼出元のシグナルを渡さない。渡すと、先に中止した 1 人のために、
 *    同じ応答を待っている他の呼出元（一覧の再確定・詳細の継続確認）まで巻き添えで失敗する。
 *    中止した側は結果を受け取らないだけで、リクエストはサーバ側で短命に完結する（冪等）。
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
            reject(abortReason(signal));
            return;
        }
        const onAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            value => { signal.removeEventListener('abort', onAbort); resolve(value); },
            error => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
    });
}

/** 実行中の status リクエスト（共有キー = docId。jobId しか分からない経路は `job:` 接頭辞） */
const inflightStatusRequests = new Map<string, Promise<TranscribeStatusResponse>>();

function fetchStatusShared(
    request: TranscribeStatusRequest,
    shareKey: string,
    signal?: AbortSignal,
): Promise<TranscribeStatusResponse> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    let inflight = inflightStatusRequests.get(shareKey);
    if (!inflight) {
        const started = fetchTranscriptionStatus(request).finally(() => {
            if (inflightStatusRequests.get(shareKey) === started) inflightStatusRequests.delete(shareKey);
        });
        inflightStatusRequests.set(shareKey, started);
        inflight = started;
    }
    return signal ? raceWithAbort(inflight, signal) : inflight;
}

/** テスト用: 共有中のリクエスト数（実装詳細。本番コードから参照しない） */
export const countInflightStatusRequests = (): number => inflightStatusRequests.size;

/**
 * ジョブの状態を 1 回問い合わせる。完了していればサーバがその場で文書を確定する。
 * docId が分かっていれば共有キーに使い、同じ文書の他の確認と実行中リクエストを共有する。
 */
export function fetchBatchStatus(
    jobId: string,
    signal?: AbortSignal,
    docId?: string,
): Promise<TranscribeStatusResponse> {
    return fetchStatusShared({ jobId }, docId ?? `job:${jobId}`, signal);
}

/** 文書を開いたときの 1 回限りの確認。running なら文書は変更せず、終端の保存はサーバが行う。 */
export function reconcileProcessingDocument(
    docId: string,
    signal?: AbortSignal,
): Promise<TranscribeStatusResponse> {
    return fetchStatusShared({ docId }, docId, signal);
}

export interface PollOptions {
    signal?: AbortSignal;
    /** 問い合わせ間隔（既定 15 秒。バッチは分単位なので細かく叩かない） */
    intervalMs?: number;
    /** 全体の待ち上限（既定 90 分）。超えたらポーリングを諦める（ジョブ自体は生きている） */
    timeoutMs?: number;
    /** 毎回の状態を UI に伝える */
    onTick?: (status: TranscribeStatusResponse) => void;
    /** 分かっていれば渡す。同じ文書の他の確認と実行中リクエストを共有する */
    docId?: string;
    /** テスト用: 待ちを差し替える */
    wait?: (ms: number) => Promise<void>;
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 終端（succeeded/failed）になるまでポーリングする。中止は例外を投げる。
 *
 * 🔴 一時的な状態確認エラー（サーバの 502・回線断）でポーリングを止めない。
 *    サーバ側は確定処理が途中で落ちても finalizing のリース切れ後に**次の poll で再確定**できる設計
 *    （commitTerminalOutcome）。ここで一度の失敗で抜けると、その回復経路に永遠に到達せず、
 *    文書が「処理中」のまま固まり、利用者が別ジョブを再提出して二重課金になる（再レビュー major）。
 *    だから状態確認の失敗は飲み込んで待ち、次の周回で再試行する。中止（abort）は即座に投げる。
 */
export async function pollBatchStatus(jobId: string, options: PollOptions = {}): Promise<TranscribeStatusResponse> {
    const {
        signal, intervalMs = STATUS_POLL_INTERVAL_MS, timeoutMs = STATUS_POLL_TIMEOUT_MS, onTick, docId, wait = defaultWait,
    } = options;
    const startedAt = Date.now();
    let lastStatus: TranscribeStatusResponse | null = null;
    for (;;) {
        if (signal?.aborted) throw abortReason(signal);
        let status: TranscribeStatusResponse | null = null;
        try {
            status = await fetchBatchStatus(jobId, signal, docId);
        } catch (error) {
            // 中止はそのまま伝える。それ以外（502・回線断）は一時障害として次の周回で再試行。
            if (signal?.aborted) throw signal.reason ?? error;
            status = null;
        }
        if (status) {
            lastStatus = status;
            onTick?.(status);
            if (status.status !== 'running') return status;
        }
        if (Date.now() - startedAt > timeoutMs) {
            // ジョブは Azure 側で継続中。文書は「処理中」のまま残り、後で開けば確定できる。
            return lastStatus ?? { status: 'running', docId: docId ?? '' };
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
    /**
     * 提出が受け付けられた直後に {jobId, docId} を伝える（仕様 §A4）。
     * 呼出元はこれを保持し、確認が止まった後の再開を**新規 submit ではなく同じ ID の確認**で行う。
     */
    onSubmitted?: (submitted: TranscribeSubmitResponse) => void;
    pollIntervalMs?: number;
}

/**
 * 提出→確認の結果。
 * 🔴 `pending` は失敗ではない（仕様 §A4）。確認の上限に達しただけで、ジョブはサーバ側で継続し、
 *    文書は「処理中」で残る。呼出元はこれを赤い失敗として描かず、「確認待ち」として扱う。
 */
export type RunBatchTranscriptionResult =
    | { outcome: 'succeeded'; success: true; jobId: string; docId: string }
    | { outcome: 'failed'; success: false; jobId: string; docId: string; error?: string }
    | {
        outcome: 'pending';
        success: false;
        pending: true;
        jobId: string;
        docId: string;
        /** 上限に達する前に受け取った最後の有効な応答（無ければ null） */
        lastStatus: TranscribeStatusResponse | null;
    };

export interface AwaitBatchTranscriptionInput {
    jobId: string;
    docId: string;
    signal?: AbortSignal;
    onTick?: (status: TranscribeStatusResponse) => void;
    pollIntervalMs?: number;
}

/**
 * 既に提出済みのジョブの確認を（再）開する。**submit は呼ばない。**
 * 確認停止・確認待ちからの再開はこの入口を使う（仕様 §A4「提出後の確認再開は保存した ID で行う」）。
 */
export async function resumeBatchTranscription(
    input: AwaitBatchTranscriptionInput,
): Promise<RunBatchTranscriptionResult> {
    const { jobId, docId } = input;
    let lastStatus: TranscribeStatusResponse | null = null;
    const final = await pollBatchStatus(jobId, {
        docId,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.pollIntervalMs ? { intervalMs: input.pollIntervalMs } : {}),
        onTick: (status) => {
            lastStatus = status;
            input.onTick?.(status);
        },
    });
    if (final.status === 'succeeded') return { outcome: 'succeeded', success: true, jobId, docId };
    if (final.status === 'failed') {
        return { outcome: 'failed', success: false, jobId, docId, ...(final.error ? { error: final.error } : {}) };
    }
    // running のまま上限に達した: 失敗ではない。文書は処理中で残る。
    return { outcome: 'pending', success: false, pending: true, jobId, docId, lastStatus };
}

/** 提出 → ポーリング → 結果。文書はサーバが保存済み。 */
export async function runBatchTranscription(
    input: RunBatchTranscriptionInput,
): Promise<RunBatchTranscriptionResult> {
    const submitted = await submitBatchTranscription(
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
    input.onSubmitted?.(submitted);
    return resumeBatchTranscription({
        jobId: submitted.jobId,
        docId: submitted.docId,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onTick ? { onTick: input.onTick } : {}),
        ...(input.pollIntervalMs ? { pollIntervalMs: input.pollIntervalMs } : {}),
    });
}

// ---------------------------------------------------------------------------------------------
// 表示段階（仕様 §A1）。一覧・詳細・処理欄が同じ文言を使うため、ここに 1 か所で持つ。
// 🔴 進捗パーセントは無い（Azure が返さない）。段階のみ。
// ---------------------------------------------------------------------------------------------

export const PROGRESS_STAGE_LABELS: Record<TranscribeProgressStage, string> = {
    checking: '受付済み・状態を確認しています',
    queued: '開始待ち',
    transcribing: '文字起こし中',
    importing: '結果を文書に取り込んでいます',
    completed: '完了',
    failed: '文字起こしに失敗しました',
};

const PROGRESS_STAGE_DETAIL_LABELS: Partial<Record<TranscribeProgressStage, string>> = {
    queued: '文字起こしの開始を待っています',
};

/** 段階の主文言。`detail` は詳細画面向けの言い換え（開始待ち→文字起こしの開始を待っています） */
export function describeProgressStage(
    stage: TranscribeProgressStage,
    variant: 'list' | 'detail' = 'list',
): string {
    return (variant === 'detail' && PROGRESS_STAGE_DETAIL_LABELS[stage]) || PROGRESS_STAGE_LABELS[stage];
}

/** 旧サーバの応答（stage 欠落）でも公開 3 値から終端だけは導く。running で stage が無ければ不明 */
export function stageFromStatusResponse(response: TranscribeStatusResponse): TranscribeProgressStage | undefined {
    if (response.stage) return response.stage;
    if (response.status === 'succeeded') return 'completed';
    if (response.status === 'failed') return 'failed';
    return undefined;
}

export const isTerminalProgressStage = (stage: TranscribeProgressStage | undefined): boolean =>
    stage === 'completed' || stage === 'failed';

/** 一覧・詳細が描く「観測」。status 応答と文書投影のどちら由来かを持つ */
export interface ProgressObservation {
    stage: TranscribeProgressStage;
    /** その段階を観測したサーバ時刻（ms）。不明なら undefined（checking など） */
    observedAtMs?: number;
    /** 受付（ジョブ作成）時刻の近似（ms） */
    jobCreatedAtMs?: number;
    source: 'status' | 'projection';
}

export function observationFromProjection(
    progress: DocumentProcessingProgress | undefined | null,
): ProgressObservation | null {
    if (!progress) return null;
    return {
        stage: progress.stage,
        ...(progress.stageObservedAtMs !== undefined && { observedAtMs: progress.stageObservedAtMs }),
        ...(progress.jobCreatedAtMs !== undefined && { jobCreatedAtMs: progress.jobCreatedAtMs }),
        source: 'projection',
    };
}

export function observationFromStatus(
    response: TranscribeStatusResponse | null | undefined,
): ProgressObservation | null {
    if (!response) return null;
    const stage = stageFromStatusResponse(response);
    if (!stage) return null;
    return {
        stage,
        ...(response.azureStatusCheckedAtMs !== undefined && { observedAtMs: response.azureStatusCheckedAtMs }),
        ...(response.createdAtMs !== undefined && { jobCreatedAtMs: response.createdAtMs }),
        source: 'status',
    };
}

/**
 * API 応答と文書投影が前後して届いたときの採用規則（仕様 §A3）:
 * 終端を最優先し、非終端では観測時刻が新しい段階を採用する。時刻が無ければ生きている応答を優先する。
 */
export function resolveProgressObservation(
    projection: DocumentProcessingProgress | undefined | null,
    response: TranscribeStatusResponse | null | undefined,
): ProgressObservation | null {
    const fromStatus = observationFromStatus(response);
    const fromProjection = observationFromProjection(projection);
    if (!fromStatus) return fromProjection;
    if (!fromProjection) return fromStatus;
    if (isTerminalProgressStage(fromStatus.stage)) return fromStatus;
    if (isTerminalProgressStage(fromProjection.stage)) return fromProjection;
    if (fromStatus.observedAtMs === undefined || fromProjection.observedAtMs === undefined) return fromStatus;
    return fromProjection.observedAtMs > fromStatus.observedAtMs ? fromProjection : fromStatus;
}

/** 受付からの経過を分単位の日本語で。秒・パーセントは出さない（仕様 §A1） */
export function describeElapsed(elapsedMs: number): string {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) return '1分未満';
    const totalMinutes = Math.floor(elapsedMs / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes}分`;
    return minutes === 0 ? `${hours}時間` : `${hours}時間${minutes}分`;
}

export function formatClockTime(ms: number): string {
    return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .format(new Date(ms));
}

/**
 * 応答の serverNowMs を使い、端末時計のずれを抑えた「サーバ現在時刻の推定」を返す（仕様 §A1）。
 * serverNowMs が無い旧応答では受信時刻を基準にする。
 */
export function estimateServerNowMs(
    response: TranscribeStatusResponse | null | undefined,
    receivedAtMs: number | null | undefined,
    localNowMs: number,
): number {
    if (response?.serverNowMs !== undefined && receivedAtMs != null) {
        return response.serverNowMs + Math.max(0, localNowMs - receivedAtMs);
    }
    return localNowMs;
}

// ---------------------------------------------------------------------------------------------
// 選択中の処理中文書 1 件の継続確認（仕様 §A2 手順3〜5）。
// ---------------------------------------------------------------------------------------------

export type DocumentStatusWatchMode =
    /** リクエスト実行中 */
    | 'checking'
    /** 次の自動確認を待っている */
    | 'waiting'
    /** 画面が非表示なので自動確認を止めている（表示に戻ると即時 1 回確認） */
    | 'paused_hidden'
    /** オフラインなので自動確認を止めている（回線復帰で即時 1 回確認） */
    | 'paused_offline'
    /** 確認上限（90 分）に達して自動確認を停止。手動確認で再開できる */
    | 'stopped_limit'
    /** 401/403: 権限・認証の問題。自動確認を停止 */
    | 'stopped_auth'
    /** 404: 文書またはジョブを確認できない。自動確認を停止し、再提出しない */
    | 'stopped_not_found'
    /** 終端応答（succeeded/failed）を受け取った。以後の確認は不要 */
    | 'terminal'
    /** stop() 済み */
    | 'disposed';

export interface DocumentStatusWatchSnapshot {
    docId: string;
    mode: DocumentStatusWatchMode;
    /** 最後に受け取った有効な status 応答（終端含む）。通信失敗では更新しない */
    lastResponse: TranscribeStatusResponse | null;
    /** その応答をローカルで受信した時刻（ms）。Azure 観測時刻（azureStatusCheckedAtMs）とは別物 */
    lastResponseAtMs: number | null;
    /** 直近の確認失敗。成功で null に戻る */
    lastError: { message: string; httpStatus?: number } | null;
    consecutiveFailures: number;
    /** 自動確認の起点（上限判定用） */
    startedAtMs: number;
}

/** 可視性・回線・時計・タイマーの差し替え口（テストと、document の無い環境のため） */
export interface DocumentStatusWatchEnvironment {
    isVisible?: () => boolean;
    isOnline?: () => boolean;
    /** 可視性・回線の変化を購読し、解除関数を返す */
    subscribe?: (onChange: () => void) => () => void;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

export interface DocumentStatusWatchOptions {
    intervalMs?: number;
    retryIntervalsMs?: readonly number[];
    maxDurationMs?: number;
    /** 状態が変わるたびに最新のスナップショットを渡す（stop() 後は呼ばない） */
    onChange?: (snapshot: DocumentStatusWatchSnapshot) => void;
    /** 終端応答を受け取ったとき 1 回。呼出元は最新文書を取り直す */
    onTerminal?: (response: TranscribeStatusResponse) => void;
    environment?: DocumentStatusWatchEnvironment;
}

export interface DocumentStatusWatch {
    /** 手動「状態を確認」。実行中なら同じリクエストを返し、重複送信しない */
    checkNow: () => Promise<TranscribeStatusResponse | null>;
    /** 選択変更・画面離脱・owner 変更で呼ぶ。タイマーと購読を解き、以後 onChange を呼ばない */
    stop: () => void;
    getSnapshot: () => DocumentStatusWatchSnapshot;
}

const defaultWatchEnvironment: Required<DocumentStatusWatchEnvironment> = {
    isVisible: () => typeof document === 'undefined' || !document.hidden,
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    subscribe: (onChange) => {
        if (typeof document === 'undefined' || typeof window === 'undefined') return () => undefined;
        document.addEventListener('visibilitychange', onChange);
        window.addEventListener('online', onChange);
        window.addEventListener('offline', onChange);
        return () => {
            document.removeEventListener('visibilitychange', onChange);
            window.removeEventListener('online', onChange);
            window.removeEventListener('offline', onChange);
        };
    },
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const describeStatusFailure = (error: unknown): string => {
    if (error instanceof TranscribeStatusError) return error.message;
    if (error instanceof TypeError) return '通信に失敗しました。';
    if (error instanceof Error && error.message) return error.message;
    return '状態を確認できませんでした。';
};

/**
 * 選択中の processing 文書 1 件を、表示中・オンラインの間 15 秒間隔で確認し続ける。
 *
 * - リクエスト完了後に次のタイマーを設定し、同じジョブの呼び出しを積み重ねない。
 * - 手動確認も同じ経路。実行中は重複送信できない。
 * - HTTP 一時失敗は 30→60 秒へ延ばし、成功で基本間隔へ戻す。429 は Retry-After を尊重する。
 * - 401/403/404 は自動確認を止める。勝手に再提出しない（このモジュールは submit を持たない）。
 * - 非表示・オフラインで止め、復帰時に即時 1 回確認する。終端・90 分上限で止める。
 * 🔴 通信失敗は処理段階でもジョブ失敗でもない。lastResponse は成功時だけ更新し、鮮度と失敗を区別する。
 */
export function startDocumentStatusWatch(
    docId: string,
    options: DocumentStatusWatchOptions = {},
): DocumentStatusWatch {
    const {
        intervalMs = STATUS_POLL_INTERVAL_MS,
        retryIntervalsMs = STATUS_RETRY_INTERVALS_MS,
        maxDurationMs = STATUS_POLL_TIMEOUT_MS,
        onChange,
        onTerminal,
    } = options;
    const env: Required<DocumentStatusWatchEnvironment> = { ...defaultWatchEnvironment, ...options.environment };

    let snapshot: DocumentStatusWatchSnapshot = {
        docId,
        mode: 'waiting',
        lastResponse: null,
        lastResponseAtMs: null,
        lastError: null,
        consecutiveFailures: 0,
        startedAtMs: env.now(),
    };
    let timer: unknown = null;
    let inflight: Promise<TranscribeStatusResponse | null> | null = null;
    let disposed = false;
    const controller = new AbortController();

    const publish = (patch: Partial<DocumentStatusWatchSnapshot>): void => {
        snapshot = { ...snapshot, ...patch };
        if (!disposed) onChange?.(snapshot);
    };
    const clearTimer = (): void => {
        if (timer === null) return;
        env.clearTimer(timer);
        timer = null;
    };
    const pausedMode = (): 'paused_hidden' | 'paused_offline' | null =>
        !env.isVisible() ? 'paused_hidden' : !env.isOnline() ? 'paused_offline' : null;

    const schedule = (ms: number): void => {
        clearTimer();
        if (disposed) return;
        const paused = pausedMode();
        if (paused) {
            publish({ mode: paused });
            return;
        }
        publish({ mode: 'waiting' });
        timer = env.setTimer(() => {
            timer = null;
            void runCheck(false);
        }, ms);
    };

    const runCheck = (manual: boolean): Promise<TranscribeStatusResponse | null> => {
        if (disposed) return Promise.resolve(null);
        if (inflight) return inflight;
        if (snapshot.mode === 'terminal') return Promise.resolve(snapshot.lastResponse);
        clearTimer();
        // 上限で止まった後の手動確認は「同じジョブの確認を再開する」操作。上限の時計を仕切り直す。
        const startedAtMs = manual && snapshot.mode === 'stopped_limit' ? env.now() : snapshot.startedAtMs;
        publish({ mode: 'checking', startedAtMs });

        const request = fetchStatusShared({ docId }, docId, controller.signal)
            .then((response): TranscribeStatusResponse | null => {
                if (disposed) return null;
                const receivedAtMs = env.now();
                snapshot = {
                    ...snapshot,
                    lastResponse: response,
                    lastResponseAtMs: receivedAtMs,
                    lastError: null,
                    consecutiveFailures: 0,
                };
                if (response.status !== 'running') {
                    publish({ mode: 'terminal' });
                    onTerminal?.(response);
                    return response;
                }
                if (receivedAtMs - snapshot.startedAtMs > maxDurationMs) {
                    publish({ mode: 'stopped_limit' });
                    return response;
                }
                schedule(intervalMs);
                return response;
            }, (error: unknown): null => {
                if (disposed) return null;
                const consecutiveFailures = snapshot.consecutiveFailures + 1;
                const httpStatus = error instanceof TranscribeStatusError ? error.httpStatus : undefined;
                snapshot = {
                    ...snapshot,
                    consecutiveFailures,
                    lastError: {
                        message: describeStatusFailure(error),
                        ...(httpStatus !== undefined && { httpStatus }),
                    },
                };
                if (httpStatus === 401 || httpStatus === 403) {
                    publish({ mode: 'stopped_auth' });
                    return null;
                }
                if (httpStatus === 404) {
                    publish({ mode: 'stopped_not_found' });
                    return null;
                }
                const retryAfterMs = error instanceof TranscribeStatusError && httpStatus === 429
                    ? error.retryAfterMs
                    : undefined;
                const backoffMs = retryIntervalsMs[Math.min(consecutiveFailures, retryIntervalsMs.length) - 1]
                    ?? intervalMs;
                schedule(retryAfterMs ?? backoffMs);
                return null;
            })
            .finally(() => {
                if (inflight === request) inflight = null;
            });
        inflight = request;
        return request;
    };

    const handleEnvironmentChange = (): void => {
        if (disposed) return;
        const paused = pausedMode();
        if (paused) {
            clearTimer();
            if (snapshot.mode === 'waiting' || snapshot.mode === 'checking') publish({ mode: paused });
            return;
        }
        // 表示・回線の復帰: 対象は呼出元が再検証済み（選択が変われば stop される）。即時に 1 回確認する。
        if (snapshot.mode === 'paused_hidden' || snapshot.mode === 'paused_offline') void runCheck(false);
    };
    const unsubscribe = env.subscribe(handleEnvironmentChange);

    const pausedAtStart = pausedMode();
    if (pausedAtStart) publish({ mode: pausedAtStart });
    else void runCheck(false);

    return {
        checkNow: () => runCheck(true),
        stop: () => {
            if (disposed) return;
            disposed = true;
            clearTimer();
            unsubscribe();
            controller.abort(new Error('状態確認を停止しました'));
            snapshot = { ...snapshot, mode: 'disposed' };
        },
        getSnapshot: () => snapshot,
    };
}
